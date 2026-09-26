import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveAgentConfig } from "../../agents/agent-scope-config.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import type { ModelRef } from "../../agents/model-ref-shared.js";
import { resolveModelRefFromString } from "../../agents/model-selection.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { FollowupRun } from "./queue.js";

function resolveAgentHeartbeatModelRaw(params: {
  cfg: FollowupRun["run"]["config"];
  agentId?: string;
}): string | undefined {
  const defaultModel = normalizeOptionalString(params.cfg.agents?.defaults?.heartbeat?.model);
  const agentId = normalizeLowercaseStringOrEmpty(params.agentId);
  const agentModel = agentId
    ? normalizeOptionalString(resolveAgentConfig(params.cfg, agentId)?.heartbeat?.model)
    : undefined;
  return agentModel ?? defaultModel;
}

function modelRefsEqual(left: ModelRef, right: ModelRef | undefined): boolean {
  const provider = normalizeLowercaseStringOrEmpty(left.provider);
  const model = normalizeLowercaseStringOrEmpty(left.model);
  return Boolean(
    provider &&
    model &&
    provider === normalizeLowercaseStringOrEmpty(right?.provider) &&
    model === normalizeLowercaseStringOrEmpty(right?.model),
  );
}

function formatContextWindowLabel(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Math.round((tokens / 1_000_000) * 10) / 10}M`;
  }
  return `${Math.round(tokens / 1024)}k`;
}

function resolveContextWindowForHint(params: {
  cfg: FollowupRun["run"]["config"];
  ref: ModelRef;
  activeSessionEntry?: SessionEntry;
}) {
  const sessionContextTokens = asPositiveFiniteNumber(params.activeSessionEntry?.contextTokens);
  const modelContextTokens = resolveContextTokensForModel({
    cfg: params.cfg,
    provider: params.ref.provider,
    model: params.ref.model,
    allowAsyncLoad: false,
  });
  return (
    modelContextTokens ??
    (sessionContextTokens === undefined ? undefined : Math.floor(sessionContextTokens))
  );
}

function resolveHeartbeatBleedHint(params: {
  cfg: FollowupRun["run"]["config"];
  agentId?: string;
  primaryProvider?: string;
  primaryModel?: string;
  activeSessionEntry?: SessionEntry;
}): string | undefined {
  const primaryProvider = normalizeOptionalString(params.primaryProvider);
  const primaryModel = normalizeOptionalString(params.primaryModel);
  const runtimeProvider = normalizeOptionalString(params.activeSessionEntry?.modelProvider);
  const runtimeModel = normalizeOptionalString(params.activeSessionEntry?.model);
  if (!primaryProvider || !primaryModel || !runtimeProvider || !runtimeModel) {
    return undefined;
  }

  const primaryRef = { provider: primaryProvider, model: primaryModel };
  const runtimeRef = { provider: runtimeProvider, model: runtimeModel };
  if (modelRefsEqual(primaryRef, runtimeRef)) {
    return undefined;
  }
  const heartbeatModelRaw = resolveAgentHeartbeatModelRaw({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const heartbeatRef = heartbeatModelRaw
    ? resolveModelRefFromString({
        cfg: params.cfg,
        raw: heartbeatModelRaw,
        defaultProvider: primaryProvider,
      })?.ref
    : undefined;
  if (!modelRefsEqual(runtimeRef, heartbeatRef)) {
    return undefined;
  }

  const runtimeWindow = resolveContextWindowForHint({
    cfg: params.cfg,
    ref: runtimeRef,
    activeSessionEntry: params.activeSessionEntry,
  });
  const primaryWindow = resolveContextWindowForHint({
    cfg: params.cfg,
    ref: primaryRef,
  });
  if (
    typeof runtimeWindow === "number" &&
    typeof primaryWindow === "number" &&
    runtimeWindow >= primaryWindow
  ) {
    return undefined;
  }

  const runtimeLabel =
    typeof runtimeWindow === "number" && runtimeWindow > 0
      ? ` (${formatContextWindowLabel(runtimeWindow)} context)`
      : "";
  return (
    `\n\nThe previous heartbeat turn left this session on ${runtimeProvider}/${runtimeModel}` +
    `${runtimeLabel} instead of ${primaryProvider}/${primaryModel}. This matches the configured ` +
    "`heartbeat.model`, so the overflow is likely heartbeat model bleed rather than a " +
    "compaction-buffer problem. Set `heartbeat.isolatedSession: true`, enable " +
    "`heartbeat.lightContext: true`, or use a heartbeat model with a larger context window."
  );
}

/** Builds recovery instructions for context-overflow failures. */
export function buildContextOverflowRecoveryText(params: {
  cfg: FollowupRun["run"]["config"];
  agentId?: string;
  primaryProvider?: string;
  primaryModel?: string;
  runtimeProvider?: string;
  runtimeModel?: string;
  activeSessionEntry?: SessionEntry;
}): string {
  const prefix =
    "⚠️ Auto-compaction could not recover this turn. I kept this conversation mapped to the current session. Please try again, use /compact, or use /new to start a fresh session.";
  const explicitRuntimeMatchesSession =
    !params.runtimeProvider ||
    !params.runtimeModel ||
    (params.runtimeProvider === params.activeSessionEntry?.modelProvider &&
      params.runtimeModel === params.activeSessionEntry?.model);
  const heartbeatBleedHint = explicitRuntimeMatchesSession
    ? resolveHeartbeatBleedHint({
        cfg: params.cfg,
        agentId: params.agentId,
        primaryProvider: params.primaryProvider,
        primaryModel: params.primaryModel,
        activeSessionEntry: params.activeSessionEntry,
      })
    : undefined;
  return (
    prefix +
    (heartbeatBleedHint ??
      "\n\nTry starting a fresh session or using a model with a larger context window.")
  );
}
