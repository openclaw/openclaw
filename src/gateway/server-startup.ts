import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { ACP_SESSION_IDENTITY_RENDERER_VERSION } from "../acp/runtime/session-identifiers.js";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import {
  getModelRefStatus,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
} from "../agents/model-selection.js";
import { ensureOpenClawModelsJson } from "../agents/models-config.js";
import { resolveModelAsync } from "../agents/pi-embedded-runner/model.js";
import { resolveAgentSessionDirs } from "../agents/session-dirs.js";
import { cleanStaleLockFiles } from "../agents/session-write-lock.js";
import { resolveAnnounceTargetFromKey } from "../agents/tools/sessions-send-helpers.js";
import { sanitizeInboundSystemTags } from "../auto-reply/reply/inbound-text.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import type { CliDeps } from "../cli/deps.js";
import type { loadConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { resolveStateDir } from "../config/paths.js";
import { parseSessionThreadInfo } from "../config/sessions/delivery-info.js";
import { startGmailWatcherWithLogs } from "../hooks/gmail-watcher-lifecycle.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import { loadInternalHooks } from "../hooks/loader.js";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  claimPendingInboundEntries,
  clearActiveTurn,
  readActiveTurn,
  readStaleActiveTurns,
} from "../infra/pending-inbound-store.js";
import { enqueueSystemEvent, MAX_EVENTS } from "../infra/system-events.js";
import type { loadOpenClawPlugins } from "../plugins/loader.js";
import { type PluginServicesHandle, startPluginServices } from "../plugins/services.js";
import { deliveryContextFromSession, mergeDeliveryContext } from "../utils/delivery-context.js";
import { startBrowserControlServerIfEnabled } from "./server-browser.js";
import {
  scheduleRestartSentinelWake,
  shouldWakeFromRestartSentinel,
} from "./server-restart-sentinel.js";
import { startGatewayMemoryBackend } from "./server-startup-memory.js";
import { loadSessionEntry } from "./session-utils.js";

const SESSION_LOCK_STALE_MS = 30 * 60 * 1000;

async function prewarmConfiguredPrimaryModel(params: {
  cfg: ReturnType<typeof loadConfig>;
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
  const agentDir = resolveOpenClawAgentDir();
  try {
    await ensureOpenClawModelsJson(params.cfg, agentDir);
    const resolved = await resolveModelAsync(provider, model, agentDir, params.cfg, {
      retryTransientProviderRuntimeMiss: true,
    });
    if (!resolved.model) {
      throw new Error(resolved.error ?? `Unknown model: ${provider}/${model}`);
    }
  } catch (err) {
    params.log.warn(`startup model warmup failed for ${provider}/${model}: ${String(err)}`);
  }
}

export async function startGatewaySidecars(params: {
  cfg: ReturnType<typeof loadConfig>;
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
  logBrowser: { error: (msg: string) => void };
}) {
  // Record the process boot timestamp before any channels start.  Active turns
  // written by THIS process (startedAt >= processStartedAt) are live — not
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

  // Start OpenClaw browser control server (unless disabled via config).
  let browserControl: Awaited<ReturnType<typeof startBrowserControlServerIfEnabled>> = null;
  try {
    browserControl = await startBrowserControlServerIfEnabled();
  } catch (err) {
    params.logBrowser.error(`server failed to start: ${String(err)}`);
  }

  // Start Gmail watcher if configured (hooks.gmail.account).
  await startGmailWatcherWithLogs({
    cfg: params.cfg,
    log: params.logHooks,
  });

  // Validate hooks.gmail.model if configured.
  if (params.cfg.hooks?.gmail?.model) {
    const hooksModelRef = resolveHooksGmailModel({
      cfg: params.cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    if (hooksModelRef) {
      const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });
      const catalog = await loadModelCatalog({ config: params.cfg });
      const status = getModelRefStatus({
        cfg: params.cfg,
        catalog,
        ref: hooksModelRef,
        defaultProvider,
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

  // Load internal hook handlers from configuration and directory discovery.
  try {
    // Clear any previously registered hooks to ensure fresh loading
    clearInternalHooks();
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
  // live inbound message can trigger a turn on the same session — preventing a
  // race where live messages are processed ahead of drain-captured replays.
  // enqueueSystemEvent is a pure in-memory operation; no channel infrastructure
  // is required at this point.
  try {
    const stateDir = resolveStateDir(process.env);
    // Atomically claim (read + clear) pending entries in a single locked
    // operation.  This prevents a race where a concurrent drain writer
    // inserts a new entry between reading and clearing — the old separate
    // readPendingInbound → clearPendingInboundEntries sequence could lose
    // messages captured in that window.
    const pending = await claimPendingInboundEntries(stateDir);
    if (pending.length > 0) {
      params.log.warn(`replaying ${pending.length} inbound message(s) captured during drain`);

      // Per-session cap: system-event queue holds at most MAX_EVENTS entries.
      // Sessions with exactly MAX_EVENTS queued entries should replay all of them;
      // only sessions with MORE than MAX_EVENTS entries should truncate.
      const REPLAY_CAP_PER_SESSION = MAX_EVENTS;

      // Phase 1: resolve sessionKey and eventText for every entry, collecting by session.
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
          const senderLabel = sanitizeInboundSystemTags(String(rawSenderLabel));
          const rawPreview = (payload.text ?? "").slice(0, 200).replace(/\n/g, "\\n");
          const textPreview = sanitizeInboundSystemTags(String(rawPreview));
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
          // Include entry.id in the event text so that two identical messages sent during
          // a drain window (same text, same sender) are never collapsed by enqueueSystemEvent's
          // consecutive-duplicate guard.
          const eventText = `[pending-inbound:${entry.id}] Missed message during restart from ${senderLabel}: "${textPreview || "(no text)"}"`;
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
        // must be capped at REPLAY_CAP_PER_SESSION - 1 to keep the total ≤ MAX_EVENTS.
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
            `pending-inbound: replayed ${entry.channel}:${entry.id} → session ${sessionKey}`,
          );
        }
      }
    }
  } catch (err) {
    params.log.warn(`pending-inbound: replay startup failed: ${String(err)}`);
  }

  // Launch configured channels so gateway replies via the surface the message came from.
  // Tests can opt out via OPENCLAW_SKIP_CHANNELS (or legacy OPENCLAW_SKIP_PROVIDERS).
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

  // Recover stale active turns — runs that were in-flight when the process died.
  // Notify the originating session so the user knows to resend.
  try {
    const stateDir = resolveStateDir(process.env);
    const staleTurns = await readStaleActiveTurns(stateDir);
    if (staleTurns.length > 0) {
      params.log.warn(
        `active-turn recovery: found ${staleTurns.length} stale turn(s) from previous process`,
      );
      for (const turn of staleTurns) {
        // Skip turns started by THIS process — they raced ahead of the
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
        // been written under the same sessionId — e.g. if a channel handler
        // started a new turn whose sessionId collides with a stale one.
        // Only clear if the on-disk entry still has the same startedAt we
        // saw in the snapshot (i.e. it has NOT been refreshed by this process).
        const currentEntry = await readActiveTurn(stateDir, turn.sessionId);
        if (!currentEntry) {
          // Already cleared by something else — nothing to do.
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
        await clearActiveTurn(stateDir, turn.sessionId);

        // Skip probe sessions — they are synthetic health-check runs.
        if (turn.sessionId.startsWith("probe-")) {
          continue;
        }

        // Attempt to resolve a delivery target for the session. Sessions without
        // a resolvable channel target (isolated scheduler sessions, orphaned sessions,
        // or any session with no channel mapping) are skipped — the originating system
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
            "⚠️ I was restarted mid-conversation. Please resend your last message.";
          enqueueSystemEvent(`[active-turn-recovery] ${recoveryMessage}`, {
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

  if (params.cfg.hooks?.internal?.enabled) {
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

  return { browserControl, pluginServices };
}

export const __testing = {
  prewarmConfiguredPrimaryModel,
};
