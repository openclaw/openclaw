import { isDeepStrictEqual } from "node:util";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { runPluginCleanup } from "../plugins/plugin-instance-scope.js";
import { normalizeCapabilityProviderId } from "../plugins/provider-registry-shared.js";
import { truncateUtf16Safe } from "../utils.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../utils/absolute-deadline.js";
import { createTranscriptsStore, stopTranscriptCapture } from "./capture-operations.js";
import {
  activeSessions,
  createTranscriptSessionId,
  isTranscriptSessionStarting,
  resolveSourceProvider,
  resolveTranscriptSourceOwnership,
  retainTranscriptStartRetry,
  sourceFromParams,
  startTranscripts,
  TranscriptStartError,
  type TranscriptsRuntimeContext,
} from "./capture.js";
import { hasSameTranscriptCaptureIntent } from "./config-reload.js";
import { resolveTranscriptsConfig, type ResolvedTranscriptsAutoStartConfig } from "./config.js";
import { beginConfiguredTranscriptStarts } from "./configured-start-status.js";
import type { TranscriptOccupancyWatchHandle, TranscriptSourceLocator } from "./provider-types.js";
import { sanitizeTranscriptSourceLocator } from "./source-locator.js";
import { transcriptSessionSelector } from "./store.js";

const AUTO_START_RETRY_ATTEMPTS = 12;
const AUTO_START_RETRY_MS = 5_000;
const AUTO_START_STOP_TIMEOUT_MS = 5_000;
const AUTO_START_PROVIDER_READY_TIMEOUT_MS = 30_000;
const AUTO_START_OCCUPANCY_EMPTY_GRACE_MS = 30_000;
const AUTO_START_OCCUPANCY_REOPEN_WINDOW_MS = 10 * 60_000;

type OwnedCapture = { sessionId: string; lifecycleToken: symbol };
type Timer = ReturnType<typeof setTimeout>;
type ConfiguredStartDiagnostic = Parameters<
  ReturnType<typeof beginConfiguredTranscriptStarts>["record"]
>;
type AutoStartEntryOwner = {
  index: number;
  config: OpenClawConfig | undefined;
  diagnostic?: ConfiguredStartDiagnostic;
};

function formatAutoStopDiagnostic(value: unknown): string {
  return JSON.stringify(truncateUtf16Safe(sanitizeTerminalText(formatErrorMessage(value)), 300));
}

/** Own configured captures independently of the room's provider connection. */
export function createTranscriptsAutoStartService(
  ctx: TranscriptsRuntimeContext,
  getConfig?: () => OpenClawConfig | undefined,
) {
  const entries = new Set<{
    config: ResolvedTranscriptsAutoStartConfig;
    owner: AutoStartEntryOwner;
    providerId: string | undefined;
    stop: (strict: boolean) => Promise<boolean>;
    pendingStarts: Set<Promise<void>>;
    stopping?: Promise<boolean>;
  }>();
  const guildOwners = new Map<string, { index: number }>();
  // Admission history is service-wide; each entry retains only its physical cleanup work.
  const consumedSessions = new Map<string, symbol>();
  let stopped = false;
  let diagnostics: ReturnType<typeof beginConfiguredTranscriptStarts> | undefined;
  return {
    start(config = ctx.config, pausedProviders?: ReadonlySet<string>) {
      if (stopped) {
        return;
      }
      diagnostics = beginConfiguredTranscriptStarts(config?.transcripts);
      const resolved = resolveTranscriptsConfig(config?.transcripts);
      if (!resolved.enabled) {
        return;
      }
      const retained = new Set(entries);
      for (const [index, entry] of resolved.autoStart.entries()) {
        const current = [...retained].find(
          (candidate) =>
            isDeepStrictEqual(candidate.config, entry) ||
            (candidate.owner.index === index &&
              hasSameTranscriptCaptureIntent(
                candidate.owner.config?.transcripts,
                config?.transcripts,
              )),
        );
        if (current) {
          current.owner.index = index;
          current.owner.config = config;
          current.config = entry;
          // Reindex the retained owner's last produced fact into the new config snapshot.
          if (current.owner.diagnostic) {
            current.owner.diagnostic[0] = index;
            diagnostics.record(...current.owner.diagnostic);
          }
          retained.delete(current);
          continue;
        }
        const providerId = normalizeCapabilityProviderId(entry.providerId);
        if (providerId && pausedProviders?.has(providerId)) {
          continue;
        }
        const owner: AutoStartEntryOwner = { index, config };
        entries.add({
          config: entry,
          owner,
          providerId,
          ...startTranscriptsAutoStartEntry(
            { ...ctx, config },
            entry,
            owner,
            guildOwners,
            consumedSessions,
            (lifecycleToken, diagnostic) => {
              owner.diagnostic = [owner.index, lifecycleToken, diagnostic];
              diagnostics?.record(...owner.diagnostic);
            },
            getConfig ?? (() => owner.config),
          ),
        });
      }
    },
    async stop(providerIds?: ReadonlySet<string>) {
      stopped ||= providerIds === undefined;
      if (stopped) {
        diagnostics?.clear();
      }
      const selected = [...entries].filter(
        (entry) => !providerIds || (entry.providerId && providerIds.has(entry.providerId)),
      );
      const stopping = Promise.allSettled(
        selected.map(async (entry) => {
          // A caller's deadline never discards or duplicates in-flight provider cleanup.
          entry.stopping ??= entry.stop(providerIds !== undefined).finally(() => {
            entry.stopping = undefined;
          });
          if (!(await entry.stopping)) {
            if (providerIds) {
              throw new Error("Transcript auto-start capture cleanup remains pending");
            }
            return;
          }
          entries.delete(entry);
          for (const [key, owner] of guildOwners) {
            if (owner === entry.owner) {
              guildOwners.delete(key);
            }
          }
        }),
      );
      const settled = await awaitWithinDeadline(
        () => Promise.allSettled(selected.flatMap((entry) => Array.from(entry.pendingStarts))),
        Date.now() + AUTO_START_STOP_TIMEOUT_MS,
      );
      if (settled === ABSOLUTE_DEADLINE_EXPIRED) {
        void stopping.then((results) => {
          for (const result of results) {
            if (result.status === "rejected") {
              ctx.logger.warn(
                `transcripts autoStart cleanup failed: ${formatAutoStopDiagnostic(result.reason)}`,
              );
            }
          }
        });
        if (providerIds) {
          throw new Error(
            "Transcript auto-start stop timed out waiting for pending starts; retry after the provider finishes stopping",
          );
        }
        ctx.logger.warn(`transcripts autoStart stop timed out waiting for pending starts`);
        return;
      }
      // Only startup is deadline-bound; already acquired cleanup/finalization still joins fully.
      const errors = (await stopping).flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) {
        throw new AggregateError(errors, "Transcript auto-start cleanup failed");
      }
    },
  };
}

function startTranscriptsAutoStartEntry(
  ctx: TranscriptsRuntimeContext,
  entry: ResolvedTranscriptsAutoStartConfig,
  entryOwner: AutoStartEntryOwner,
  guildOwners: Map<string, { index: number }>,
  consumedSessions: Map<string, symbol>,
  recordDiagnostic: (lifecycleToken: symbol, diagnostic?: ConfiguredStartDiagnostic[2]) => void,
  getConfig: () => OpenClawConfig | undefined,
) {
  let stopped = false;
  const store = createTranscriptsStore(ctx);
  const timers = new Set<Timer>();
  let watcher: TranscriptOccupancyWatchHandle | undefined;
  let watchRegistration: Promise<void> | undefined;
  const startedSessions = new Map<string, symbol>();
  const controllers = new Set<AbortController>();
  const pendingStarts = new Set<Promise<void>>();
  let stopping: Promise<void> | undefined;
  let startRetry: ReturnType<typeof retainTranscriptStartRetry> | undefined;
  const clearRetry = () => {
    startRetry?.release();
    startRetry = undefined;
  };
  const futureTitle = () => {
    const latest = getConfig();
    const config = hasSameTranscriptCaptureIntent(
      entryOwner.config?.transcripts,
      latest?.transcripts,
    )
      ? latest
      : entryOwner.config;
    return resolveTranscriptsConfig(config?.transcripts).autoStart[entryOwner.index]?.title;
  };
  const terminalDiagnostic = (error: unknown) =>
    error instanceof TranscriptStartError && !error.retry ? error.code : undefined;
  const schedule = (run: () => void, delay: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, delay);
    timer.unref();
    timers.add(timer);
    return timer;
  };
  const cancel = (timer: Timer | undefined) => {
    if (timer) {
      clearTimeout(timer);
      timers.delete(timer);
    }
  };
  const runPending = (run: (controller: AbortController) => Promise<void>) => {
    const controller = new AbortController();
    controllers.add(controller);
    const task = run(controller).finally(() => {
      controllers.delete(controller);
      pendingStarts.delete(task);
    });
    pendingStarts.add(task);
    return task;
  };
  const ownsCapture = (capture: OwnedCapture) =>
    activeSessions.get(capture.sessionId)?.lifecycleToken === capture.lifecycleToken;
  const forgetCapture = (capture: OwnedCapture) => {
    if (
      !ownsCapture(capture) &&
      startedSessions.get(capture.sessionId) === capture.lifecycleToken
    ) {
      startedSessions.delete(capture.sessionId);
      if (consumedSessions.get(capture.sessionId) === capture.lifecycleToken) {
        consumedSessions.delete(capture.sessionId);
      }
    }
  };

  const stopCapture = async (capture: OwnedCapture, requireProviderStop = false) => {
    const warnings: string[] = [];
    try {
      const active = activeSessions.get(capture.sessionId);
      if (!active || active.lifecycleToken !== capture.lifecycleToken) {
        forgetCapture(capture);
        return;
      }
      const details = await stopTranscriptCapture({
        ctx,
        store,
        selection: {
          session: active.session,
          selector: transcriptSessionSelector(active.session),
          activeCandidate: active,
          selectedActive: active,
          historicalRevision: undefined,
        },
      });
      if (details.status === "skipped") {
        if (requireProviderStop && details.reason !== "inactive") {
          throw new Error(`Transcripts session stop still in progress: ${capture.sessionId}`);
        }
        forgetCapture(capture);
        return;
      }
      // Log diagnostics only, never the tool content or captured meeting notes.
      if (typeof details.summaryExportError === "string") {
        warnings.push(
          `summary saved; export failed intendedSummaryPath=${formatAutoStopDiagnostic(details.intendedSummaryPath)}: ${formatAutoStopDiagnostic(details.summaryExportError)}. Correct the export destination, then run openclaw transcripts path <session> or openclaw transcripts show <session>.`,
        );
      }
      if (typeof details.providerStopError === "string") {
        warnings.push(
          `provider stop failed: ${formatAutoStopDiagnostic(details.providerStopError)}. Check the provider capture status and connection.`,
        );
      }
    } catch (error) {
      if (requireProviderStop) {
        throw error;
      }
      warnings.push(`stop failed: ${formatAutoStopDiagnostic(error)}`);
    }
    for (const warning of warnings) {
      ctx.logger.warn(
        `transcripts autoStart session=${formatAutoStopDiagnostic(capture.sessionId)}: ${warning}`,
      );
    }
    forgetCapture(capture);
  };

  const startCapture = async (
    capture: OwnedCapture,
    params: Pick<
      Parameters<typeof startTranscripts>[0],
      | "store"
      | "rawParams"
      | "abortSignal"
      | "existingSession"
      | "existingSessionCondition"
      | "onCaptureEnded"
      | "sessionIdOrigin"
    >,
  ) => {
    recordDiagnostic(capture.lifecycleToken, "starting");
    try {
      const retry = startRetry;
      const result = await startTranscripts({
        ...params,
        existingSession: retry?.session ?? params.existingSession,
        existingSessionCondition: retry
          ? { expectedInputRevision: retry.revision, assertCurrent: retry.assertCurrent }
          : params.existingSessionCondition,
        ctx,
        startupWaitMs: AUTO_START_PROVIDER_READY_TIMEOUT_MS,
        configuredLifecycle: true,
        lifecycleToken: capture.lifecycleToken,
        rawParams: { ...params.rawParams, sessionId: capture.sessionId },
      });
      clearRetry();
      if (!stopped) {
        recordDiagnostic(capture.lifecycleToken, result.status === "ended" ? "ended" : undefined);
      }
      return result;
    } catch (error) {
      if (error instanceof TranscriptStartError) {
        clearRetry();
        if (!stopped && error.retry) {
          startRetry = retainTranscriptStartRetry(ctx, error.retry);
        }
      }
      throw error;
    } finally {
      // Per-entry shutdown keeps joining startup after its caller's deadline, then
      // cleans this exact owner once; do not issue a second stop from this continuation.
      if (ownsCapture(capture)) {
        startedSessions.set(capture.sessionId, capture.lifecycleToken);
        consumedSessions.set(capture.sessionId, capture.lifecycleToken);
      }
    }
  };

  const startContinuous = (attempt: number) => {
    if (stopped) {
      return;
    }
    const capture: OwnedCapture = {
      sessionId: startRetry?.session.sessionId ?? entry.sessionId ?? createTranscriptSessionId(),
      lifecycleToken: Symbol(entry.sessionId),
    };
    void runPending(async (controller) => {
      try {
        // A consumed fixed ID stays suppressed after capture ends; settle the
        // duplicate's retry diagnostic without reopening its saved history.
        if (consumedSessions.has(entry.sessionId ?? "")) {
          throw new TranscriptStartError(
            "id-conflict",
            new Error("transcripts session already started by this service"),
          );
        }
        await startCapture(capture, {
          store,
          sessionIdOrigin: entry.sessionId ? "supplied" : "generated",
          abortSignal: controller.signal,
          rawParams: { ...entry, title: futureTitle() },
        });
      } catch (error) {
        if (stopped) {
          return;
        }
        // Only the exact failed provider attempt may retain retry authority.
        const terminal = terminalDiagnostic(error);
        const cleanupPending = ownsCapture(capture);
        if (terminal || cleanupPending || attempt >= AUTO_START_RETRY_ATTEMPTS) {
          clearRetry();
          const diagnostic = terminal ?? "start-failed";
          recordDiagnostic(capture.lifecycleToken, diagnostic);
          ctx.logger.warn(
            `transcripts autoStart source ${entryOwner.index + 1}: ${diagnostic}. Check Meeting capture health in Settings.`,
          );
        } else {
          recordDiagnostic(capture.lifecycleToken, "retrying");
          schedule(() => startContinuous(attempt + 1), AUTO_START_RETRY_MS);
        }
      }
    });
  };

  const watchEntry = () => {
    let occupied = false;
    let ready = false;
    let capture: OwnedCapture | undefined;
    let starting: Promise<void> | undefined;
    let startController: AbortController | undefined;
    let emptyTimer: Timer | undefined;
    let retryTimer: Timer | undefined;
    let source: TranscriptSourceLocator;
    let diagnosticToken = Symbol(`transcripts occupancy ${entryOwner.index}`);
    const label = () => `transcripts autoStart[${entryOwner.index}] provider=${entry.providerId}`;
    const retry = (
      run: () => void,
      attempt: number,
      error: unknown,
      phase: "watch" | "capture",
    ) => {
      if (stopped) {
        return;
      }
      const terminal = terminalDiagnostic(error);
      if (terminal || attempt >= AUTO_START_RETRY_ATTEMPTS) {
        clearRetry();
        recordDiagnostic(diagnosticToken, terminal ?? "start-failed");
        ctx.logger.warn(
          `${label()} failed: ${formatAutoStopDiagnostic(error)}; check the entry and provider connection. ${phase === "watch" ? "Reload the provider plugin to retry occupancy watching." : "Waiting for the next occupancy transition."}`,
        );
        return;
      }
      recordDiagnostic(diagnosticToken, "retrying");
      cancel(retryTimer);
      retryTimer = schedule(run, AUTO_START_RETRY_MS);
    };
    const begin = (attempt: number) => {
      if (stopped || !ready || !occupied || starting || stopping) {
        return;
      }
      if (
        capture &&
        ownsCapture(capture) &&
        activeSessions.get(capture.sessionId)?.phase === "active"
      ) {
        return;
      }
      starting = runPending(async (controller) => {
        startController = controller;
        try {
          // A terminal persistence failure retains its old owner. Retire it through
          // the same stop path before reopening; never append behind finalization.
          if (capture) {
            await stopCapture(capture);
            if (ownsCapture(capture)) {
              throw new Error("previous capture still awaits finalization");
            }
          }
          if (stopped || !occupied || controller.signal.aborted) {
            return;
          }
          const now = Date.now();
          const retained = startRetry;
          const recent = retained
            ? { session: retained.session, inputRevision: retained.revision }
            : await store.readRecentStoppedSession(
                sanitizeTranscriptSourceLocator(source),
                new Date(now - AUTO_START_OCCUPANCY_REOPEN_WINDOW_MS).toISOString(),
                new Date(now).toISOString(),
              );
          if (stopped || !occupied || controller.signal.aborted) {
            return;
          }
          const candidate =
            recent &&
            recent.session.metadata?.sessionIdOrigin === "generated" &&
            (!(source.agentId ?? ctx.agentId) ||
              (recent.session.metadata?.agentId ?? "main") === (source.agentId ?? ctx.agentId)) &&
            !activeSessions.has(recent.session.sessionId) &&
            !isTranscriptSessionStarting(recent.session.sessionId) &&
            !consumedSessions.has(recent.session.sessionId)
              ? recent
              : undefined;
          const owned = {
            sessionId: candidate?.session.sessionId ?? createTranscriptSessionId(),
            lifecycleToken: Symbol(label()),
          };
          diagnosticToken = owned.lifecycleToken;
          capture = owned;
          const result = await startCapture(owned, {
            store,
            sessionIdOrigin: "generated",
            abortSignal: controller.signal,
            existingSession: candidate?.session,
            existingSessionCondition: candidate
              ? {
                  expectedInputRevision: candidate.inputRevision,
                  assertCurrent: () => {
                    if (stopped || !occupied || controller.signal.aborted || capture !== owned) {
                      throw new TranscriptStartError(
                        "id-conflict",
                        new Error("transcript occupancy changed before reopening"),
                      );
                    }
                  },
                }
              : undefined,
            rawParams: {
              ...entry,
              ...source,
              title: futureTitle(),
            },
            onCaptureEnded: () => {
              if (capture !== owned || stopped || !occupied) {
                return;
              }
              forgetCapture(owned);
              cancel(retryTimer);
              retryTimer = schedule(() => begin(1), AUTO_START_RETRY_MS);
            },
          });
          if (result.status === "ended") {
            throw new Error("capture ended during startup");
          }
        } catch (error) {
          if (capture && !ownsCapture(capture)) {
            capture = undefined;
          }
          if (occupied && !controller.signal.aborted) {
            retry(() => begin(attempt + 1), attempt, error, "capture");
          }
        } finally {
          startController = undefined;
        }
      }).finally(() => {
        starting = undefined;
      });
    };
    const end = () => {
      if (stopping) {
        return;
      }
      stopping = (async () => {
        startController?.abort();
        await starting;
        // Failed startup may restore its candidate while settling. A new
        // occupancy episode must consult the durable reopen window again.
        clearRetry();
        if (capture) {
          await stopCapture(capture);
          if (!ownsCapture(capture)) {
            capture = undefined;
          }
        }
        // A cancelled attempt settles only after its capture cleanup owner releases.
        if (!capture) {
          recordDiagnostic(diagnosticToken);
        }
      })().finally(() => {
        stopping = undefined;
        // Arrival during an awaited stop still gets an episode once the old
        // owner has released, rather than silently losing that transition.
        if (occupied && !stopped) {
          begin(1);
        }
      });
    };
    const arm = (attempt: number) => {
      if (stopped) {
        return;
      }
      watchRegistration = runPending(async (controller) => {
        try {
          const provider = resolveSourceProvider(entry.providerId, ctx);
          if (!provider) {
            throw new Error("provider is not available");
          }
          if (!provider.watchOccupancy) {
            recordDiagnostic(diagnosticToken, "start-failed");
            ctx.logger.warn(
              `${label()} cannot report occupancy; remove whenOccupied or select a provider that supports occupancy watching.`,
            );
            return;
          }
          clearRetry();
          source = resolveTranscriptSourceOwnership({
            ctx,
            operation: "start",
            provider,
            source: { ...sourceFromParams(entry), providerId: provider.id },
            configuredLifecycle: true,
          }).source;
          // Guild voice transports own one connection per account. Claim before
          // awaiting readiness so later entries cannot displace the first room.
          if (source.guildId) {
            const key = JSON.stringify([provider.id, source.accountId, source.guildId]);
            const owner = guildOwners.get(key);
            if (owner !== undefined && owner !== entryOwner) {
              recordDiagnostic(diagnosticToken, "start-failed");
              ctx.logger.warn(
                `${label()} skipped: autoStart[${owner.index}] already owns this provider account and guild; configure only one whenOccupied entry per account and guild.`,
              );
              return;
            }
            guildOwners.set(key, entryOwner);
          }
          const result = await provider.watchOccupancy({
            cfg: ctx.config,
            source,
            abortSignal: controller.signal,
            startupWaitMs: AUTO_START_PROVIDER_READY_TIMEOUT_MS,
            onOccupied: () => {
              if (stopped || controller.signal.aborted || occupied) {
                return;
              }
              occupied = true;
              cancel(emptyTimer);
              cancel(retryTimer);
              clearRetry();
              begin(1);
            },
            onEmpty: () => {
              if (stopped || controller.signal.aborted || !occupied) {
                return;
              }
              occupied = false;
              cancel(retryTimer);
              cancel(emptyTimer);
              emptyTimer = schedule(end, AUTO_START_OCCUPANCY_EMPTY_GRACE_MS);
            },
          });
          if (!result.ok) {
            throw new Error(result.error);
          }
          watcher = result.value;
          if (stopped) {
            return;
          }
          ready = true;
          // An empty room still settles the watch retry before its next capture attempt.
          recordDiagnostic(diagnosticToken);
          // Initial occupancy can be reported inline by watchOccupancy. Admit
          // capture only after subscription succeeds, not after a failed watch.
          begin(1);
        } catch (error) {
          controller.abort();
          occupied = false;
          cancel(emptyTimer);
          retry(() => arm(attempt + 1), attempt, error, "watch");
        }
      });
    };
    arm(1);
  };

  if (entry.whenOccupied) {
    watchEntry();
  } else {
    startContinuous(1);
  }
  const stop = async (strict: boolean) => {
    stopped = true;
    clearRetry();
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
    for (const controller of controllers) {
      controller.abort();
    }
    // Join late subscriptions without letting capture startup hold an acquired watcher open.
    await watchRegistration;
    const failures: unknown[] = [];
    if (watcher) {
      const current = watcher;
      try {
        await runPluginCleanup(current.stop, () => current.stop());
        watcher = undefined;
      } catch (error) {
        failures.push(error);
      }
    }
    await Promise.allSettled(pendingStarts);
    await Promise.allSettled(stopping ? [stopping] : []);
    for (const [sessionId, lifecycleToken] of startedSessions) {
      try {
        await stopCapture({ sessionId, lifecycleToken }, strict);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Transcript entry cleanup failed");
    }
    return startedSessions.size === 0;
  };
  return { stop, pendingStarts };
}
