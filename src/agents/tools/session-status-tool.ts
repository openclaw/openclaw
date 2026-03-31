import { Type } from "@sinclair/typebox";
import { normalizeGroupActivation } from "../../auto-reply/group-activation.js";
import { getFollowupQueueDepth, resolveQueueSettings } from "../../auto-reply/reply/queue.js";
import { buildStatusMessage } from "../../auto-reply/status.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveStorePath,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { resolveSessionModelIdentityRef } from "../../gateway/session-utils.js";
import {
  formatUsageWindowSummary,
  loadProviderUsageSummary,
  resolveUsageProviderId,
} from "../../infra/provider-usage.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { listTasksForSessionKey } from "../../tasks/task-registry.js";
import { resolveAgentConfig, resolveAgentDir } from "../agent-scope.js";
import { formatUserTime, resolveUserTimeFormat, resolveUserTimezone } from "../date-time.js";
import { resolveModelAuthLabel } from "../model-auth-label.js";
import { loadModelCatalog } from "../model-catalog.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  modelKey,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../model-selection.js";
import type { AnyAgentTool } from "./common.js";
import { readStringParam } from "./common.js";
import {
  createSessionVisibilityGuard,
  shouldResolveSessionIdInput,
  createAgentToAgentPolicy,
  resolveEffectiveSessionToolsVisibility,
  resolveInternalSessionKey,
  resolveSessionReference,
  resolveSandboxedSessionToolContext,
  resolveVisibleSessionReference,
} from "./sessions-helpers.js";

const SessionStatusToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
});

function resolveSessionEntry(params: {
  store: Record<string, SessionEntry>;
  keyRaw: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  includeAliasFallback?: boolean;
}): { key: string; entry: SessionEntry } | null {
  const keyRaw = params.keyRaw.trim();
  if (!keyRaw) {
    return null;
  }
  const includeAliasFallback = params.includeAliasFallback ?? true;
  const internal = resolveInternalSessionKey({
    key: keyRaw,
    alias: params.alias,
    mainKey: params.mainKey,
    requesterInternalKey: params.requesterInternalKey,
  });

  const candidates: string[] = [keyRaw];
  if (!keyRaw.startsWith("agent:")) {
    candidates.push(`agent:${DEFAULT_AGENT_ID}:${keyRaw}`);
  }
  if (includeAliasFallback && internal !== keyRaw) {
    candidates.push(internal);
  }
  if (includeAliasFallback && !keyRaw.startsWith("agent:")) {
    const agentInternal = `agent:${DEFAULT_AGENT_ID}:${internal}`;
    const agentRaw = `agent:${DEFAULT_AGENT_ID}:${keyRaw}`;
    if (agentInternal !== agentRaw) {
      candidates.push(agentInternal);
    }
  }
  if (includeAliasFallback && (keyRaw === "main" || keyRaw === "current")) {
    const defaultMainKey = buildAgentMainSessionKey({
      agentId: DEFAULT_AGENT_ID,
      mainKey: params.mainKey,
    });
    if (!candidates.includes(defaultMainKey)) {
      candidates.push(defaultMainKey);
    }
  }

  for (const key of candidates) {
    const entry = params.store[key];
    if (entry) {
      return { key, entry };
    }
  }

  return null;
}

function resolveStoreScopedRequesterKey(params: {
  requesterKey: string;
  agentId: string;
  mainKey: string;
}) {
  const parsed = parseAgentSessionKey(params.requesterKey);
  if (!parsed || parsed.agentId !== params.agentId) {
    return params.requesterKey;
  }
  return parsed.rest === params.mainKey ? params.mainKey : params.requesterKey;
}

function formatSessionTaskLine(sessionKey: string): string | undefined {
  const tasks = listTasksForSessionKey(sessionKey);
  if (tasks.length === 0) {
    return undefined;
  }
  const latest = tasks[0];
  const active = tasks.filter(
    (task) => task.status === "queued" || task.status === "running",
  ).length;
  const failed = tasks.filter(
    (task) => task.status === "failed" || task.status === "timed_out" || task.status === "lost",
  ).length;
  const headline =
    active > 0
      ? `${active} active`
      : failed > 0
        ? `${failed} recent failure${failed === 1 ? "" : "s"}`
        : `latest ${latest.status.replaceAll("_", " ")}`;
  const title = latest.label?.trim() || latest.task.trim();
  const detail =
    latest.status === "running" || latest.status === "queued"
      ? latest.progressSummary?.trim()
      : latest.error?.trim() || latest.terminalSummary?.trim();
  const parts = [headline, latest.runtime, title, detail].filter(Boolean);
  return parts.length ? `📌 Tasks: ${parts.join(" · ")}` : undefined;
}

async function resolveModelOverride(params: {
  cfg: OpenClawConfig;
  raw: string;
  sessionEntry?: SessionEntry;
  agentId: string;
}): Promise<
  | { kind: "reset" }
  | {
      kind: "set";
      provider: string;
      model: string;
      isDefault: boolean;
    }
> {
  const raw = params.raw.trim();
  if (!raw) {
    return { kind: "reset" };
  }
  if (raw.toLowerCase() === "default") {
    return { kind: "reset" };
  }

  const configDefault = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const currentProvider = params.sessionEntry?.providerOverride?.trim() || configDefault.provider;
  const currentModel = params.sessionEntry?.modelOverride?.trim() || configDefault.model;

  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: currentProvider,
  });
  const catalog = await loadModelCatalog({ config: params.cfg });
  const allowed = buildAllowedModelSet({
    cfg: params.cfg,
    catalog,
    defaultProvider: currentProvider,
    defaultModel: currentModel,
    agentId: params.agentId,
  });

  const resolved = resolveModelRefFromString({
    raw,
    defaultProvider: currentProvider,
    aliasIndex,
  });
  if (!resolved) {
    throw new Error(`Unrecognized model "${raw}".`);
  }
  const key = modelKey(resolved.ref.provider, resolved.ref.model);
  if (allowed.allowedKeys.size > 0 && !allowed.allowedKeys.has(key)) {
    throw new Error(`Model "${key}" is not allowed.`);
  }
  const isDefault =
    resolved.ref.provider === configDefault.provider && resolved.ref.model === configDefault.model;
  return {
    kind: "set",
    provider: resolved.ref.provider,
    model: resolved.ref.model,
    isDefault,
  };
}

export function createSessionStatusTool(opts?: {
  agentSessionKey?: string;
  config?: OpenClawConfig;
  sandboxed?: boolean;
}): AnyAgentTool {
  return {
    label: "Session Status",
    name: "session_status",
    description:
      "Show a /status-equivalent session status card (usage + time + cost when available), including linked background task context when present. Use for model-use questions (📊 session_status). Optional: set per-session model override (model=default resets overrides).",
    parameters: SessionStatusToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = opts?.config ?? loadConfig();
      const { mainKey, alias, effectiveRequesterKey } = resolveSandboxedSessionToolContext({
        cfg,
        agentSessionKey: opts?.agentSessionKey,
        sandboxed: opts?.sandboxed,
      });
      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const requesterAgentId = resolveAgentIdFromSessionKey(
        opts?.agentSessionKey ?? effectiveRequesterKey,
      );
      const visibilityRequesterKey = (opts?.agentSessionKey ?? effectiveRequesterKey).trim();
      const usesLegacyMainAlias = alias === mainKey;
      const isLegacyMainVisibilityKey = (sessionKey: string) => {
        const trimmed = sessionKey.trim();
        return usesLegacyMainAlias && (trimmed === "main" || trimmed === mainKey);
      };
      const resolveVisibilityMainSessionKey = (sessionAgentId: string) => {
        const requesterParsed = parseAgentSessionKey(visibilityRequesterKey);
        if (
          resolveAgentIdFromSessionKey(visibilityRequesterKey) === sessionAgentId &&
          (requesterParsed?.rest === mainKey || isLegacyMainVisibilityKey(visibilityRequesterKey))
        ) {
          return visibilityRequesterKey;
        }
        return buildAgentMainSessionKey({
          agentId: sessionAgentId,
          mainKey,
        });
      };
      const normalizeVisibilityTargetSessionKey = (sessionKey: string, sessionAgentId: string) => {
        const trimmed = sessionKey.trim();
        if (!trimmed) {
          return trimmed;
        }
        if (trimmed.startsWith("agent:")) {
          const parsed = parseAgentSessionKey(trimmed);
          if (parsed?.rest === mainKey) {
            return resolveVisibilityMainSessionKey(sessionAgentId);
          }
          return trimmed;
        }
        // Preserve legacy bare main keys for requester tree checks.
        if (isLegacyMainVisibilityKey(trimmed)) {
          return resolveVisibilityMainSessionKey(sessionAgentId);
        }
        return trimmed;
      };
      const visibilityGuard = await createSessionVisibilityGuard({
        action: "status",
        requesterSessionKey: visibilityRequesterKey,
        visibility: resolveEffectiveSessionToolsVisibility({
          cfg,
          sandboxed: opts?.sandboxed === true,
        }),
        a2aPolicy,
      });

      const requestedKeyParam = readStringParam(params, "sessionKey");
      let requestedKeyRaw = requestedKeyParam ?? opts?.agentSessionKey;
      const requestedKeyInput = requestedKeyRaw?.trim() ?? "";
      let resolvedViaSessionId = false;
      if (!requestedKeyRaw?.trim()) {
        throw new Error("sessionKey required");
      }
      const ensureAgentAccess = (targetAgentId: string) => {
        if (targetAgentId === requesterAgentId) {
          return;
        }
        // Gate cross-agent access behind tools.agentToAgent settings.
        if (!a2aPolicy.enabled) {
          throw new Error(
            "Agent-to-agent status is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent access.",
          );
        }
        if (!a2aPolicy.isAllowed(requesterAgentId, targetAgentId)) {
          throw new Error("Agent-to-agent session status denied by tools.agentToAgent.allow.");
        }
      };

      if (requestedKeyRaw.startsWith("agent:")) {
        const requestedAgentId = resolveAgentIdFromSessionKey(requestedKeyRaw);
        ensureAgentAccess(requestedAgentId);
        const access = visibilityGuard.check(
          normalizeVisibilityTargetSessionKey(requestedKeyRaw, requestedAgentId),
        );
        if (!access.allowed) {
          throw new Error(access.error);
        }
      }

      const isExplicitAgentKey = requestedKeyRaw.startsWith("agent:");
      let agentId = isExplicitAgentKey
        ? resolveAgentIdFromSessionKey(requestedKeyRaw)
        : requesterAgentId;
      let storePath = resolveStorePath(cfg.session?.store, { agentId });
      let store = loadSessionStore(storePath);
      let storeScopedRequesterKey = resolveStoreScopedRequesterKey({
        requesterKey: effectiveRequesterKey,
        agentId,
        mainKey,
      });

      // Resolve against the requester-scoped store first to avoid leaking default agent data.
      let resolved = resolveSessionEntry({
        store,
        keyRaw: requestedKeyRaw,
        alias,
        mainKey,
        requesterInternalKey: storeScopedRequesterKey,
        includeAliasFallback: requestedKeyRaw !== "current",
      });

      if (
        !resolved &&
        (requestedKeyRaw === "current" || shouldResolveSessionIdInput(requestedKeyRaw))
      ) {
        const resolvedSession = await resolveSessionReference({
          sessionKey: requestedKeyRaw,
          alias,
          mainKey,
          requesterInternalKey: effectiveRequesterKey,
          restrictToSpawned: opts?.sandboxed === true,
        });
        if (resolvedSession.ok && resolvedSession.resolvedViaSessionId) {
          const visibleSession = await resolveVisibleSessionReference({
            resolvedSession,
            requesterSessionKey: effectiveRequesterKey,
            restrictToSpawned: opts?.sandboxed === true,
            visibilitySessionKey: requestedKeyRaw,
          });
          if (!visibleSession.ok) {
            throw new Error("Session status visibility is restricted to the current session tree.");
          }
          // If resolution points at another agent, enforce A2A policy before switching stores.
          ensureAgentAccess(resolveAgentIdFromSessionKey(visibleSession.key));
          resolvedViaSessionId = true;
          requestedKeyRaw = visibleSession.key;
          agentId = resolveAgentIdFromSessionKey(visibleSession.key);
          storePath = resolveStorePath(cfg.session?.store, { agentId });
          store = loadSessionStore(storePath);
          storeScopedRequesterKey = resolveStoreScopedRequesterKey({
            requesterKey: effectiveRequesterKey,
            agentId,
            mainKey,
          });
          resolved = resolveSessionEntry({
            store,
            keyRaw: requestedKeyRaw,
            alias,
            mainKey,
            requesterInternalKey: storeScopedRequesterKey,
          });
        } else if (!resolvedSession.ok && opts?.sandboxed === true) {
          throw new Error("Session status visibility is restricted to the current session tree.");
        }
      }

      if (!resolved && requestedKeyRaw === "current") {
        resolved = resolveSessionEntry({
          store,
          keyRaw: requestedKeyRaw,
          alias,
          mainKey,
          requesterInternalKey: storeScopedRequesterKey,
          includeAliasFallback: true,
        });
      }

      if (!resolved) {
        const kind = shouldResolveSessionIdInput(requestedKeyRaw) ? "sessionId" : "sessionKey";
        throw new Error(`Unknown ${kind}: ${requestedKeyRaw}`);
      }

      // Preserve caller-scoped raw-key/current lookups as "self" for visibility checks.
      const visibilityTargetKey =
        !resolvedViaSessionId &&
        (requestedKeyInput === "current" || resolved.key === requestedKeyInput)
          ? visibilityRequesterKey
          : normalizeVisibilityTargetSessionKey(resolved.key, agentId);
      const access = visibilityGuard.check(visibilityTargetKey);
      if (!access.allowed) {
        throw new Error(access.error);
      }

      const configured = resolveDefaultModelForAgent({ cfg, agentId });
      const modelRaw = readStringParam(params, "model");
      let changedModel = false;
      if (typeof modelRaw === "string") {
        const selection = await resolveModelOverride({
          cfg,
          raw: modelRaw,
          sessionEntry: resolved.entry,
          agentId,
        });
        const nextEntry: SessionEntry = { ...resolved.entry };
        const applied = applyModelOverrideToSessionEntry({
          entry: nextEntry,
          selection:
            selection.kind === "reset"
              ? {
                  provider: configured.provider,
                  model: configured.model,
                  isDefault: true,
                }
              : {
                  provider: selection.provider,
                  model: selection.model,
                  isDefault: selection.isDefault,
                },
        });
        if (applied.updated) {
          store[resolved.key] = nextEntry;
          await updateSessionStore(storePath, (nextStore) => {
            nextStore[resolved.key] = nextEntry;
          });
          resolved.entry = nextEntry;
          changedModel = true;
        }
      }

      const agentDir = resolveAgentDir(cfg, agentId);
      const runtimeModelIdentity = resolveSessionModelIdentityRef(
        cfg,
        resolved.entry,
        agentId,
        `${configured.provider}/${configured.model}`,
      );
      const hasExplicitModelOverride = Boolean(
        resolved.entry.providerOverride?.trim() || resolved.entry.modelOverride?.trim(),
      );
      const runtimeProviderForCard = runtimeModelIdentity.provider?.trim();
      const runtimeModelForCard = runtimeModelIdentity.model.trim();
      const defaultProviderForCard = hasExplicitModelOverride
        ? configured.provider
        : (runtimeProviderForCard ?? "");
      const defaultModelForCard = hasExplicitModelOverride
        ? configured.model
        : runtimeModelForCard || configured.model;
      // Preserve the "provider unknown" case for legacy runtime-only sessions so the
      // status card does not synthesize a configured provider/model pair that never ran.
      const statusSessionEntry =
        !hasExplicitModelOverride && !runtimeProviderForCard && runtimeModelForCard
          ? { ...resolved.entry, providerOverride: "" }
          : resolved.entry;
      const providerOverrideForCard = statusSessionEntry.providerOverride?.trim();
      const providerForCard = providerOverrideForCard ?? defaultProviderForCard;
      const usageProvider = resolveUsageProviderId(providerForCard);
      let usageLine: string | undefined;
      if (usageProvider) {
        try {
          const usageSummary = await loadProviderUsageSummary({
            timeoutMs: 3500,
            providers: [usageProvider],
            agentDir,
          });
          const snapshot = usageSummary.providers.find((entry) => entry.provider === usageProvider);
          if (snapshot) {
            const formatted = formatUsageWindowSummary(snapshot, {
              now: Date.now(),
              maxWindows: 2,
              includeResets: true,
            });
            if (formatted && !formatted.startsWith("error:")) {
              usageLine = `📊 Usage: ${formatted}`;
            }
          }
        } catch {
          // ignore
        }
      }

      const isGroup =
        resolved.entry.chatType === "group" ||
        resolved.entry.chatType === "channel" ||
        resolved.key.includes(":group:") ||
        resolved.key.includes(":channel:");
      const groupActivation = isGroup
        ? (normalizeGroupActivation(resolved.entry.groupActivation) ?? "mention")
        : undefined;

      const queueSettings = resolveQueueSettings({
        cfg,
        channel:
          resolved.entry.channel ??
          resolved.entry.lastChannel ??
          resolved.entry.origin?.provider ??
          "unknown",
        sessionEntry: resolved.entry,
      });
      const queueKey = resolved.key ?? resolved.entry.sessionId;
      const queueDepth = queueKey ? getFollowupQueueDepth(queueKey) : 0;
      const queueOverrides = Boolean(
        resolved.entry.queueDebounceMs ?? resolved.entry.queueCap ?? resolved.entry.queueDrop,
      );

      const userTimezone = resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
      const userTimeFormat = resolveUserTimeFormat(cfg.agents?.defaults?.timeFormat);
      const userTime = formatUserTime(new Date(), userTimezone, userTimeFormat);
      const timeLine = userTime
        ? `🕒 Time: ${userTime} (${userTimezone})`
        : `🕒 Time zone: ${userTimezone}`;

      const agentDefaults = cfg.agents?.defaults ?? {};
      const agentConfig = resolveAgentConfig(cfg, agentId);
      const defaultLabel = defaultProviderForCard
        ? `${defaultProviderForCard}/${defaultModelForCard}`
        : defaultModelForCard;
      const agentModel =
        typeof agentDefaults.model === "object" && agentDefaults.model
          ? { ...agentDefaults.model, primary: defaultLabel }
          : { primary: defaultLabel };
      const statusText = buildStatusMessage({
        config: cfg,
        agent: {
          ...agentDefaults,
          model: agentModel,
          thinkingDefault: agentConfig?.thinkingDefault ?? agentDefaults.thinkingDefault,
        },
        agentId,
        explicitConfiguredContextTokens:
          typeof agentDefaults.contextTokens === "number" && agentDefaults.contextTokens > 0
            ? agentDefaults.contextTokens
            : undefined,
        sessionEntry: statusSessionEntry,
        sessionKey: resolved.key,
        sessionStorePath: storePath,
        groupActivation,
        modelAuth: resolveModelAuthLabel({
          provider: providerForCard,
          cfg,
          sessionEntry: statusSessionEntry,
          agentDir,
        }),
        usageLine,
        timeLine,
        queue: {
          mode: queueSettings.mode,
          depth: queueDepth,
          debounceMs: queueSettings.debounceMs,
          cap: queueSettings.cap,
          dropPolicy: queueSettings.dropPolicy,
          showDetails: queueOverrides,
        },
        includeTranscriptUsage: true,
      });
      const taskLine = formatSessionTaskLine(resolved.key);
      const fullStatusText = taskLine ? `${statusText}\n${taskLine}` : statusText;

      return {
        content: [{ type: "text", text: fullStatusText }],
        details: {
          ok: true,
          sessionKey: resolved.key,
          changedModel,
          statusText: fullStatusText,
        },
      };
    },
  };
}
