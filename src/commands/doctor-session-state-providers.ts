import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
/** Doctor repair for stale plugin-owned routing state persisted in session entries. */
import { normalizeOptionalString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntriesLower } from "@openclaw/normalization-core/string-normalization";
import {
  resolveAgentModelFallbacksOverride,
  tryResolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { resolveAgentHarnessPolicy } from "../agents/harness/policy.js";
import {
  modelKey,
  normalizeProviderId,
  parseModelRef,
  resolveDefaultModelForAgent,
} from "../agents/model-selection.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import type { SessionEntry } from "../config/sessions.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { updateLegacySessionStore } from "../infra/state-migrations.legacy-session-store.js";
import { listPluginDoctorSessionRouteStateOwners } from "../plugins/doctor-contract-registry.js";
import type { DoctorSessionRouteStateOwner } from "../plugins/doctor-session-route-state-owner-types.js";
import { isValidAgentHarnessSessionStoreEntry } from "../sessions/agent-harness-session-key.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import { countLabel } from "./doctor-state-integrity-format.js";

function normalizeIdSet(values: readonly string[] | undefined): Set<string> {
  return new Set((values ?? []).map((value) => normalizeProviderId(value)));
}

function ownsPrefixedValue(prefixes: readonly string[], value: unknown): boolean {
  const normalized = normalizeString(value)?.toLowerCase();
  return normalized !== undefined && prefixes.some((prefix) => normalized.startsWith(prefix));
}

function repairExample(repair: DoctorSessionRouteStateRepair): string {
  return `${repair.key} (${repair.reasons.join(", ")})`;
}

function resolveSessionAgentId(
  cfg: OpenClawConfig,
  sessionKey: string,
  storeAgentId?: string,
): string | undefined {
  return parseAgentSessionKey(sessionKey)?.agentId ?? storeAgentId ?? tryResolveDefaultAgentId(cfg);
}

/** Resolves the currently configured provider/model/runtime route for a session key. */
function resolveConfiguredDoctorSessionStateRoute(params: {
  agentId: string;
  cfg: OpenClawConfig;
  sessionKey: string;
}) {
  const { agentId } = params;
  const primary = resolveDefaultModelForAgent({ cfg: params.cfg, agentId });
  const configuredModelRefs = new Set([modelKey(primary.provider, primary.model)]);
  const fallbacks =
    resolveAgentModelFallbacksOverride(params.cfg, agentId) ??
    resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
  for (const fallback of fallbacks) {
    const parsed = parseModelRef(fallback, primary.provider, {
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    });
    if (parsed) {
      configuredModelRefs.add(modelKey(parsed.provider, parsed.model));
    }
  }
  const runtime = resolveAgentHarnessPolicy({
    provider: primary.provider,
    modelId: primary.model,
    config: params.cfg,
    agentId,
    sessionKey: params.sessionKey,
  }).runtime;
  return {
    defaultProvider: primary.provider,
    configuredModelRefs: [...configuredModelRefs],
    runtime,
  };
}

function entryMayContainPluginSessionRouteState(
  sessionKey: string,
  entry: SessionEntry,
): entry is SessionEntry & Record<string, unknown> {
  if (isValidAgentHarnessSessionStoreEntry(sessionKey, entry)) {
    return false;
  }
  if (!isRecord(entry)) {
    return false;
  }
  const record = entry;
  return (
    normalizeString(record.providerOverride) !== undefined ||
    normalizeString(record.modelOverride) !== undefined ||
    normalizeString(record.modelOverrideSource) !== undefined ||
    record.liveModelSwitchPending !== undefined ||
    normalizeString(record.modelProvider) !== undefined ||
    normalizeString(record.model) !== undefined ||
    normalizeString(record.agentHarnessId) !== undefined ||
    normalizeString(record.agentRuntimeOverride) !== undefined ||
    record.cliSessionBindings !== undefined ||
    record.cliSessionIds !== undefined ||
    normalizeString(record.claudeCliSessionId) !== undefined ||
    normalizeString(record.authProfileOverride) !== undefined ||
    normalizeString(record.authProfileOverrideSource) !== undefined
  );
}

type DoctorSessionRouteState = ReturnType<typeof resolveConfiguredDoctorSessionStateRoute>;

type DoctorSessionRouteStateRepair = {
  key: string;
  ownerLabel: string;
  reasons: string[];
  pinnedRuntimeKeys: string[];
  cliSessionKeys: string[];
};

type DoctorSessionRouteStateManualReview = {
  ownerLabel: string;
  message: string;
};

type DoctorSessionRouteStateScan = ReturnType<
  ReturnType<typeof createPluginSessionStateDoctorScanner>["result"]
>;

function resolvePersistedOverrideModelRef(params: {
  defaultProvider: string;
  overrideProvider?: unknown;
  overrideModel?: unknown;
}): ReturnType<typeof parseModelRef> {
  const overrideModel = normalizeString(params.overrideModel);
  if (!overrideModel) {
    return null;
  }
  const overrideProvider = normalizeString(params.overrideProvider);
  return parseModelRef(
    overrideProvider ? `${overrideProvider}/${overrideModel}` : overrideModel,
    params.defaultProvider,
    { allowManifestNormalization: false, allowPluginNormalization: false },
  );
}

function addReason(reasons: string[], reason: string) {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function hasOwnedCliSession(params: {
  entry: Record<string, unknown>;
  cliSessionKeys: readonly string[];
}): boolean {
  const bindings = [params.entry.cliSessionBindings, params.entry.cliSessionIds].map(
    asOptionalObjectRecord,
  );
  return params.cliSessionKeys.some(
    (key) =>
      (key === "claude-cli" && normalizeString(params.entry.claudeCliSessionId) !== undefined) ||
      bindings.some((value) => value && key in value && value[key] !== undefined),
  );
}

function modelRefKey(provider: string, model: string): string {
  return modelKey(provider, model).toLowerCase();
}

function scanEntryForOwner(params: {
  key: string;
  entry: Record<string, unknown>;
  owner: DoctorSessionRouteStateOwner;
  route: DoctorSessionRouteState;
}): {
  repair?: DoctorSessionRouteStateRepair;
  manualReview?: DoctorSessionRouteStateManualReview;
} {
  const providerIds = normalizeIdSet(params.owner.providerIds);
  const runtimeIds = normalizeIdSet(params.owner.runtimeIds);
  const cliSessionKeys = [...normalizeIdSet(params.owner.cliSessionKeys)];
  const authProfilePrefixes = normalizeStringEntriesLower(params.owner.authProfilePrefixes);
  const routeAllowsOwnerRuntime = runtimeIds.has(normalizeProviderId(params.route.runtime));
  const routeAllowsOwner =
    routeAllowsOwnerRuntime ||
    params.route.configuredModelRefs.some((ref) => {
      const slash = ref.indexOf("/");
      return slash > 0 && providerIds.has(normalizeProviderId(ref.slice(0, slash)));
    });
  const reasons: string[] = [];
  const pinnedRuntimeKeys: string[] = [];
  const directOverride = resolvePersistedOverrideModelRef({
    defaultProvider: params.route.defaultProvider,
    overrideProvider: params.entry.providerOverride,
    overrideModel: params.entry.modelOverride,
  });
  const directOverrideKey = directOverride
    ? modelRefKey(directOverride.provider, directOverride.model)
    : undefined;
  const directOverrideIsOwned =
    directOverride !== null && providerIds.has(normalizeProviderId(directOverride.provider));
  const directOverrideIsConfigured =
    directOverrideKey !== undefined &&
    params.route.configuredModelRefs.some((ref) => ref.toLowerCase() === directOverrideKey);
  const directOverrideSource =
    params.entry.modelOverrideSource === "user"
      ? "user"
      : params.entry.modelOverrideSource === "auto"
        ? "auto"
        : params.entry.modelOverride
          ? "legacy"
          : undefined;

  if (directOverrideIsOwned && !directOverrideIsConfigured) {
    if (directOverrideSource === "auto") {
      addReason(reasons, "auto model override");
    } else if (!routeAllowsOwner) {
      return {
        manualReview: {
          ownerLabel: params.owner.label,
          message: `${params.key} (${modelRefKey(directOverride.provider, directOverride.model)}, ${
            directOverrideSource === "user" ? "user" : "legacy"
          })`,
        },
      };
    }
  }

  const explicitOwnedOverride =
    directOverrideIsOwned && directOverrideSource !== undefined && directOverrideSource !== "auto";
  if (!routeAllowsOwnerRuntime && !explicitOwnedOverride) {
    for (const key of ["agentHarnessId", "agentRuntimeOverride"]) {
      const runtime = normalizeString(params.entry[key]);
      if (runtime && runtimeIds.has(normalizeProviderId(runtime))) {
        addReason(reasons, "pinned runtime");
        pinnedRuntimeKeys.push(key);
      }
    }
  }
  if (!routeAllowsOwner && !explicitOwnedOverride) {
    const runtimeRef = resolvePersistedOverrideModelRef({
      defaultProvider: "",
      overrideProvider: params.entry.modelProvider,
      overrideModel: params.entry.model,
    });
    if (runtimeRef && providerIds.has(normalizeProviderId(runtimeRef.provider))) {
      addReason(reasons, "runtime model state");
    }
    if (hasOwnedCliSession({ entry: params.entry, cliSessionKeys })) {
      addReason(reasons, "CLI session binding");
    }
    if (
      params.entry.authProfileOverrideSource === "auto" &&
      ownsPrefixedValue(authProfilePrefixes, params.entry.authProfileOverride)
    ) {
      addReason(reasons, "auto auth profile override");
    }
  }

  if (reasons.length === 0) {
    return {};
  }
  return {
    repair: {
      key: params.key,
      ownerLabel: params.owner.label,
      reasons,
      pinnedRuntimeKeys,
      cliSessionKeys,
    },
  };
}

/** Streams session entries into compact plugin-owned route-state findings. */
export function createPluginSessionStateDoctorScanner(params: {
  agentId?: string;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}) {
  const repairs: DoctorSessionRouteStateRepair[] = [];
  const manualReview: DoctorSessionRouteStateManualReview[] = [];
  let owners: DoctorSessionRouteStateOwner[] | undefined;
  const routeByAgentId = new Map<string, DoctorSessionRouteState>();
  return {
    scanEntry(key: string, entry: SessionEntry) {
      if (!entryMayContainPluginSessionRouteState(key, entry)) {
        return;
      }
      owners ??= listPluginDoctorSessionRouteStateOwners({ config: params.cfg, env: params.env });
      if (owners.length === 0) {
        return;
      }
      const agentId = resolveSessionAgentId(params.cfg, key, params.agentId);
      if (!agentId) {
        return;
      }
      let route = routeByAgentId.get(agentId);
      if (!route) {
        route = resolveConfiguredDoctorSessionStateRoute({
          agentId,
          cfg: params.cfg,
          sessionKey: key,
        });
        routeByAgentId.set(agentId, route);
      }
      for (const owner of owners) {
        const scan = scanEntryForOwner({ key, entry, owner, route });
        if (scan.repair) {
          repairs.push(scan.repair);
        }
        if (scan.manualReview) {
          manualReview.push(scan.manualReview);
        }
      }
    },
    result() {
      return { repairs, manualReview };
    },
  };
}

function clearRecordKeys(
  entry: Record<string, unknown>,
  recordKey: string,
  ownedKeys: readonly string[],
): boolean {
  const value = asOptionalObjectRecord(entry[recordKey]);
  if (!value) {
    return false;
  }
  let changed = false;
  const next = { ...value };
  for (const key of ownedKeys) {
    if (next[key] !== undefined) {
      delete next[key];
      changed = true;
    }
  }
  if (!changed) {
    return false;
  }
  entry[recordKey] = Object.keys(next).length > 0 ? next : undefined;
  return true;
}

/** Clears stale plugin-owned routing fields from a session entry and refreshes updatedAt. */
function applySessionRouteStateRepair(params: {
  sessionKey: string;
  entry: Record<string, unknown>;
  repair: DoctorSessionRouteStateRepair;
  now: number;
}): boolean {
  // Revalidate at mutation time: the harness may have claimed and locked this row after the scan.
  if (isValidAgentHarnessSessionStoreEntry(params.sessionKey, params.entry)) {
    return false;
  }
  let changed = false;
  const clear = (key: string) => {
    if (params.entry[key] !== undefined) {
      delete params.entry[key];
      changed = true;
    }
  };
  if (params.repair.reasons.includes("auto model override")) {
    clear("providerOverride");
    clear("modelOverride");
    clear("modelOverrideSource");
    clear("modelOverrideFallbackOriginProvider");
    clear("modelOverrideFallbackOriginModel");
    clear("modelOverrideRouteResolution");
    clear("liveModelSwitchPending");
  }
  if (params.repair.reasons.includes("runtime model state")) {
    clear("model");
    clear("modelProvider");
    clear("contextTokens");
    clear("systemPromptReport");
    clear("fallbackNotice");
  }
  if (params.repair.reasons.includes("pinned runtime")) {
    for (const key of params.repair.pinnedRuntimeKeys) {
      clear(key);
    }
  }
  if (params.repair.reasons.includes("CLI session binding")) {
    changed =
      clearRecordKeys(params.entry, "cliSessionBindings", params.repair.cliSessionKeys) || changed;
    changed =
      clearRecordKeys(params.entry, "cliSessionIds", params.repair.cliSessionKeys) || changed;
    if (params.repair.cliSessionKeys.includes("claude-cli")) {
      // Doctor's later binding migration must not restore a conversation this repair cleared.
      clear("claudeCliSessionId");
    }
  }
  if (params.repair.reasons.includes("auto auth profile override")) {
    clear("authProfileOverride");
    clear("authProfileOverrideSource");
    clear("authProfileOverrideCompactionCount");
  }
  if (changed) {
    params.entry.updatedAt = params.now;
  }
  return changed;
}

function groupByOwnerLabel<T extends { ownerLabel: string }>(
  items: readonly T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const group = grouped.get(item.ownerLabel) ?? [];
    group.push(item);
    grouped.set(item.ownerLabel, group);
  }
  return grouped;
}

type DoctorSessionStateStore =
  | { kind: "legacy"; path: string }
  | { kind: "sqlite"; agentId: string; path: string };

/** Prompts for and applies plugin-owned session route state repairs to the session store. */
export async function runPluginSessionStateDoctorRepairs(params: {
  scan: DoctorSessionRouteStateScan;
  store: DoctorSessionStateStore;
  prompter: Pick<DoctorPrompter, "confirmRuntimeRepair">;
  warnings: string[];
  changes: string[];
}): Promise<void> {
  const { scan } = params;
  for (const [ownerLabel, repairs] of groupByOwnerLabel(scan.repairs)) {
    const staleCount = countLabel(repairs.length, "session");
    params.warnings.push(
      [
        `- Found stale ${ownerLabel} session routing state in ${staleCount} outside the current configured model/runtime route.`,
        "  This can keep later message-channel runs pinned to an old runtime/provider after defaults move elsewhere.",
        `  Examples: ${repairs.slice(0, 3).map(repairExample).join(", ")}`,
      ].join("\n"),
    );
    const repairState = await params.prompter.confirmRuntimeRepair({
      message: `Clear stale ${ownerLabel} session routing state for ${staleCount}?`,
      initialValue: true,
    });
    if (repairState) {
      let repaired = 0;
      const repairedAt = Date.now();
      const repairsByKey = new Map(repairs.map((repair) => [repair.key, repair]));
      const repairEntry = (sessionKey: string, entry: unknown) => {
        const repair = repairsByKey.get(sessionKey);
        return (
          repair &&
          isRecord(entry) &&
          applySessionRouteStateRepair({ sessionKey, entry, repair, now: repairedAt })
        );
      };
      if (params.store.kind === "sqlite") {
        repaired = await applySessionEntryReplacements<number>({
          agentId: params.store.agentId,
          sessionKeys: [...repairsByKey.keys()],
          storePath: params.store.path,
          update: (currentEntries) => {
            const replacements = currentEntries.filter(({ entry, sessionKey }) =>
              repairEntry(sessionKey, entry),
            );
            return { replacements, result: replacements.length };
          },
        });
      } else {
        await updateLegacySessionStore(params.store.path, (currentStore) => {
          for (const key of repairsByKey.keys()) {
            if (repairEntry(key, currentStore[key])) {
              repaired += 1;
            }
          }
        });
      }
      if (repaired > 0) {
        params.changes.push(
          `- Cleared stale ${ownerLabel} session routing state for ${countLabel(
            repaired,
            "session",
          )}.`,
        );
      }
    }
  }
  for (const [ownerLabel, hits] of groupByOwnerLabel(scan.manualReview)) {
    params.warnings.push(
      [
        `- Found explicit ${ownerLabel} model overrides in ${countLabel(
          hits.length,
          "session",
        )} outside the current configured route.`,
        "  Doctor leaves explicit or legacy user selections untouched; switch them with /model or reset the session if that provider is no longer intended.",
        `  Examples: ${hits
          .slice(0, 3)
          .map((hit) => hit.message)
          .join(", ")}`,
      ].join("\n"),
    );
  }
}
