import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { ACP_SESSION_IDENTITY_RENDERER_VERSION } from "../acp/runtime/session-identifiers.js";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { selectAgentHarness } from "../agents/harness/selection.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import {
  getModelRefStatus,
  isCliProvider,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
} from "../agents/model-selection.js";
import { ensureOpenClawModelsJson } from "../agents/models-config.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";
import { resolveEmbeddedAgentRuntime } from "../agents/pi-embedded-runner/runtime.js";
import { resolveAgentSessionDirs } from "../agents/session-dirs.js";
import { cleanStaleLockFiles } from "../agents/session-write-lock.js";
import { scheduleSubagentOrphanRecovery } from "../agents/subagent-registry.js";
import { resolveAnnounceTargetFromKey } from "../agents/tools/sessions-send-helpers.js";
import { sanitizeInboundSystemTags } from "../auto-reply/reply/inbound-text.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import type { CliDeps } from "../cli/deps.types.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { resolveStateDir } from "../config/paths.js";
import { parseSessionThreadInfo } from "../config/sessions/delivery-info.js";
import type { GatewayTailscaleMode } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { startGmailWatcherWithLogs } from "../hooks/gmail-watcher-lifecycle.js";
import {
  createInternalHookEvent,
  setInternalHooksEnabled,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import { loadInternalHooks } from "../hooks/loader.js";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  clearActiveTurn,
  clearPendingInboundEntries,
  readActiveTurn,
  readPendingInbound,
  readStaleActiveTurns,
} from "../infra/pending-inbound-store.js";
import { enqueueSystemEvent, MAX_EVENTS } from "../infra/system-events.js";
import { scheduleGatewayUpdateCheck } from "../infra/update-startup.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
} from "../utils/delivery-context.shared.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { loadOpenClawPlugins } from "../plugins/loader.js";
import { type PluginServicesHandle, startPluginServices } from "../plugins/services.js";
import {
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  type GatewayUpdateAvailableEventPayload,
} from "./events.js";
import {
  scheduleRestartSentinelWake,
  shouldWakeFromRestartSentinel,
} from "./server-restart-sentinel.js";
import { logGatewayStartup } from "./server-startup-log.js";
import { startGatewayMemoryBackend } from "./server-startup-memory.js";
import { STARTUP_UNAVAILABLE_GATEWAY_METHODS } from "./server-startup-unavailable-methods.js";
import { startGatewayTailscaleExposure } from "./server-tailscale.js";
import { loadSessionEntry } from "./session-utils.js";

const SESSION_LOCK_STALE_MS = 30 * 60 * 1000;

async function prewarmConfiguredPrimaryModel(params: {
  cfg: OpenClawConfig;
  log: { warn: (msg: string) => void };
}): Promise<void> {
  const explicitPrimary = resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model)?.trim();
  if (!explicitPrimary) {
    return;
  }
  const { provider, model } = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  if (isCliProvider(provider, params.cfg)) {
    return;
  }
  const runtime = resolveEmbeddedAgentRuntime();
  if (runtime !== "auto" && runtime !== "pi") {
    return;
  }
  if (selectAgentHarness({ provider, modelId: model, config: params.cfg }).id !== "pi") {
    return;
  }
  const agentDir = resolveOpenClawAgentDir();
  try {
    await ensureOpenClawModelsJson(params.cfg, agentDir);
    const resolved = resolveModel(provider, model, agentDir, params.cfg, {
      skipProviderRuntimeHooks: true,
    });
    if (!resolved.model) {
      throw new Error(
        resolved.error ??
          `Unknown model: ${provider}/${model} (startup warmup only checks static model resolution)`,
      );
    }
  } catch (err) {
    params.log.warn(`startup model warmup failed for ${provider}/${model}: ${String(err)}`);
  }
}

export async function startGatewaySidecars(params: {
  cfg: OpenClawConfig;
  pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
  defaultWorkspaceDir: string;
  deps: CliDeps;
  startChannels: () => Promise<void>;
  log: { warn: (msg: string) => void };
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
}) {
  // Record the process boot timestamp before any channels start.  Active turns
  // written by THIS process (startedAt >= processStartedAt) are live -- not
  // stale leftovers from the previous process.  The recovery loop below uses
  // this to avoid clearing fresh turns that raced ahead of the recovery sweep.
  const processStartedAt = Date.now();

  try {
    const stateDir = resolveStateDir(process.env);
    const sessionDirs = await resolveAgentSessionDirs(stateDir);
    for (const sessionsDir of sessionDirs) {
      await cleanStaleLockFiles({
        sessionsDir,
        staleMs: SESSION_LOCK_STALE_MS,
        removeStale: true,
        log: { warn: (message) => params.log.warn(message) },
      });
    }
  } catch (err) {
    params.log.warn(`session lock cleanup failed on startup: ${String(err)}`);
  }

  await startGmailWatcherWithLogs({
    cfg: params.cfg,
    log: params.logHooks,
  });

  if (params.cfg.hooks?.gmail?.model) {
    const hooksModelRef = resolveHooksGmailModel({
      cfg: params.cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    if (hooksModelRef) {
      const { provider: resolvedDefaultProvider, model: defaultModel } = resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });
      const catalog = await loadModelCatalog({ config: params.cfg });
      const status = getModelRefStatus({
        cfg: params.cfg,
        catalog,
        ref: hooksModelRef,
        defaultProvider: resolvedDefaultProvider,
        defaultModel,
      });
      if (!status.allowed) {
        params.logHooks.warn(
          `hooks.gmail.model "${status.key}" not in agents.defaults.models allowlist (will use primary instead)`,
        );
      }
      if (!status.inCatalog) {
        params.logHooks.warn(
          `hooks.gmail.model "${status.key}" not in the model catalog (may fail at runtime)`,
        );
      }
    }
  }

  try {
    setInternalHooksEnabled(params.cfg.hooks?.internal?.enabled !== false);
    const loadedCount = await loadInternalHooks(params.cfg, params.defaultWorkspaceDir);
    if (loadedCount > 0) {
      params.logHooks.info(
        `loaded ${loadedCount} internal hook handler${loadedCount > 1 ? "s" : ""}`,
      );
    }
  } catch (err) {
    params.logHooks.error(`failed to load hooks: ${String(err)}`);
  }

  // Replay inbound messages captured during the previous drain.
  // Must run BEFORE startChannels() so queued events are in-memory before any
  // live inbound message can trigger a turn on the same session -- preventing a
  // race where live messages are processed ahead of drain-captured replays.
  // enqueueSystemEvent is a pure in-memory operation; no channel infrastructure
  // is required at this point.
  try {
    const stateDir = resolveStateDir(process.env);
    const rawPending = await readPendingInbound(stateDir);
    // Sort by capturedAt ascending so replay order is deterministic regardless
    // of JSON key insertion order. Older messages are replayed before newer ones,
    // and per-session overflow truncation correctly discards the oldest entries.
    const pending = rawPending.slice().toSorted((a, b) => a.capturedAt - b.capturedAt);
    if (pending.length > 0) {
      params.log.warn(`replaying ${pending.length} inbound message(s) captured during drain`);
      // Consume-then-process: clear only inbound entries to prevent infinite retry on crash.
      // Active turns remain intact in the shared file.
      await clearPendingInboundEntries(stateDir);

      // Per-session cap: system-event queue holds at most MAX_EVENTS entries.
      // Sessions with exactly MAX_EVENTS queued entries should replay all of them;
      // only sessions with MORE than MAX_EVENTS entries should truncate.
      const REPLAY_CAP_PER_SESSION = MAX_EVENTS;

      // Phase 1: resolve sessionKey and eventText for every entry, collecting by session.
      // Entries are already sorted by capturedAt (ascending) so per-session lists
      // are in chronological order -- the replay cap slice correctly takes the most recent.
      type ResolvedEntry = {
        entry: (typeof pending)[number];
        sessionKey: string;
        eventText: string;
      };
      const bySession = new Map<string, ResolvedEntry[]>();

      for (const entry of pending) {
        try {
          const payload = entry.payload as {
            chatId?: number | string;
            channelId?: string;
            senderId?: string;
            senderName?: string;
            senderUsername?: string;
            text?: string;
          };
          // NOTE: senderLabel and textPreview are untrusted user-controlled content
          // from the original inbound message. Sanitize to prevent prompt injection
          // via spoofed system tags (e.g. "[System Message]", "System:").
          const rawSenderLabel =
            payload.senderName ?? payload.senderUsername ?? payload.senderId ?? "unknown";
          const senderLabel = sanitizeInboundSystemTags(rawSenderLabel);
          // Limit preview to 100 chars, strip newlines, and escape backticks to
          // prevent prompt injection via crafted message content in System: events.
          const rawPreview = (payload.text ?? "")
            .slice(0, 100)
            .replace(/\n/g, "\\n")
            .replace(/`/g, "\\`");
          const textPreview = sanitizeInboundSystemTags(rawPreview);
          // Prefer the resolved session key stored at capture time; fall back to
          // fabricated key for backward compatibility with entries captured before
          // this change.
          const sessionKey =
            entry.sessionKey ??
            (entry.channel === "telegram"
              ? `telegram:${payload.chatId ?? "unknown"}`
              : entry.channel === "discord"
                ? `discord:channel:${payload.channelId ?? "unknown"}`
                : `${entry.channel}:unknown`);
          // Include entry.channel, entry.accountId, and entry.id in the event text so that
          // entries from different channels or accounts that share the same message id are
          // never collapsed by enqueueSystemEvent's consecutive-duplicate guard.
          const accountSuffix = entry.accountId ? `:${entry.accountId}` : "";
          const eventText = `[pending-inbound:${entry.channel}${accountSuffix}:${entry.id}] Missed message during restart from ${senderLabel}: "${textPreview || "(no text)"}"`;
          const list = bySession.get(sessionKey) ?? [];
          list.push({ entry, sessionKey, eventText });
          bySession.set(sessionKey, list);
        } catch (err) {
          params.log.warn(
            `pending-inbound: replay failed for ${entry.channel}:${entry.id}: ${String(err)}`,
          );
        }
      }

      // Phase 2: enqueue per-session, capping at REPLAY_CAP_PER_SESSION to avoid silent
      // truncation when the session accumulates more than MAX_EVENTS during a long drain.
      for (const [sessionKey, entries] of bySession) {
        // When a skip notice is needed it consumes one queue slot, so body messages
        // must be capped at REPLAY_CAP_PER_SESSION - 1 to keep the total <= MAX_EVENTS.
        const hasOverflow = entries.length > REPLAY_CAP_PER_SESSION;
        const bodyCap = hasOverflow ? REPLAY_CAP_PER_SESSION - 1 : entries.length;
        const toReplay = entries.slice(entries.length - bodyCap);
        const skipped = entries.length - toReplay.length;

        if (skipped > 0) {
          params.log.warn(
            `pending-inbound: ${skipped} older message(s) trimmed for session ${sessionKey} (queue cap)`,
          );
          enqueueSystemEvent(
            `[pending-inbound] ${skipped} older message${skipped > 1 ? "s" : ""} skipped during restart (queue cap ${MAX_EVENTS})`,
            { sessionKey },
          );
        }

        for (const { entry, eventText } of toReplay) {
          enqueueSystemEvent(eventText, {
            sessionKey,
            contextKey: `pending-inbound:${entry.channel}:${entry.id}`,
          });
          params.log.warn(
            `pending-inbound: replayed ${entry.channel}:${entry.id} -> session ${sessionKey}`,
          );
        }
      }
    }
  } catch (err) {
    params.log.warn(`pending-inbound: replay startup failed: ${String(err)}`);
  }

  const skipChannels =
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS);
  if (!skipChannels) {
    try {
      await prewarmConfiguredPrimaryModel({
        cfg: params.cfg,
        log: params.log,
      });
      await params.startChannels();
    } catch (err) {
      params.logChannels.error(`channel startup failed: ${String(err)}`);
    }
  } else {
    params.logChannels.info(
      "skipping channel start (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
    );
  }

  // Recover stale active turns -- runs that were in-flight when the process died.
  // Notify the originating session so the user knows to resend.
  try {
    const stateDir = resolveStateDir(process.env);
    const staleTurns = await readStaleActiveTurns(stateDir);
    if (staleTurns.length > 0) {
      params.log.warn(
        `active-turn recovery: found ${staleTurns.length} stale turn(s) from previous process`,
      );
      for (const turn of staleTurns) {
        // Skip turns started by THIS process -- they raced ahead of the
        // recovery loop (channel startup created a new turn before we got
        // here).  Only turns from the PREVIOUS process are truly stale.
        if (turn.startedAt >= processStartedAt) {
          params.log.warn(
            `active-turn recovery: skipping live turn ${turn.sessionId} (startedAt=${turn.startedAt} >= processStartedAt=${processStartedAt})`,
          );
          continue;
        }

        // Re-validate the current store entry before clearing.  Between the
        // snapshot (readStaleActiveTurns) and now, a fresh turn could have
        // been written under the same sessionId -- e.g. if a channel handler
        // started a new turn whose sessionId collides with a stale one.
        // Only clear if the on-disk entry still has the same startedAt we
        // saw in the snapshot (i.e. it has NOT been refreshed by this process).
        const currentEntry = await readActiveTurn(stateDir, turn.sessionId);
        if (!currentEntry) {
          // Already cleared by something else -- nothing to do.
          continue;
        }
        if (currentEntry.startedAt !== turn.startedAt) {
          // A fresh turn was written under the same sessionId after our snapshot.
          // The startedAt guard above already protects against this case when the
          // new turn's startedAt >= processStartedAt, but a recycled sessionId
          // whose new startedAt still happens to be < processStartedAt (due to
          // clock imprecision or test-injected timestamps) would slip through.
          // Comparing startedAt values is the most reliable way to detect staleness.
          params.log.warn(
            `active-turn recovery: skipping refreshed turn ${turn.sessionId} (snapshot startedAt=${turn.startedAt}, current startedAt=${currentEntry.startedAt})`,
          );
          continue;
        }

        // Consume first to prevent infinite retry on crash.
        // Wrapped in a per-turn try/catch so a single disk error does not abort
        // the entire recovery loop.
        try {
          await clearActiveTurn(stateDir, turn.sessionId);
        } catch (err) {
          params.log.warn(
            `active-turn recovery: clear failed for ${turn.sessionId}: ${String(err)}`,
          );
          continue;
        }

        // Skip probe sessions -- they are synthetic health-check runs.
        if (turn.sessionId.startsWith("probe-")) {
          continue;
        }

        // Attempt to resolve a delivery target for the session. Sessions without
        // a resolvable channel target (isolated scheduler sessions, orphaned sessions,
        // or any session with no channel mapping) are skipped -- the originating system
        // (e.g. a scheduler's drain-retry) handles recovery for those.
        const { baseSessionKey } = parseSessionThreadInfo(turn.sessionKey);
        const parsedTarget = resolveAnnounceTargetFromKey(baseSessionKey ?? turn.sessionKey ?? "");
        const { entry: turnEntry } = loadSessionEntry(turn.sessionKey ?? "");
        let deliveryCtx = deliveryContextFromSession(turnEntry);
        if (!deliveryCtx && baseSessionKey && baseSessionKey !== turn.sessionKey) {
          const { entry: baseEntry } = loadSessionEntry(baseSessionKey);
          deliveryCtx = deliveryContextFromSession(baseEntry);
        }
        const origin = mergeDeliveryContext(deliveryCtx, parsedTarget ?? undefined);
        const resolvedChannel = origin?.channel ? normalizeChannelId(origin.channel) : null;
        const resolvedTo = origin?.to;
        if (!resolvedChannel || !resolvedTo) {
          continue;
        }

        try {
          const recoveryMessage =
            "I was restarted mid-conversation. Please resend your last message.";
          // Embed turn.sessionId in the event text to prevent deduplication when
          // multiple concurrent stale turns share the same sessionKey (e.g. multi-
          // threaded Discord session). enqueueSystemEvent deduplicates on lastText,
          // so a fixed string would silently drop all but the first recovery notice.
          enqueueSystemEvent(`[active-turn-recovery:${turn.sessionId}] ${recoveryMessage}`, {
            sessionKey: turn.sessionKey,
            contextKey: `active-turn-recovery:${turn.sessionId}`,
          });
          params.log.warn(
            `active-turn recovery: notified session ${turn.sessionKey} (sessionId=${turn.sessionId}, channel=${turn.channel})`,
          );
        } catch (err) {
          params.log.warn(
            `active-turn recovery: notify failed for session ${turn.sessionKey}: ${String(err)}`,
          );
        }
      }
    }
  } catch (err) {
    params.log.warn(`active-turn recovery: startup failed: ${String(err)}`);
  }

  if (params.cfg.hooks?.internal?.enabled !== false) {
    setTimeout(() => {
      const hookEvent = createInternalHookEvent("gateway", "startup", "gateway:startup", {
        cfg: params.cfg,
        deps: params.deps,
        workspaceDir: params.defaultWorkspaceDir,
      });
      void triggerInternalHook(hookEvent);
    }, 250);
  }

  let pluginServices: PluginServicesHandle | null = null;
  try {
    pluginServices = await startPluginServices({
      registry: params.pluginRegistry,
      config: params.cfg,
      workspaceDir: params.defaultWorkspaceDir,
    });
  } catch (err) {
    params.log.warn(`plugin services failed to start: ${String(err)}`);
  }

  if (params.cfg.acp?.enabled) {
    void getAcpSessionManager()
      .reconcilePendingSessionIdentities({ cfg: params.cfg })
      .then((result) => {
        if (result.checked === 0) {
          return;
        }
        params.log.warn(
          `acp startup identity reconcile (renderer=${ACP_SESSION_IDENTITY_RENDERER_VERSION}): checked=${result.checked} resolved=${result.resolved} failed=${result.failed}`,
        );
      })
      .catch((err) => {
        params.log.warn(`acp startup identity reconcile failed: ${String(err)}`);
      });
  }

  void startGatewayMemoryBackend({ cfg: params.cfg, log: params.log }).catch((err) => {
    params.log.warn(`qmd memory startup initialization failed: ${String(err)}`);
  });

  if (shouldWakeFromRestartSentinel()) {
    setTimeout(() => {
      void scheduleRestartSentinelWake({ deps: params.deps });
    }, 750);
  }

  scheduleSubagentOrphanRecovery();

  return { pluginServices };
}

type GatewayPostAttachRuntimeDeps = {
  getGlobalHookRunner: typeof getGlobalHookRunner;
  logGatewayStartup: typeof logGatewayStartup;
  scheduleGatewayUpdateCheck: typeof scheduleGatewayUpdateCheck;
  startGatewaySidecars: typeof startGatewaySidecars;
  startGatewayTailscaleExposure: typeof startGatewayTailscaleExposure;
};

const defaultGatewayPostAttachRuntimeDeps: GatewayPostAttachRuntimeDeps = {
  getGlobalHookRunner,
  logGatewayStartup,
  scheduleGatewayUpdateCheck,
  startGatewaySidecars,
  startGatewayTailscaleExposure,
};

export async function startGatewayPostAttachRuntime(
  params: {
    minimalTestGateway: boolean;
    cfgAtStart: OpenClawConfig;
    bindHost: string;
    bindHosts: string[];
    port: number;
    tlsEnabled: boolean;
    log: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
    };
    isNixMode: boolean;
    startupStartedAt?: number;
    broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
    tailscaleMode: GatewayTailscaleMode;
    resetOnExit: boolean;
    controlUiBasePath: string;
    logTailscale: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
      debug?: (msg: string) => void;
    };
    gatewayPluginConfigAtStart: OpenClawConfig;
    pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
    defaultWorkspaceDir: string;
    deps: CliDeps;
    startChannels: () => Promise<void>;
    logHooks: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
    };
    logChannels: { info: (msg: string) => void; error: (msg: string) => void };
    unavailableGatewayMethods: Set<string>;
  },
  runtimeDeps: GatewayPostAttachRuntimeDeps = defaultGatewayPostAttachRuntimeDeps,
) {
  runtimeDeps.logGatewayStartup({
    cfg: params.cfgAtStart,
    bindHost: params.bindHost,
    bindHosts: params.bindHosts,
    port: params.port,
    tlsEnabled: params.tlsEnabled,
    loadedPluginIds: params.pluginRegistry.plugins
      .filter((plugin) => plugin.status === "loaded")
      .map((plugin) => plugin.id),
    log: params.log,
    isNixMode: params.isNixMode,
    startupStartedAt: params.startupStartedAt,
  });

  const stopGatewayUpdateCheck = params.minimalTestGateway
    ? () => {}
    : runtimeDeps.scheduleGatewayUpdateCheck({
        cfg: params.cfgAtStart,
        log: params.log,
        isNixMode: params.isNixMode,
        onUpdateAvailableChange: (updateAvailable) => {
          const payload: GatewayUpdateAvailableEventPayload = { updateAvailable };
          params.broadcast(GATEWAY_EVENT_UPDATE_AVAILABLE, payload, { dropIfSlow: true });
        },
      });

  const tailscaleCleanup = params.minimalTestGateway
    ? null
    : await runtimeDeps.startGatewayTailscaleExposure({
        tailscaleMode: params.tailscaleMode,
        resetOnExit: params.resetOnExit,
        port: params.port,
        controlUiBasePath: params.controlUiBasePath,
        logTailscale: params.logTailscale,
      });

  let pluginServices: PluginServicesHandle | null = null;
  if (!params.minimalTestGateway) {
    params.log.info("starting channels and sidecars...");
    ({ pluginServices } = await runtimeDeps.startGatewaySidecars({
      cfg: params.gatewayPluginConfigAtStart,
      pluginRegistry: params.pluginRegistry,
      defaultWorkspaceDir: params.defaultWorkspaceDir,
      deps: params.deps,
      startChannels: params.startChannels,
      log: params.log,
      logHooks: params.logHooks,
      logChannels: params.logChannels,
    }));
    for (const method of STARTUP_UNAVAILABLE_GATEWAY_METHODS) {
      params.unavailableGatewayMethods.delete(method);
    }
  }

  if (!params.minimalTestGateway) {
    const hookRunner = runtimeDeps.getGlobalHookRunner();
    if (hookRunner?.hasHooks("gateway_start")) {
      void hookRunner.runGatewayStart({ port: params.port }, { port: params.port }).catch((err) => {
        params.log.warn(`gateway_start hook failed: ${String(err)}`);
      });
    }
  }

  return { stopGatewayUpdateCheck, tailscaleCleanup, pluginServices };
}

export const __testing = {
  prewarmConfiguredPrimaryModel,
};
