import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ModelRef } from "../../agents/model-ref-shared.js";
import { hasBillableUsage, hasNonzeroUsage, type NormalizedUsage } from "../../agents/usage.js";
import { getRuntimeConfig } from "../../config/config.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { applySessionEntryOperation } from "../../config/sessions/session-accessor.sqlite-entry.js";
import {
  projectSessionEntryUsageUpdate,
  type SessionEntryUsageUpdate,
} from "../../config/sessions/session-entry-usage.js";
import type {
  InternalSessionEntry,
  SessionEntry,
  SessionSystemPromptReport,
} from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { estimateAggregateUsageCost } from "../../utils/usage-format.js";

function resolveNonNegativeTokenCount(value: number | undefined): number | undefined {
  const resolved = asNonNegativeFiniteNumber(value);
  return resolved === undefined ? undefined : Math.floor(resolved);
}

export async function persistSessionUsageUpdate(params: {
  agentId?: string;
  storePath?: string;
  sessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
  expectedSession?: Pick<
    InternalSessionEntry,
    "sessionId" | "lifecycleRevision" | "activeWriterRunId"
  >;
  authorize?: () => boolean;
  cfg?: OpenClawConfig;
  agentDir?: string;
  usage?: NormalizedUsage;
  /**
   * Usage from the last individual API call (not accumulated). Supplies context
   * only when no chronology-qualified currentContextSnapshot was observed.
   */
  lastCallUsage?: NormalizedUsage;
  modelUsed?: string;
  providerUsed?: string;
  /** Session selection can differ from the response model used for billing. */
  runtimeModelSelection?: ModelRef;
  agentHarnessId?: string;
  contextTokensUsed?: number;
  contextTokensSource?: SessionEntry["contextTokensSource"];
  contextBudgetStatus?: SessionEntry["contextBudgetStatus"];
  promptTokens?: number;
  isHeartbeat?: boolean;
  systemPromptReport?: SessionSystemPromptReport;
  /** Presence overrides usage inference; undefined tokens explicitly mean current context is unknown. */
  currentContextSnapshot?: { tokens: number | undefined };
  preserveFreshTotalTokensOnStaleUsage?: boolean;
  preserveRuntimeModel?: boolean;
  preserveUserFacingSessionModelState?: boolean;
}): Promise<
  | {
      storePath: string;
      sessionKey: string;
      entry: Pick<
        InternalSessionEntry,
        "sessionId" | "lifecycleRevision" | "liveModelSwitchPending"
      >;
    }
  | undefined
> {
  const { agentId, storePath, sessionKey, sessionStore, authorize } = params;
  if (!storePath || !sessionKey) {
    return undefined;
  }
  const expectedSession = params.expectedSession
    ? { ...params.expectedSession, lifecycleRevision: params.expectedSession.lifecycleRevision }
    : undefined;

  const cfg = params.cfg ?? getRuntimeConfig();
  const modelSelection = params.runtimeModelSelection ?? {
    provider: params.providerUsed,
    model: params.modelUsed,
  };
  const hasUsage = hasNonzeroUsage(params.usage);
  const hasBilling = hasBillableUsage(params.usage);
  const hasPromptTokens =
    typeof params.promptTokens === "number" &&
    Number.isFinite(params.promptTokens) &&
    params.promptTokens > 0;
  const hasUsableLastCallUsage =
    Boolean(params.lastCallUsage) && params.lastCallUsage?.contextUsage?.state !== "unavailable";
  const hasFreshContextSnapshot = hasUsableLastCallUsage || hasPromptTokens;
  const hasCurrentContextSnapshot = params.currentContextSnapshot !== undefined;

  // A monetary-only update must not invalidate the existing context observation.
  const hasContextUpdate =
    hasUsage ||
    hasFreshContextSnapshot ||
    hasCurrentContextSnapshot ||
    Boolean(modelSelection.model || params.contextTokensUsed);
  if (!hasBilling && !hasContextUpdate) {
    return undefined;
  }
  const preserveUserFacingRunState = params.preserveUserFacingSessionModelState === true;
  const update: SessionEntryUsageUpdate = {
    usage: params.usage,
    lastCallUsage: params.lastCallUsage,
    modelSelection,
    agentHarnessId: normalizeOptionalString(params.agentHarnessId),
    contextTokensUsed: params.contextTokensUsed,
    contextTokensSource: params.contextTokensSource,
    contextBudgetStatus: params.contextBudgetStatus,
    systemPromptReport: params.systemPromptReport,
    promptTokens: params.promptTokens,
    currentContextTokens: resolveNonNegativeTokenCount(params.currentContextSnapshot?.tokens),
    hasUsage,
    hasBilling,
    hasContextUpdate,
    hasFreshContextSnapshot,
    hasCurrentContextSnapshot,
    preserveSessionModelState:
      params.isHeartbeat === true ||
      params.preserveRuntimeModel === true ||
      preserveUserFacingRunState,
    preserveUserFacingRunState,
    preserveFreshTotalTokensOnStaleUsage: params.preserveFreshTotalTokensOnStaleUsage,
  };
  const estimateCost = (entry?: SessionEntry) =>
    preserveUserFacingRunState || !hasBilling
      ? undefined
      : asNonNegativeFiniteNumber(
          estimateAggregateUsageCost({
            config: cfg,
            agentDir: params.agentDir,
            usage: params.usage,
            provider: params.providerUsed ?? entry?.modelProvider,
            model: params.modelUsed ?? entry?.model,
          }),
        );
  let committedEntry:
    | Pick<InternalSessionEntry, "sessionId" | "lifecycleRevision" | "liveModelSwitchPending">
    | undefined;
  const options = {
    skipMaintenance: true,
    onCommitted: (entry: InternalSessionEntry) => {
      // Copy the commit's facts before publishing the mutable caller cache.
      committedEntry = {
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
        liveModelSwitchPending: entry.liveModelSwitchPending,
      };
      if (sessionStore) {
        sessionStore[sessionKey] = entry;
      }
    },
    workerGuard: {
      assertCurrent: authorize
        ? () => {
            if (!authorize()) {
              throw new Error("session usage accounting authority revoked");
            }
          }
        : undefined,
    },
  };
  try {
    if (
      !hasBilling ||
      preserveUserFacingRunState ||
      (params.providerUsed !== undefined && params.modelUsed !== undefined)
    ) {
      options.workerGuard.assertCurrent?.();
      update.estimatedCostUsd = estimateCost();
      await applySessionEntryOperation(
        { agentId, storePath, sessionKey },
        { kind: "usage-accounting", usage: update, expected: expectedSession },
        options,
      );
    } else {
      // Pricing without a complete producing model depends on the prepared row and host catalog.
      await patchSessionEntryCore(
        { agentId, storePath, sessionKey },
        (entry) => {
          if (
            !(authorize?.() ?? true) ||
            (expectedSession &&
              (entry.sessionId !== expectedSession.sessionId ||
                entry.lifecycleRevision !== expectedSession.lifecycleRevision ||
                (Object.hasOwn(expectedSession, "activeWriterRunId") &&
                  entry.activeWriterRunId !== expectedSession.activeWriterRunId)))
          ) {
            return null;
          }
          const updatedAt = Date.now();
          return projectSessionEntryUsageUpdate(
            entry,
            { ...update, estimatedCostUsd: estimateCost(entry) },
            updatedAt,
          );
        },
        options,
      );
    }
    return committedEntry ? { storePath, sessionKey, entry: committedEntry } : undefined;
  } catch (err) {
    logVerbose(`failed to persist usage update: ${String(err)}`);
    return undefined;
  }
}
