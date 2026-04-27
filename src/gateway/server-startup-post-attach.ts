import { setTimeout as sleep } from "node:timers/promises";
import type { CliDeps } from "../cli/deps.types.js";
import type { GatewayTailscaleMode } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasConfiguredInternalHooks } from "../hooks/configured.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { scheduleGatewayUpdateCheck } from "../infra/update-startup.js";
import type { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-types.js";
import type { loadOpenClawPlugins } from "../plugins/loader.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import {
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  type GatewayUpdateAvailableEventPayload,
} from "./events.js";
import type { refreshLatestUpdateRestartSentinel } from "./server-restart-sentinel.js";
import type { logGatewayStartup } from "./server-startup-log.js";
import { STARTUP_UNAVAILABLE_GATEWAY_METHODS } from "./server-startup-unavailable-methods.js";
import type { startGatewayTailscaleExposure } from "./server-tailscale.js";

const SESSION_LOCK_STALE_MS = 30 * 60 * 1000;
const ACP_BACKEND_READY_TIMEOUT_MS = 5_000;
const ACP_BACKEND_READY_POLL_MS = 50;
const PRIMARY_MODEL_PREWARM_TIMEOUT_MS = 5_000;
const STARTUP_PROVIDER_DISCOVERY_TIMEOUT_MS = 5_000;
const SKIP_STARTUP_MODEL_PREWARM_ENV = "OPENCLAW_SKIP_STARTUP_MODEL_PREWARM";
const QMD_STARTUP_IDLE_DELAY_MS = 120_000;

type Awaitable<T> = T | Promise<T>;

type GatewayStartupTrace = {
  mark: (name: string) => void;
  measure: <T>(name: string, run: () => Awaitable<T>) => Promise<T>;
};

type GatewayMemoryStartupPolicy =
  | { mode: "off" }
  | { mode: "immediate" }
  | { mode: "idle"; delayMs: number };

async function measureStartup<T>(
  startupTrace: GatewayStartupTrace | undefined,
  name: string,
  run: () => Awaitable<T>,
): Promise<T> {
  return startupTrace ? startupTrace.measure(name, run) : await run();
}

function shouldCheckRestartSentinel(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.VITEST && env.NODE_ENV !== "test";
}

function shouldSkipStartupModelPrewarm(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[SKIP_STARTUP_MODEL_PREWARM_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function resolveGatewayMemoryStartupPolicy(cfg: OpenClawConfig): GatewayMemoryStartupPolicy {
  if (cfg.memory?.backend !== "qmd") {
    return { mode: "off" };
  }
  if (cfg.memory.qmd?.update?.onBoot === false) {
    return { mode: "off" };
  }
  const startup = cfg.memory.qmd?.update?.startup;
  if (startup === "immediate") {
    return { mode: "immediate" };
  }
  if (startup === "idle") {
    const rawDelayMs = cfg.memory.qmd?.update?.startupDelayMs;
    const delayMs =
      typeof rawDelayMs === "number" && Number.isFinite(rawDelayMs) && rawDelayMs >= 0
        ? Math.floor(rawDelayMs)
        : QMD_STARTUP_IDLE_DELAY_MS;
    return { mode: "idle", delayMs };
  }
  return { mode: "off" };
}

function scheduleGatewayMemoryBackend(params: {
  cfg: OpenClawConfig;
  log: { warn: (msg: string) => void };
  policy: GatewayMemoryStartupPolicy;
}): void {
  if (params.policy.mode === "off") {
    return;
  }
  const start = () => {
    void import("./server-startup-memory.js")
      .then(({ startGatewayMemoryBackend }) =>
        startGatewayMemoryBackend({ cfg: params.cfg, log: params.log }),
      )
      .catch((err) => {
        params.log.warn(`qmd memory startup initialization failed: ${String(err)}`);
      });
  };
  if (params.policy.mode === "immediate") {
    setImmediate(start);
    return;
  }
  const timer = setTimeout(start, params.policy.delayMs);
  timer.unref?.();
}

function hasGatewayStartHooks(pluginRegistry: ReturnType<typeof loadOpenClawPlugins>): boolean {
  return pluginRegistry.typedHooks.some((hook) => hook.hookName === "gateway_start");
}

function isConfiguredCliBackendPrimary(params: {
  cfg: OpenClawConfig;
  explicitPrimary: string;
  normalizeProviderId: (provider: string) => string;
}): boolean {
  const slashIndex = params.explicitPrimary.indexOf("/");
  if (slashIndex <= 0) {
    return false;
  }
  const provider = params.normalizeProviderId(params.explicitPrimary.slice(0, slashIndex));
  return Object.keys(params.cfg.agents?.defaults?.cliBackends ?? {}).some(
    (backend) => params.normalizeProviderId(backend) === provider,
  );
}

async function hasGatewayStartupInternalHookListeners(): Promise<boolean> {
  const { hasInternalHookListeners } = await import("../hooks/internal-hooks.js");
  return hasInternalHookListeners("gateway", "startup");
}

async function waitForAcpRuntimeBackendReady(params: {
  backendId?: string;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<boolean> {
  const { getAcpRuntimeBackend } = await import("../acp/runtime/registry.js");
  const timeoutMs = params.timeoutMs ?? ACP_BACKEND_READY_TIMEOUT_MS;
  const pollMs = params.pollMs ?? ACP_BACKEND_READY_POLL_MS;
  const deadline = Date.now() + timeoutMs;

  do {
    const backend = getAcpRuntimeBackend(params.backendId);
    if (backend) {
      try {
        if (!backend.healthy || backend.healthy()) {
          return true;
        }
      } catch {
        // Treat transient backend health probe errors like "not ready yet".
      }
    }
    await sleep(pollMs, undefined, { ref: false });
  } while (Date.now() < deadline);

  return false;
}

async function prewarmConfiguredPrimaryModel(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  log: { warn: (msg: string) => void };
}): Promise<void> {
  const { resolveAgentModelPrimaryValue } = await import("../config/model-input.js");
  const explicitPrimary = resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model)?.trim();
  if (!explicitPrimary) {
    return;
  }
  const { normalizeProviderId } = await import("../agents/provider-id.js");
  if (
    isConfiguredCliBackendPrimary({
      cfg: params.cfg,
      explicitPrimary,
      normalizeProviderId,
    })
  ) {
    return;
  }
  const [
    { resolveOpenClawAgentDir },
    { resolveAgentWorkspaceDir, resolveDefaultAgentId },
    { DEFAULT_MODEL, DEFAULT_PROVIDER },
    { isCliProvider, resolveConfiguredModelRef },
    { resolveEmbeddedAgentRuntime },
  ] = await Promise.all([
    import("../agents/agent-paths.js"),
    import("../agents/agent-scope.js"),
    import("../agents/defaults.js"),
    import("../agents/model-selection.js"),
    import("../agents/pi-embedded-runner/runtime.js"),
  ]);
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
  // Keep startup prewarm metadata-only; resolving models can import provider runtimes and block readiness.
  const { ensureOpenClawModelsJson } = await import("../agents/models-config.js");
  const agentDir = resolveOpenClawAgentDir();
  const workspaceDir =
    params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, resolveDefaultAgentId(params.cfg));
  try {
    await ensureOpenClawModelsJson(params.cfg, agentDir, {
      workspaceDir,
      providerDiscoveryProviderIds: [provider],
      providerDiscoveryTimeoutMs: STARTUP_PROVIDER_DISCOVERY_TIMEOUT_MS,
      providerDiscoveryEntriesOnly: true,
    });
  } catch (err) {
    params.log.warn(`startup model warmup failed for ${provider}/${model}: ${String(err)}`);
  }
}

async function prewarmConfiguredPrimaryModelWithTimeout(
  params: {
    cfg: OpenClawConfig;
    workspaceDir?: string;
    log: { warn: (msg: string) => void };
    timeoutMs?: number;
  },
  prewarm: typeof prewarmConfiguredPrimaryModel = prewarmConfiguredPrimaryModel,
): Promise<void> {
  let settled = false;
  const warmup = prewarm(params)
    .catch((err) => {
      params.log.warn(`startup model warmup failed: ${String(err)}`);
    })
    .finally(() => {
      settled = true;
    });
  const timeout = sleep(params.timeoutMs ?? PRIMARY_MODEL_PREWARM_TIMEOUT_MS, undefined, {
    ref: false,
  }).then(() => {
    if (!settled) {
      params.log.warn(
        `startup model warmup timed out after ${params.timeoutMs ?? PRIMARY_MODEL_PREWARM_TIMEOUT_MS}ms; continuing without waiting`,
      );
    }
  });
  await Promise.race([warmup, timeout]);
}

function schedulePrimaryModelPrewarm(
  params: {
    cfg: OpenClawConfig;
    workspaceDir?: string;
    log: { warn: (msg: string) => void };
    startupTrace?: GatewayStartupTrace;
  },
  prewarm: typeof prewarmConfiguredPrimaryModel = prewarmConfiguredPrimaryModel,
): void {
  if (shouldSkipStartupModelPrewarm()) {
    return;
  }
  void measureStartup(params.startupTrace, "sidecars.model-prewarm", () =>
    prewarmConfiguredPrimaryModelWithTimeout(
      {
        cfg: params.cfg,
        ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
        log: params.log,
      },
      prewarm,
    ),
  ).catch((err) => {
    params.log.warn(`startup model warmup failed: ${String(err)}`);
  });
}

export async function startGatewaySidecars(params: {
  cfg: OpenClawConfig;
  pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
  defaultWorkspaceDir: string;
  deps: CliDeps;
  startChannels: () => Promise<void>;
  prewarmPrimaryModel?: typeof prewarmConfiguredPrimaryModel;
  log: { warn: (msg: string) => void };
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  startupTrace?: GatewayStartupTrace;
}) {
  // Record the process boot timestamp before any channels start.  Active turns
  // written by THIS process (startedAt >= processStartedAt) are live -- not
  // stale leftovers from the previous process.  The recovery loop below uses
  // this to avoid clearing fresh turns that raced ahead of the recovery sweep.
  const processStartedAt = Date.now();

  await measureStartup(params.startupTrace, "sidecars.session-locks", async () => {
    try {
      const [{ resolveStateDir }, { resolveAgentSessionDirs }, { cleanStaleLockFiles }] =
        await Promise.all([
          import("../config/paths.js"),
          import("../agents/session-dirs.js"),
          import("../agents/session-write-lock.js"),
        ]);
      const stateDir = resolveStateDir(process.env);
      const sessionDirs = await resolveAgentSessionDirs(stateDir);
      for (const sessionsDir of sessionDirs) {
        const result = await cleanStaleLockFiles({
          sessionsDir,
          staleMs: SESSION_LOCK_STALE_MS,
          removeStale: true,
          log: { warn: (message) => params.log.warn(message) },
        });
        if (result.cleaned.length > 0) {
          const { markRestartAbortedMainSessionsFromLocks } =
            await import("../agents/main-session-restart-recovery.js");
          await markRestartAbortedMainSessionsFromLocks({
            sessionsDir,
            cleanedLocks: result.cleaned,
          });
        }
      }
    } catch (err) {
      params.log.warn(`session lock cleanup failed on startup: ${String(err)}`);
    }
  });

  await measureStartup(params.startupTrace, "sidecars.gmail-watch", async () => {
    if (params.cfg.hooks?.enabled && params.cfg.hooks.gmail?.account) {
      const { startGmailWatcherWithLogs } = await import("../hooks/gmail-watcher-lifecycle.js");
      await startGmailWatcherWithLogs({
        cfg: params.cfg,
        log: params.logHooks,
      });
    }
  });

  await measureStartup(params.startupTrace, "sidecars.gmail-model", async () => {
    if (params.cfg.hooks?.gmail?.model) {
      const [
        { DEFAULT_MODEL, DEFAULT_PROVIDER },
        { loadModelCatalog },
        { getModelRefStatus, resolveConfiguredModelRef, resolveHooksGmailModel },
      ] = await Promise.all([
        import("../agents/defaults.js"),
        import("../agents/model-catalog.js"),
        import("../agents/model-selection.js"),
      ]);
      const hooksModelRef = resolveHooksGmailModel({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
      });
      if (hooksModelRef) {
        const { provider: resolvedDefaultProvider, model: defaultModel } =
          resolveConfiguredModelRef({
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
  });

  const internalHooksConfigured = hasConfiguredInternalHooks(params.cfg);
  await measureStartup(params.startupTrace, "sidecars.internal-hooks", async () => {
    try {
      if (internalHooksConfigured) {
        const [{ setInternalHooksEnabled }, { loadInternalHooks }] = await Promise.all([
          import("../hooks/internal-hooks.js"),
          import("../hooks/loader.js"),
        ]);
        setInternalHooksEnabled(params.cfg.hooks?.internal?.enabled !== false);
        const loadedCount = await loadInternalHooks(params.cfg, params.defaultWorkspaceDir);
        if (loadedCount > 0) {
          params.logHooks.info(
            `loaded ${loadedCount} internal hook handler${loadedCount > 1 ? "s" : ""}`,
          );
        }
      }
    } catch (err) {
      params.logHooks.error(`failed to load hooks: ${String(err)}`);
    }
  });

  // Replay inbound messages captured during the previous drain.
  // Must run BEFORE startChannels() so queued events are in-memory before any
  // live inbound message can trigger a turn on the same session -- preventing a
  // race where live messages are processed ahead of drain-captured replays.
  // enqueueSystemEvent is a pure in-memory operation; no channel infrastructure
  // is required at this point.
  await measureStartup(params.startupTrace, "sidecars.pending-inbound-replay", async () => {
    try {
      const [
        { resolveStateDir },
        pendingStore,
        { enqueueSystemEvent, MAX_EVENTS },
        { sanitizeInboundSystemTags },
      ] = await Promise.all([
        import("../config/paths.js"),
        import("../infra/pending-inbound-store.js"),
        import("../infra/system-events.js"),
        import("../auto-reply/reply/inbound-text.js"),
      ]);
      const stateDir = resolveStateDir(process.env);
      const rawPending = await pendingStore.readPendingInbound(stateDir);
      // Sort by capturedAt ascending so replay order is deterministic regardless
      // of JSON key insertion order. Older messages are replayed before newer ones,
      // and per-session overflow truncation correctly discards the oldest entries.
      const pending = rawPending.slice().toSorted((a, b) => a.capturedAt - b.capturedAt);
      if (pending.length === 0) {
        return;
      }
      params.log.warn(`replaying ${pending.length} inbound message(s) captured during drain`);
      // Consume-then-process: clear only inbound entries to prevent infinite retry on crash.
      // Active turns remain intact in the shared file.
      await pendingStore.clearPendingInboundEntries(stateDir);

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
            contextKey: `pending-inbound:${entry.channel}${entry.accountId ? `:${entry.accountId}` : ""}:${entry.id}`,
          });
          params.log.warn(
            `pending-inbound: replayed ${entry.channel}:${entry.id} -> session ${sessionKey}`,
          );
        }
      }
    } catch (err) {
      params.log.warn(`pending-inbound: replay startup failed: ${String(err)}`);
    }
  });

  const skipChannels =
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS);
  await measureStartup(params.startupTrace, "sidecars.channels", async () => {
    if (!skipChannels) {
      try {
        schedulePrimaryModelPrewarm(
          {
            cfg: params.cfg,
            workspaceDir: params.defaultWorkspaceDir,
            log: params.log,
            startupTrace: params.startupTrace,
          },
          params.prewarmPrimaryModel,
        );
        await measureStartup(params.startupTrace, "sidecars.channel-start", () =>
          params.startChannels(),
        );
      } catch (err) {
        params.logChannels.error(`channel startup failed: ${String(err)}`);
      }
    } else {
      params.logChannels.info(
        "skipping channel start (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
      );
    }
  });

  // Recover stale active turns -- runs that were in-flight when the process died.
  // Notify the originating session so the user knows to resend.
  await measureStartup(params.startupTrace, "sidecars.active-turn-recovery", async () => {
    try {
      const [
        { resolveStateDir },
        pendingStore,
        { enqueueSystemEvent },
        { parseSessionThreadInfo },
        { resolveAnnounceTargetFromKey },
        { loadSessionEntry },
        { deliveryContextFromSession, mergeDeliveryContext },
        { normalizeChannelId },
      ] = await Promise.all([
        import("../config/paths.js"),
        import("../infra/pending-inbound-store.js"),
        import("../infra/system-events.js"),
        import("../config/sessions/delivery-info.js"),
        import("../agents/tools/sessions-send-helpers.js"),
        import("./session-utils.js"),
        import("../utils/delivery-context.shared.js"),
        import("../channels/plugins/index.js"),
      ]);
      const stateDir = resolveStateDir(process.env);
      const staleTurns = await pendingStore.readStaleActiveTurns(stateDir);
      if (staleTurns.length === 0) {
        return;
      }
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
        const currentEntry = await pendingStore.readActiveTurn(stateDir, turn.sessionId);
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
          await pendingStore.clearActiveTurn(stateDir, turn.sessionId);
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
    } catch (err) {
      params.log.warn(`active-turn recovery: startup failed: ${String(err)}`);
    }
  });

  const shouldDispatchGatewayStartupInternalHook =
    internalHooksConfigured || (await hasGatewayStartupInternalHookListeners());
  if (shouldDispatchGatewayStartupInternalHook) {
    setTimeout(() => {
      void import("../hooks/internal-hooks.js").then(
        ({ createInternalHookEvent, triggerInternalHook }) => {
          const hookEvent = createInternalHookEvent("gateway", "startup", "gateway:startup", {
            cfg: params.cfg,
            deps: params.deps,
            workspaceDir: params.defaultWorkspaceDir,
          });
          void triggerInternalHook(hookEvent);
        },
      );
    }, 250);
  }

  let pluginServices: PluginServicesHandle | null = null;
  await measureStartup(params.startupTrace, "sidecars.plugin-services", async () => {
    try {
      const { startPluginServices } = await import("../plugins/services.js");
      pluginServices = await startPluginServices({
        registry: params.pluginRegistry,
        config: params.cfg,
        workspaceDir: params.defaultWorkspaceDir,
      });
    } catch (err) {
      params.log.warn(`plugin services failed to start: ${String(err)}`);
    }
  });

  if (params.cfg.acp?.enabled) {
    void (async () => {
      await waitForAcpRuntimeBackendReady({ backendId: params.cfg.acp?.backend });
      const [{ getAcpSessionManager }, { ACP_SESSION_IDENTITY_RENDERER_VERSION }] =
        await Promise.all([
          import("../acp/control-plane/manager.js"),
          import("../acp/runtime/session-identifiers.js"),
        ]);
      const result = await getAcpSessionManager().reconcilePendingSessionIdentities({
        cfg: params.cfg,
      });
      if (result.checked === 0) {
        return;
      }
      params.log.warn(
        `acp startup identity reconcile (renderer=${ACP_SESSION_IDENTITY_RENDERER_VERSION}): checked=${result.checked} resolved=${result.resolved} failed=${result.failed}`,
      );
    })().catch((err) => {
      params.log.warn(`acp startup identity reconcile failed: ${String(err)}`);
    });
  }

  await measureStartup(params.startupTrace, "sidecars.memory", async () => {
    const policy = resolveGatewayMemoryStartupPolicy(params.cfg);
    if (policy.mode === "off") {
      return;
    }
    scheduleGatewayMemoryBackend({ cfg: params.cfg, log: params.log, policy });
  });

  await measureStartup(params.startupTrace, "sidecars.restart-sentinel", async () => {
    if (!shouldCheckRestartSentinel()) {
      return;
    }
    const { hasRestartSentinel } = await import("../infra/restart-sentinel.js");
    if (!(await hasRestartSentinel())) {
      return;
    }
    setTimeout(() => {
      void import("./server-restart-sentinel.js")
        .then(({ scheduleRestartSentinelWake }) =>
          scheduleRestartSentinelWake({ deps: params.deps }),
        )
        .catch((err) => {
          params.log.warn(`restart sentinel wake failed to schedule: ${String(err)}`);
        });
    }, 750);
  });

  await measureStartup(params.startupTrace, "sidecars.subagent-recovery", async () => {
    const { scheduleSubagentOrphanRecovery } = await import("../agents/subagent-registry.js");
    scheduleSubagentOrphanRecovery();
  });

  await measureStartup(params.startupTrace, "sidecars.main-session-recovery", async () => {
    const { scheduleRestartAbortedMainSessionRecovery } =
      await import("../agents/main-session-restart-recovery.js");
    scheduleRestartAbortedMainSessionRecovery();
  });

  return { pluginServices };
}

type GatewayPostAttachRuntimeDeps = {
  getGlobalHookRunner: () => Awaitable<ReturnType<typeof getGlobalHookRunner>>;
  logGatewayStartup: (params: Parameters<typeof logGatewayStartup>[0]) => Awaitable<void>;
  refreshLatestUpdateRestartSentinel: () => Awaitable<
    ReturnType<typeof refreshLatestUpdateRestartSentinel>
  >;
  scheduleGatewayUpdateCheck: (
    ...args: Parameters<typeof scheduleGatewayUpdateCheck>
  ) => Awaitable<ReturnType<typeof scheduleGatewayUpdateCheck>>;
  startGatewaySidecars: typeof startGatewaySidecars;
  startGatewayTailscaleExposure: (
    ...args: Parameters<typeof startGatewayTailscaleExposure>
  ) => ReturnType<typeof startGatewayTailscaleExposure>;
};

const defaultGatewayPostAttachRuntimeDeps: GatewayPostAttachRuntimeDeps = {
  getGlobalHookRunner: async () =>
    (await import("../plugins/hook-runner-global.js")).getGlobalHookRunner(),
  logGatewayStartup: async (params) =>
    (await import("./server-startup-log.js")).logGatewayStartup(params),
  refreshLatestUpdateRestartSentinel: async () =>
    (await import("./server-restart-sentinel.js")).refreshLatestUpdateRestartSentinel(),
  scheduleGatewayUpdateCheck: async (...args) =>
    (await import("../infra/update-startup.js")).scheduleGatewayUpdateCheck(...args),
  startGatewaySidecars,
  startGatewayTailscaleExposure: async (...args) =>
    (await import("./server-tailscale.js")).startGatewayTailscaleExposure(...args),
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
    loadStartupPlugins?: () => Awaitable<{
      pluginRegistry: PluginRegistry;
      gatewayMethods: string[];
    }>;
    onStartupPluginsLoading?: () => void;
    onStartupPluginsLoaded?: (result: {
      pluginRegistry: PluginRegistry;
      gatewayMethods: string[];
    }) => Awaitable<void>;
    getCronService?: () => PluginHookGatewayCronService | null | undefined;
    onPluginServices?: (pluginServices: PluginServicesHandle | null) => void;
    onSidecarsReady?: () => void;
    startupTrace?: GatewayStartupTrace;
    deferSidecars?: boolean;
  },
  runtimeDeps: GatewayPostAttachRuntimeDeps = defaultGatewayPostAttachRuntimeDeps,
) {
  await measureStartup(params.startupTrace, "post-attach.update-sentinel", async () => {
    try {
      await runtimeDeps.refreshLatestUpdateRestartSentinel();
    } catch (err) {
      params.log.warn(`restart sentinel refresh failed: ${String(err)}`);
    }
  });

  let pluginRegistry = params.pluginRegistry;
  if (!params.minimalTestGateway && params.loadStartupPlugins) {
    params.onStartupPluginsLoading?.();
    const loaded = await measureStartup(params.startupTrace, "plugins.runtime-post-bind", () =>
      params.loadStartupPlugins!(),
    );
    pluginRegistry = loaded.pluginRegistry;
    await params.onStartupPluginsLoaded?.(loaded);
  }

  await measureStartup(params.startupTrace, "post-attach.log", () =>
    runtimeDeps.logGatewayStartup({
      cfg: params.cfgAtStart,
      bindHost: params.bindHost,
      bindHosts: params.bindHosts,
      port: params.port,
      tlsEnabled: params.tlsEnabled,
      loadedPluginIds: pluginRegistry.plugins
        .filter((plugin) => plugin.status === "loaded")
        .map((plugin) => plugin.id),
      log: params.log,
      isNixMode: params.isNixMode,
      startupStartedAt: params.startupStartedAt,
    }),
  );

  const stopGatewayUpdateCheckPromise = params.minimalTestGateway
    ? Promise.resolve(() => {})
    : measureStartup(params.startupTrace, "post-attach.update-check", () =>
        runtimeDeps.scheduleGatewayUpdateCheck({
          cfg: params.cfgAtStart,
          log: params.log,
          isNixMode: params.isNixMode,
          onUpdateAvailableChange: (updateAvailable) => {
            const payload: GatewayUpdateAvailableEventPayload = { updateAvailable };
            params.broadcast(GATEWAY_EVENT_UPDATE_AVAILABLE, payload, { dropIfSlow: true });
          },
        }),
      );

  const tailscaleCleanupPromise = params.minimalTestGateway
    ? Promise.resolve(null)
    : params.tailscaleMode === "off" && !params.resetOnExit
      ? Promise.resolve(null)
      : measureStartup(params.startupTrace, "post-attach.tailscale", () =>
          runtimeDeps.startGatewayTailscaleExposure({
            tailscaleMode: params.tailscaleMode,
            resetOnExit: params.resetOnExit,
            port: params.port,
            controlUiBasePath: params.controlUiBasePath,
            logTailscale: params.logTailscale,
          }),
        );

  const sidecarsPromise = params.minimalTestGateway
    ? Promise.resolve({ pluginServices: null, pluginRegistry })
    : new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
        params.log.info("starting channels and sidecars...");
        const result = await measureStartup(params.startupTrace, "sidecars.total", () =>
          runtimeDeps.startGatewaySidecars({
            cfg: params.gatewayPluginConfigAtStart,
            pluginRegistry,
            defaultWorkspaceDir: params.defaultWorkspaceDir,
            deps: params.deps,
            startChannels: params.startChannels,
            log: params.log,
            logHooks: params.logHooks,
            logChannels: params.logChannels,
            startupTrace: params.startupTrace,
          }),
        );
        for (const method of STARTUP_UNAVAILABLE_GATEWAY_METHODS) {
          params.unavailableGatewayMethods.delete(method);
        }
        params.onPluginServices?.(result.pluginServices);
        params.onSidecarsReady?.();
        params.startupTrace?.mark("sidecars.ready");
        params.log.info("gateway ready");
        return { ...result, pluginRegistry };
      });

  void sidecarsPromise
    .then(async (sidecarsResult) => {
      if (params.minimalTestGateway) {
        return;
      }
      if (!hasGatewayStartHooks(sidecarsResult.pluginRegistry)) {
        return;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      const hookRunner = await runtimeDeps.getGlobalHookRunner();
      if (hookRunner?.hasHooks("gateway_start")) {
        void hookRunner
          .runGatewayStart(
            { port: params.port },
            {
              port: params.port,
              config: params.gatewayPluginConfigAtStart,
              workspaceDir: params.defaultWorkspaceDir,
              getCron: () =>
                params.getCronService?.() ??
                (params.deps.cron as PluginHookGatewayCronService | undefined),
            },
          )
          .catch((err) => {
            params.log.warn(`gateway_start hook failed: ${String(err)}`);
          });
      }
    })
    .catch((err) => {
      params.log.warn(`gateway sidecars failed to start: ${String(err)}`);
    });

  if (params.deferSidecars !== true) {
    const [stopGatewayUpdateCheck, tailscaleCleanup, sidecarsResult] = await Promise.all([
      stopGatewayUpdateCheckPromise,
      tailscaleCleanupPromise,
      sidecarsPromise,
    ]);
    return {
      stopGatewayUpdateCheck,
      tailscaleCleanup,
      pluginServices: sidecarsResult.pluginServices,
    };
  }

  const [stopGatewayUpdateCheck, tailscaleCleanup] = await Promise.all([
    stopGatewayUpdateCheckPromise,
    tailscaleCleanupPromise,
  ]);

  return { stopGatewayUpdateCheck, tailscaleCleanup, pluginServices: null };
}

export const __testing = {
  prewarmConfiguredPrimaryModel,
  prewarmConfiguredPrimaryModelWithTimeout,
  resolveGatewayMemoryStartupPolicy,
  schedulePrimaryModelPrewarm,
  shouldSkipStartupModelPrewarm,
};
