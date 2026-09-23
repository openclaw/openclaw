import { expectDefined } from "@openclaw/normalization-core";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveSessionModelIdentityRef } from "../agents/session-model-ref.js";
import { buildGroupDisplayName, type SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatAgentRuntimeLabel } from "../shared/agent-runtime-display.js";
import { formatGoalSummary } from "../shared/session-goal-display.js";
import { isSessionRunActive } from "../shared/session-run-state.js";
import { sessionDeliveryChannel, sessionDeliveryOrigin } from "../utils/delivery-context.read.js";
import { resolveAssistantIdentity } from "./assistant-identity.js";
import { readPreparedGatewayModelCatalogMetadata } from "./server-model-catalog-view.js";
import type { SessionListTargetLookup } from "./session-list-target.js";
import type {
  SessionListActiveRunProjector,
  SessionListRowContext,
  SessionListRowContextProvider,
} from "./session-utils-contracts.js";
import {
  resolveGatewaySessionDisplayName,
  resolveGatewaySessionKind,
  projectGatewaySessionRunState,
  projectGatewaySessionActiveRun,
  resolveGatewaySessionGoal,
} from "./session-utils-display.js";
import { isGroupOrChannelDisplaySession, parseGroupKey } from "./session-utils-store.js";
import type { SessionListModelCatalog } from "./session-utils.types.js";

function resolveSessionListSearchDisplayName(
  key: string,
  entry?: SessionEntry,
): string | undefined {
  if (entry?.displayName) {
    return entry.displayName;
  }
  const parsed = parseGroupKey(key);
  const channel = sessionDeliveryChannel(entry) ?? parsed?.channel;
  if (isGroupOrChannelDisplaySession(entry, parsed) && channel) {
    return buildGroupDisplayName({
      provider: channel,
      subject: entry?.subject,
      groupChannel: entry?.groupChannel,
      space: entry?.space,
      id: parsed?.id,
      key,
    });
  }
  return entry?.label ?? sessionDeliveryOrigin(entry)?.label;
}

function addSessionListSearchModelFields(
  fields: Array<string | undefined>,
  identity: { provider?: string; model?: string },
) {
  const provider = normalizeOptionalString(identity.provider);
  const model = normalizeOptionalString(identity.model);
  fields.push(provider, model);
  if (provider && model) {
    fields.push(`${provider}/${model}`);
  }
}

function matchesSessionListSearch(fields: Array<string | undefined>, search: string): boolean {
  return fields.some(
    (field) => typeof field === "string" && normalizeLowercaseStringOrEmpty(field).includes(search),
  );
}

function shouldResolveDerivedSessionModelSearchFields(search: string): boolean {
  // Preserve key-query semantics: derived model aliases are not agent-key matches.
  return !search.startsWith("agent:");
}

// Selection facts are replaced with the resident entry; weak keys release retired revisions.
const staticSearchFields = new WeakMap<
  NonNullable<ReturnType<SessionListTargetLookup>>["selection"],
  string[]
>();

export function createSessionListSearchMatcher(params: {
  cfg: OpenClawConfig;
  search: string;
  getTarget: SessionListTargetLookup;
  modelCatalog?: SessionListModelCatalog;
  now: number;
  getRowContext: SessionListRowContextProvider;
  projectActiveRun?: SessionListActiveRunProjector;
}) {
  const { cfg, search, now } = params;
  const identityNames = new Map<string, string>();
  let rowContext: SessionListRowContext | undefined;
  const context = () => (rowContext ??= params.getRowContext());
  return (key: string, entry: SessionEntry): boolean => {
    const target = expectDefined(params.getTarget(key), "search row owner");
    const storeKey = target.storeKey ?? key;
    let fields = staticSearchFields.get(target.selection);
    if (!fields) {
      const rawFields = [
        storeKey,
        entry.label,
        entry.subject,
        entry.sessionId,
        entry.category,
        resolveSessionListSearchDisplayName(storeKey, entry),
        resolveGatewaySessionDisplayName(storeKey, entry),
        resolveGatewaySessionKind(storeKey, entry),
      ];
      addSessionListSearchModelFields(rawFields, {
        provider: entry.modelProvider,
        model: entry.model,
      });
      fields = rawFields.map(normalizeLowercaseStringOrEmpty);
      staticSearchFields.set(target.selection, fields);
    }
    if (fields.some((field) => field.includes(search))) {
      return true;
    }
    const agentId = target.agentId;
    const metadataSnapshot = readPreparedGatewayModelCatalogMetadata(
      params.modelCatalog?.get(agentId),
    );
    const run = projectGatewaySessionRunState({
      key: storeKey,
      entry,
      now,
      rowContext: context(),
    }).fields;
    const active = params.projectActiveRun?.(key, entry, agentId);
    const state = projectGatewaySessionActiveRun(active, run.status);
    const goal = resolveGatewaySessionGoal(entry, now);
    if (
      matchesSessionListSearch(
        [
          state.status,
          isSessionRunActive(state)
            ? "live running"
            : state.hasActiveRun === false
              ? "idle"
              : undefined,
          goal
            ? `${goal.objective} ${goal.status} ${formatGoalSummary(goal)} ${goal.lastStatusNote ?? ""}`
            : undefined,
        ],
        search,
      )
    ) {
      return true;
    }
    if (!identityNames.has(agentId)) {
      identityNames.set(agentId, resolveAssistantIdentity({ cfg, agentId }).name);
    }
    if (matchesSessionListSearch([identityNames.get(agentId)], search)) {
      return true;
    }
    const source = expectDefined(
      target.materialized?.source ?? target.getModelFacts?.(),
      "prepared search row model facts",
    );
    if (shouldResolveDerivedSessionModelSearchFields(search)) {
      const subagentRun = context().subagentRuns.getDisplaySubagentRun(storeKey);
      const resolvedModel = resolveSessionModelIdentityRef(
        cfg,
        entry,
        agentId,
        subagentRun?.model,
        {
          allowPluginNormalization: false,
          manifestPlugins: metadataSnapshot,
        },
      );
      const models: Array<string | undefined> = [];
      for (const identity of [resolvedModel, source.selectedModel, source.rowModelIdentity]) {
        addSessionListSearchModelFields(models, identity);
      }
      if (matchesSessionListSearch(models, search)) {
        return true;
      }
    }
    return matchesSessionListSearch(
      [formatAgentRuntimeLabel(source.thinkingProjection.agentRuntime)],
      search,
    );
  };
}
