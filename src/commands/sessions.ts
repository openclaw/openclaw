import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type {
  ModelChoice,
  ModelRuntimeChoice,
  ModelsListResult,
} from "../../packages/gateway-protocol/src/schema/model-catalog.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { colorize, isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { readAcpSessionMetaForEntries } from "../acp/runtime/session-meta-readonly.js";
import { resolveCurrentSessionAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { findModelInCatalog } from "../agents/model-catalog-lookup.js";
import { selectModelCatalogRuntimeEntry } from "../agents/model-catalog-view.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import { resolveModelContextWindowProfile } from "../agents/model-context-window.js";
import {
  prepareCliProviderClassifier,
  type CliProviderClassifier,
} from "../agents/model-selection.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import { resolveRuntimePolicySessionKey } from "../auto-reply/reply/runtime-policy-session-key.js";
import { normalizeChatType } from "../channels/chat-type.js";
import { ExpectedCliError } from "../cli/failure-output.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveFreshSessionTotalTokens, resolveSessionTotalTokens } from "../config/sessions.js";
import { resolveProjectedSessionContextTokens } from "../config/sessions/context-token-provenance.js";
import { listSessionEntriesReadOnly } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveStoredSessionKeyForAgentStore } from "../gateway/session-store-key.js";
import { info } from "../globals.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { classifySessionKind, type SessionKind } from "../sessions/classify-session-kind.js";
import { isAcpSessionKey } from "../sessions/session-key-utils.js";
import { sortAndLimitBy } from "../shared/sort-and-limit.js";
import { resolveAgentRuntimeLabel } from "../status/agent-runtime-label.js";
import {
  deliveryContextFromSession,
  sessionDeliveryOrigin,
} from "../utils/delivery-context.read.js";
import { formatTokenCount } from "../utils/token-format.js";
import { resolveCommandSessionStoreTargets } from "./session-store-targets.js";
import { resolveSessionDisplayModelRef } from "./sessions-display-model.js";
import {
  formatSessionAgeCell,
  formatSessionFlagsCell,
  formatSessionKeyCell,
  formatSessionModelCell,
  toSessionDisplayRow,
} from "./sessions-table.js";

type SessionCandidate = { agentId: string; entry: SessionEntry; sessionKey: string };

const DEFAULT_SESSIONS_LIMIT = 100;

function toSessionCatalogEntry(
  model: ModelChoice,
  runtime: ModelChoice | ModelRuntimeChoice = model,
): ModelCatalogEntry {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    contextWindow: runtime.contextWindow,
    contextTokens: runtime.contextTokens,
    contextWindows: runtime.contextWindows,
    contextWindowDefault: runtime.contextWindowDefault,
    ...(runtime.agentRuntime && !["auto", "openclaw"].includes(runtime.agentRuntime.id)
      ? { nativeRuntime: runtime.agentRuntime.id }
      : {}),
  };
}

/** True ACP sessions use the child runtime's model, not the configured fallback. */
function applyAcpModelOverlayIfNeeded(
  modelRef: { provider: string; model: string },
  sessionKey: string,
  acpRuntime: boolean,
): { provider: string; model: string } {
  if (!acpRuntime || !isAcpSessionKey(sessionKey)) {
    return modelRef;
  }
  const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? "acp";
  return { provider: "acpx", model: `${agentId}-acp` };
}

function compareSessionRowsByUpdatedAt(a: SessionCandidate, b: SessionCandidate): number {
  return (b.entry.updatedAt ?? 0) - (a.entry.updatedAt ?? 0);
}

function parseSessionsLimit(value: string | number | undefined): number | undefined | null {
  if (value === undefined) {
    return DEFAULT_SESSIONS_LIMIT;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "all") {
      return undefined;
    }
    if (!/^\d+$/.test(trimmed)) {
      return null;
    }
    return parseStrictPositiveInteger(trimmed) ?? null;
  }
  return Number.isInteger(value) && value > 0 ? value : null;
}

const colorByPct = (label: string, pct: number | null, rich: boolean) => {
  if (!rich || pct === null) {
    return label;
  }
  if (pct >= 95) {
    return theme.error(label);
  }
  if (pct >= 80) {
    return theme.warn(label);
  }
  if (pct >= 60) {
    return theme.success(label);
  }
  return theme.muted(label);
};

// Matches `openclaw status` semantics: show the recorded total whenever one
// exists, and withhold only the percentage when freshness provenance is missing.
const formatTokensCell = (
  total: number | undefined,
  freshTotal: number | undefined,
  contextTokens: number | null,
  rich: boolean,
) => {
  const ctxLabel = contextTokens ? formatTokenCount(contextTokens) : "?";
  if (total === undefined) {
    const label = `unknown/${ctxLabel} (?%)`;
    return rich ? theme.muted(label) : label;
  }
  const pct =
    contextTokens && freshTotal !== undefined
      ? Math.min(999, Math.round((freshTotal / contextTokens) * 100))
      : null;
  const label = `${formatTokenCount(total)}/${ctxLabel} (${pct ?? "?"}%)`;
  return colorByPct(label, pct, rich);
};

const formatKindCell = (kind: SessionKind, rich: boolean) => {
  const colors = {
    group: theme.accentBright,
    global: theme.warn,
    direct: theme.accent,
    cron: theme.muted,
    "spawn-child": theme.muted,
    unknown: theme.muted,
  };
  return colorize(rich, colors[kind], kind);
};

function resolveSessionRuntimeLabel(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  agentRuntime: ReturnType<typeof resolveCurrentSessionAgentRuntimeMetadata>;
  modelProvider: string;
  classifyCliProvider: CliProviderClassifier;
}): string {
  const id = normalizeOptionalLowercaseString(params.agentRuntime.id);
  const resolvedHarness = id && id !== "openclaw" && id !== "auto" ? id : undefined;
  return resolveAgentRuntimeLabel({
    config: params.cfg,
    sessionEntry: params.entry,
    resolvedHarness,
    fallbackProvider: params.modelProvider,
    classifyCliProvider: params.classifyCliProvider,
  });
}

function resolveSessionStoreDisplayPath(target: { agentId: string; storePath: string }): string {
  return resolveSqliteTargetFromSessionStorePath(target.storePath, {
    agentId: target.agentId,
  }).path;
}

function stripChannelRecipientPrefix(
  value: string | undefined,
  channel: string | undefined,
): string | undefined {
  const raw = normalizeOptionalString(value);
  const normalizedChannel = normalizeOptionalLowercaseString(channel);
  if (!raw || !normalizedChannel) {
    return raw;
  }
  const prefix = `${normalizedChannel}:`;
  if (!raw.toLowerCase().startsWith(prefix)) {
    return raw;
  }
  const stripped = raw.slice(prefix.length);
  const topicMarkerIndex = stripped.toLowerCase().indexOf(":topic:");
  // Topic suffixes are routing detail, not the peer id used by runtime-policy
  // session-key display.
  return topicMarkerIndex >= 0 ? stripped.slice(0, topicMarkerIndex) : stripped;
}

function resolveDisplayRuntimePolicySessionKey(params: {
  agentId: string;
  cfg: OpenClawConfig;
  key: string;
  entry: SessionEntry;
}): string | undefined {
  const { cfg, entry, key } = params;
  const origin = sessionDeliveryOrigin(entry);
  const deliveryContext = deliveryContextFromSession(entry);
  const chatType = normalizeChatType(origin?.chatType ?? entry.chatType);
  if (chatType !== "direct") {
    return undefined;
  }

  const channel = normalizeOptionalString(
    origin?.provider ?? deliveryContext?.channel ?? origin?.surface,
  );
  const to = normalizeOptionalString(origin?.to ?? deliveryContext?.to);
  const from = normalizeOptionalString(origin?.from);
  const nativeDirectUserId = normalizeOptionalString(origin?.nativeDirectUserId);
  const peerId =
    nativeDirectUserId ??
    stripChannelRecipientPrefix(to, channel) ??
    stripChannelRecipientPrefix(from, channel);

  // Direct-message runtime policy can route by native user id, stripped
  // recipient, or sender; expose the derived key when it differs from the row.
  const runtimePolicySessionKey = resolveRuntimePolicySessionKey({
    agentId: params.agentId,
    cfg,
    sessionKey: key,
    ctx: {
      SessionKey: key,
      AgentId: params.agentId,
      Provider: channel,
      Surface: normalizeOptionalString(origin?.surface),
      AccountId: normalizeOptionalString(origin?.accountId ?? deliveryContext?.accountId),
      ChatType: chatType,
      NativeDirectUserId: nativeDirectUserId,
      SenderId: peerId,
      OriginatingTo: to,
      From: from,
      To: to,
    },
  });

  return runtimePolicySessionKey && runtimePolicySessionKey !== key
    ? runtimePolicySessionKey
    : undefined;
}

export async function sessionsCommand(
  opts: {
    json?: boolean;
    store?: string;
    active?: string;
    agent?: string;
    allAgents?: boolean;
    limit?: string | number;
  },
  runtime: RuntimeEnv,
) {
  const aggregateAgents = opts.allAgents === true;
  const cfg = getRuntimeConfig();
  const { resolveModelContextTokenProjection } = await import("../agents/context.js");
  const { loadPreparedModelCatalogSnapshot } = await import("../agents/prepared-model-catalog.js");
  const { callGateway, isImplicitLocalGatewayTarget } = await import("../gateway/call.js");
  const { readActiveGatewayLockIdentity } = await import("../infra/gateway-lock.js");
  const targets = resolveCommandSessionStoreTargets({ cfg, opts });

  let activeMinutes: number | undefined;
  if (opts.active !== undefined) {
    const parsed = parseStrictPositiveInteger(opts.active);
    if (parsed === undefined) {
      const message = "--active must be a positive number of minutes, for example --active 30.";
      throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
    }
    activeMinutes = parsed;
  }

  const limit = parseSessionsLimit(opts.limit);
  if (limit === null) {
    const message = '--limit must be a positive integer or "all", for example --limit 25.';
    throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
  }

  const classifyCliProvider = prepareCliProviderClassifier(cfg);
  const activeSince = activeMinutes === undefined ? undefined : Date.now() - activeMinutes * 60_000;
  const allEntries = targets.flatMap((target) => {
    return listSessionEntriesReadOnly({
      agentId: target.agentId,
      storePath: target.storePath,
      projection: "list",
    })
      .filter(
        ({ entry }) =>
          activeSince === undefined ||
          (typeof entry.updatedAt === "number" && entry.updatedAt >= activeSince),
      )
      .map(({ sessionKey, entry }) => ({ agentId: target.agentId, entry, sessionKey }));
  });
  const totalCount = allEntries.length;
  const sessionEntries = sortAndLimitBy(allEntries, limit, compareSessionRowsByUpdatedAt).map(
    ({ agentId: storeAgentId, entry, sessionKey }) => {
      const row = toSessionDisplayRow(sessionKey, entry);
      const agentId = parseAgentSessionKey(row.key)?.agentId ?? storeAgentId;
      const acpSessionKey = resolveStoredSessionKeyForAgentStore({
        cfg,
        agentId,
        sessionKey: row.key,
      });
      return { acpSessionKey, agentId, entry, row };
    },
  );
  const acpSessionMetadata = await readAcpSessionMetaForEntries({
    cfg,
    entries: sessionEntries.map(({ acpSessionKey, agentId, entry }) => ({
      sessionKey: acpSessionKey,
      agentId,
      entry,
    })),
  });
  const catalogs = new Map<string, Promise<ModelCatalogSnapshot | undefined>>();
  let catalogWarningShown = false;
  const warnCatalogUnavailable = () => {
    if (!catalogWarningShown) {
      catalogWarningShown = true;
      runtime.error(
        "Could not read the active Gateway model catalog; showing configured or last verified capacity. Retry when the Gateway is reachable.",
      );
    }
  };
  const gatewayOwner =
    opts.store === undefined &&
    sessionEntries.length > 0 &&
    (await isImplicitLocalGatewayTarget({ config: cfg }))
      ? await readActiveGatewayLockIdentity({ requireInspection: true }).catch(() => {
          warnCatalogUnavailable();
          return undefined;
        })
      : undefined;
  const rows = await Promise.all(
    sessionEntries.map(async ({ acpSessionKey, agentId, entry, row }, index) => {
      const acpMeta = acpSessionMetadata[index];
      const acpRuntime = acpMeta != null;
      // ACP rows need stored-key metadata before model/runtime resolution so
      // bridge sessions and true ACP runtime sessions display differently.
      const modelRef = applyAcpModelOverlayIfNeeded(
        resolveSessionDisplayModelRef(cfg, row, classifyCliProvider, agentId),
        acpSessionKey,
        acpRuntime,
      );
      const agentRuntime = resolveCurrentSessionAgentRuntimeMetadata({
        cfg,
        agentId,
        sessionEntry: entry,
        provider: modelRef.provider,
        model: modelRef.model,
        sessionKey: acpSessionKey,
        acpRuntime,
        acpBackend: acpMeta?.backend,
      });
      const catalogKey = `${agentId}\0${entry.spawnedWorkspaceDir ?? ""}\0${modelRef.provider}`;
      let pendingCatalog = catalogs.get(catalogKey);
      if (!pendingCatalog) {
        const readSavedCatalog = () =>
          loadPreparedModelCatalogSnapshot({
            config: cfg,
            agentId,
            workspaceDir: entry.spawnedWorkspaceDir,
            readOnly: true,
            providerDiscoveryProviderIds: [modelRef.provider],
          }).catch(() => undefined);
        // The agent catalog cannot supply another spawned workspace's capacity.
        const useGatewayCatalog =
          gatewayOwner &&
          (!entry.spawnedWorkspaceDir ||
            entry.spawnedWorkspaceDir === resolveAgentWorkspaceDir(cfg, agentId));
        pendingCatalog = useGatewayCatalog
          ? callGateway<ModelsListResult>({
              config: cfg,
              localPortOverride: gatewayOwner.port,
              method: "models.list",
              params: {
                agentId,
                provider: modelRef.provider,
                view: "all",
                includeDetails: true,
                includeDefaultModels: false,
                preparedOnly: true,
              },
            })
              .then(({ models }) => ({
                entries: models.map((model) => toSessionCatalogEntry(model)),
                routeVariants: models.flatMap((model) =>
                  [model, ...(model.runtimeChoices ?? [])].map((choice) =>
                    toSessionCatalogEntry(model, choice),
                  ),
                ),
              }))
              .catch(() => {
                warnCatalogUnavailable();
                return readSavedCatalog();
              })
          : readSavedCatalog();
        catalogs.set(catalogKey, pendingCatalog);
      }
      const catalog = await pendingCatalog;
      const logicalEntry = findModelInCatalog(
        catalog?.entries ?? [],
        modelRef.provider,
        modelRef.model,
      );
      if (agentRuntime.id === "auto") {
        agentRuntime.id = resolveEffectiveAgentRuntime({
          cfg,
          agentScope: { kind: "prepared", agentId },
          sessionKey: acpSessionKey,
          sessionEntry: entry,
          provider: modelRef.provider,
          modelId: modelRef.model,
          modelApi: logicalEntry?.api,
          modelBaseUrl: logicalEntry?.baseUrl,
        });
      }
      const catalogEntry =
        logicalEntry &&
        selectModelCatalogRuntimeEntry({
          entry: logicalEntry,
          routeVariants: catalog?.routeVariants ?? [],
          runtimeId: agentRuntime.id,
          allowApiFallback: false,
        }).entry;
      const modelContext = resolveModelContextTokenProjection({
        cfg,
        provider: modelRef.provider,
        model: modelRef.model,
        modelContextWindow: resolveModelContextWindowProfile({
          catalogEntry,
          selected: entry.contextWindow,
        }).contextTokens,
        modelContextTokens: catalogEntry?.contextTokens,
        allowCacheLookup: false,
        allowAsyncLoad: false,
      });
      const contextTokens = resolveProjectedSessionContextTokens({
        entry,
        provider: modelRef.provider,
        model: modelRef.model,
        agentHarnessId: agentRuntime.id,
        resolvedContextTokens: modelContext.contextTokens,
        authoredContextTokens: modelContext.authoredContextTokens,
      });
      return Object.assign(row, {
        agentId,
        acpRuntime,
        agentRuntime,
        contextTokens,
        displayModelRef: modelRef,
        kind: classifySessionKind(row.key, entry),
        runtimePolicySessionKey: resolveDisplayRuntimePolicySessionKey({
          agentId,
          cfg,
          key: row.key,
          entry,
        }),
        runtimeLabel: opts.json
          ? ""
          : resolveSessionRuntimeLabel({
              cfg,
              entry,
              agentRuntime,
              modelProvider: modelRef.provider,
              classifyCliProvider,
            }),
      });
    }),
  );
  const hasMore = rows.length < totalCount;

  if (opts.json) {
    const multi = targets.length > 1;
    const aggregate = aggregateAgents || multi;
    writeRuntimeJson(runtime, {
      path: aggregate || !targets[0] ? null : resolveSessionStoreDisplayPath(targets[0]),
      stores: aggregate
        ? targets.map((target) => ({
            agentId: target.agentId,
            path: resolveSessionStoreDisplayPath(target),
          }))
        : undefined,
      allAgents: aggregateAgents ? true : undefined,
      count: rows.length,
      totalCount,
      limitApplied: limit ?? null,
      hasMore,
      activeMinutes: activeMinutes ?? null,
      sessions: rows.map(({ displayModelRef: modelRef, runtimeLabel, ...row }) => {
        void runtimeLabel;
        return Object.assign(row, {
          totalTokens: resolveSessionTotalTokens(row) ?? null,
          totalTokensFresh: resolveFreshSessionTotalTokens(row) !== undefined,
          contextTokens: row.contextTokens ?? null,
          modelProvider: modelRef.provider,
          model: modelRef.model,
        });
      }),
    });
    return;
  }

  const primaryTarget = targets[0];
  if (primaryTarget && targets.length === 1 && !aggregateAgents) {
    runtime.log(info(`Session store: ${resolveSessionStoreDisplayPath(primaryTarget)}`));
  } else {
    runtime.log(
      info(`Session stores: ${targets.length} (${targets.map((t) => t.agentId).join(", ")})`),
    );
  }
  runtime.log(
    info(
      hasMore && limit !== undefined
        ? `Sessions listed: ${rows.length} of ${totalCount} (limit ${limit})`
        : `Sessions listed: ${rows.length}`,
    ),
  );
  if (activeMinutes) {
    runtime.log(info(`Filtered to last ${activeMinutes} minute(s)`));
  }
  if (rows.length === 0) {
    runtime.log("No sessions found.");
    return;
  }

  const rich = isRich();
  const showAgentColumn = aggregateAgents || targets.length > 1;
  runtime.log(
    renderTable({
      width: getTerminalTableWidth(),
      columns: [
        ...(showAgentColumn ? [{ key: "agent", header: "Agent" }] : []),
        { key: "kind", header: "Kind" },
        { key: "key", header: "Key" },
        { key: "age", header: "Age" },
        { key: "model", header: "Model" },
        { key: "runtime", header: "Runtime" },
        { key: "tokens", header: "Tokens (ctx %)" },
        { key: "flags", header: "Flags", flex: true },
      ].map((column) =>
        Object.assign(column, { header: colorize(rich, theme.heading, column.header) }),
      ),
      rows: rows.map((row) => ({
        agent: colorize(rich, theme.accentBright, sanitizeTerminalText(row.agentId)),
        kind: formatKindCell(row.kind, rich),
        key: formatSessionKeyCell(row.key, rich),
        age: formatSessionAgeCell(row.updatedAt, rich),
        model: formatSessionModelCell(row.displayModelRef.model, rich),
        runtime: colorize(rich, theme.info, sanitizeTerminalText(row.runtimeLabel)),
        tokens: formatTokensCell(
          resolveSessionTotalTokens(row),
          resolveFreshSessionTotalTokens(row),
          row.contextTokens ?? null,
          rich,
        ),
        flags: formatSessionFlagsCell(row, rich),
      })),
    }).trimEnd(),
  );
}
