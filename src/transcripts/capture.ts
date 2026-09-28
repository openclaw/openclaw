import { randomUUID } from "node:crypto";
import { createRuntimeConfigReader } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTranscriptArtifactText } from "../media-understanding/transcription-text.js";
import { acquirePluginCapabilityProviders } from "../plugins/capability-provider-acquisition.js";
import { runPluginCleanup } from "../plugins/plugin-instance-scope.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { createDeferredCore } from "../shared/deferred.js";
import { truncateUtf16Safe } from "../utils.js";
import { createTranscriptCaptureAppends } from "./capture-appends.js";
import {
  assertTranscriptCaptureEnabled,
  createStartupAbortScope,
  TranscriptStartError,
} from "./capture-startup.js";
import {
  createTranscriptSummaryUpdates,
  persistTranscriptSummary,
  readSummaryCaptureLiveness,
} from "./capture-summary.js";
import { resolveTranscriptsConfig } from "./config.js";
import { manualTranscriptSourceProvider } from "./manual-source.js";
import { getTranscriptSourceProvider } from "./provider-registry.js";
import type {
  TranscriptSessionDescriptor,
  TranscriptSourceLocator,
  TranscriptSourceProvider,
  TranscriptToolAction,
  TranscriptToolCaller,
  TranscriptsStartResult,
} from "./provider-types.js";
import {
  readTranscriptStringParam,
  sanitizeTranscriptSourceLocator,
  sourceFromParams,
} from "./source-locator.js";
import { TranscriptSessionConflictError, TranscriptsSummaryChangedError } from "./store-errors.js";
import type { TranscriptsStore } from "./store.js";

const ACCOUNT_ID_OUTPUT_MAX_CHARS = 64;

export function formatTranscriptAccountId(accountId: string): string {
  return JSON.stringify(truncateUtf16Safe(accountId, ACCOUNT_ID_OUTPUT_MAX_CHARS));
}

export type TranscriptsLogger = {
  warn: (message: string) => void;
};

export type TranscriptsRuntimeContext = {
  agentId?: string;
  agentChannel?: string;
  agentAccountId?: string;
  caller?: TranscriptToolCaller;
  assertCallerActive?: () => void;
  config?: OpenClawConfig;
  stateDir: string;
  logger: TranscriptsLogger;
};

type ActiveTranscriptsSession = {
  appends: ReturnType<typeof createTranscriptCaptureAppends>;
  directCapture?: { stateDir: string; drain: () => Promise<void> };
  abortStartup?: () => void;
  providerStopping?: Promise<string | undefined>;
  session: TranscriptSessionDescriptor;
  providerId: string;
  // Cleanup belongs to the admitted provider, even after registry replacement.
  stopProvider: NonNullable<TranscriptSourceProvider["stop"]>;
  releaseProvider: () => Promise<void>;
  // Diagnostic request identity, never authority. URLs retain presence only, not invitations.
  configuredSource?: Readonly<
    Pick<TranscriptSourceLocator, "providerId" | "accountId" | "guildId" | "channelId"> & {
      meetingUrl: boolean;
    }
  >;
  // Durable timestamps can collide; lifecycle cleanup must match this exact process-owned capture.
  lifecycleToken?: symbol;
  // Keep the capture reserved until provider and durable stop work both finish.
  stopping?: true;
  // Failed cleanup stays owned and cannot append until a later stop succeeds.
  cleanupPending?: true;
  phase: "starting" | "active" | "terminal" | "failed";
  summaryUpdates?: Awaited<ReturnType<typeof createTranscriptSummaryUpdates>>;
  finalization?: {
    persisted: Promise<Awaited<ReturnType<typeof persistTranscriptSummary>>>;
    released: Promise<Awaited<ReturnType<typeof persistTranscriptSummary>>>;
  };
};

// Process-local ownership shared by tool-driven and configured transcript captures.
export const activeSessions = new Map<string, ActiveTranscriptsSession>();

export type TranscriptCaptureSelection = {
  session: TranscriptSessionDescriptor;
  selector: string;
  activeCandidate: ActiveTranscriptsSession | undefined;
  selectedActive: ActiveTranscriptsSession | undefined;
  historicalRevision: string | undefined;
};

export function isTranscriptSelectionOwned(selection: TranscriptCaptureSelection): boolean {
  return activeSessions.get(selection.session.sessionId) === selection.activeCandidate;
}

export async function isTranscriptSelectionCurrent(
  selection: TranscriptCaptureSelection,
  store: TranscriptsStore,
): Promise<boolean> {
  if (!isTranscriptSelectionOwned(selection)) {
    return false;
  }
  if (selection.selectedActive) {
    return true;
  }
  if (selection.historicalRevision === undefined) {
    return false;
  }
  const revision = await store.readSummaryInputRevision(selection.session);
  return isTranscriptSelectionOwned(selection) && revision === selection.historicalRevision;
}

/** Read-only process facts; a retained stop/cleanup owner does not prove capture is armed. */
export function readTranscriptCaptureSnapshot() {
  const captures = [...activeSessions.values()]
    .filter((entry) => entry.phase !== "terminal" && entry.phase !== "failed")
    .map((entry) => ({
      session: {
        sessionId: entry.session.sessionId,
        startedAt: entry.session.startedAt,
        source: { ...entry.session.source },
      },
      providerId: entry.providerId,
      configuredSource: entry.configuredSource ? { ...entry.configuredSource } : undefined,
      lifecycleToken: entry.lifecycleToken,
      state:
        entry.phase === "active" && !entry.stopping && !entry.cleanupPending
          ? ("armed" as const)
          : ("unknown" as const),
    }));
  return [
    ...captures,
    ...readSummaryCaptureLiveness().filter(
      ({ session }) =>
        activeSessions.get(session.sessionId)?.session.startedAt !== session.startedAt,
    ),
  ];
}

export function isTranscriptSessionActive(
  session: Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">,
): boolean {
  const entry = activeSessions.get(session.sessionId);
  return entry?.session.startedAt === session.startedAt
    ? entry.phase !== "terminal"
    : readSummaryCaptureLiveness().some(
        ({ session: capture }) =>
          capture.sessionId === session.sessionId && capture.startedAt === session.startedAt,
      );
}
// Reserve ids across async provider startup so overlapping starts cannot
// replace the only cleanup owner for an existing or still-starting capture.
export const startingSessions = new Map<string, ActiveTranscriptsSession>();

export function isTranscriptSessionStarting(sessionId: string): boolean {
  return startingSessions.has(sessionId);
}

async function settleTranscriptCaptureWork(entry: ActiveTranscriptsSession): Promise<void> {
  // Capture pending append outcomes before summary shutdown can await inference.
  const settled = await Promise.allSettled([entry.appends.drain(), entry.summaryUpdates?.stop()]);
  const failures: unknown[] = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Transcript append and summary shutdown failed");
  }
}

// Retain the exact owner on failure so stop can retry persistence without touching
// the provider again. A stop in flight keeps its reservation until it settles.
export function finalizeTranscriptCapture(params: {
  ctx: TranscriptsRuntimeContext;
  store: TranscriptsStore;
  entry: ActiveTranscriptsSession;
  providerCallback?: true;
}) {
  const { entry } = params;
  entry.phase = "terminal";
  entry.session = {
    ...entry.session,
    stoppedAt: entry.session.stoppedAt ?? new Date().toISOString(),
  };
  if (!entry.finalization) {
    const persisted = (async () => {
      await settleTranscriptCaptureWork(entry);
      const assertCurrent = () => {
        if (activeSessions.get(entry.session.sessionId) !== entry) {
          throw new TranscriptsSummaryChangedError();
        }
      };
      await params.store.writeSession(entry.session, { assertCurrent });
      return await persistTranscriptSummary({
        config: resolveTranscriptsConfig(params.ctx.config?.transcripts),
        cfg: params.ctx.config,
        store: params.store,
        session: entry.session,
        assertCurrent,
      });
    })();
    const released = persisted
      .then(async (result) => {
        await entry.releaseProvider();
        if (!entry.stopping && activeSessions.get(entry.session.sessionId) === entry) {
          activeSessions.delete(entry.session.sessionId);
        }
        return result;
      })
      .catch((error: unknown) => {
        delete entry.finalization;
        params.ctx.logger.warn(
          `transcripts finalization failed session=${entry.session.sessionId}; capture ended, use transcripts stop to retry: ${String(error)}`,
        );
        throw error;
      });
    entry.finalization = { persisted, released };
    void released.catch(() => {});
  }
  const { persisted, released } = entry.finalization;
  // An inline callback can run before its stop promise is installed; check after persistence.
  return params.providerCallback
    ? persisted.then((result) => (entry.providerStopping ? result : released))
    : released;
}

export function createTranscriptSessionId(): string {
  return `transcript-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

export function resolveSourceProvider(providerId: string, ctx: TranscriptsRuntimeContext) {
  return providerId === manualTranscriptSourceProvider.id
    ? manualTranscriptSourceProvider
    : getTranscriptSourceProvider(providerId, ctx.config);
}

export async function authorizeTranscriptSource(params: {
  action: TranscriptToolAction;
  ctx: TranscriptsRuntimeContext;
  provider: TranscriptSourceProvider;
  source: TranscriptSourceLocator;
}): Promise<void> {
  params.ctx.assertCallerActive?.();
  const ownership = params.provider.accessControl;
  if (!ownership) {
    return;
  }
  const caller = params.ctx.caller;
  if (!caller) {
    throw new Error("transcripts caller authorization is unavailable");
  }
  const authorization = await ownership.authorize({
    action: params.action,
    caller,
    cfg: params.ctx.config,
    source: params.source,
  });
  params.ctx.assertCallerActive?.();
  if (!authorization.ok) {
    throw new Error(authorization.error);
  }
}

export function resolveTranscriptSourceOwnership(params: {
  ctx: TranscriptsRuntimeContext;
  operation: "import" | "start";
  provider: TranscriptSourceProvider;
  source: TranscriptSourceLocator;
  configuredLifecycle?: boolean;
}): TranscriptSourceLocator {
  const ownership = params.provider.accessControl;
  const caller = params.ctx.caller;
  let trustedAccountId: string | undefined;
  if (ownership && caller?.kind !== "operator") {
    const ownerChannel = ownership.channelId.trim().toLowerCase();
    if (!ownerChannel) {
      throw new Error(
        `transcripts provider ${params.provider.id} has an invalid account owner channel`,
      );
    }
    const channel = caller?.channel?.trim().toLowerCase();
    trustedAccountId = caller?.accountId?.trim();
    if (channel && channel !== ownerChannel) {
      throw new Error(
        `transcripts provider ${params.provider.id} can only ${params.operation} from ${ownerChannel} or a channel-less local tool`,
      );
    }
    if (channel && !trustedAccountId) {
      throw new Error(
        `transcripts provider ${params.provider.id} requires trusted account context from ${channel}`,
      );
    }
  }
  // Model input cannot redirect a same-channel capture to another configured account.
  const sourceForResolution = trustedAccountId
    ? { ...params.source, accountId: trustedAccountId }
    : params.source;
  const accountResolution = ownership?.resolveAccountId({
    cfg: params.ctx.config,
    source: sourceForResolution,
  });
  if (accountResolution && !accountResolution.ok) {
    throw new Error(accountResolution.error);
  }
  const resolvedAccountId = accountResolution
    ? accountResolution.value?.trim()
    : sourceForResolution.accountId?.trim();
  if (trustedAccountId && resolvedAccountId !== trustedAccountId) {
    throw new Error(
      `transcripts provider ${params.provider.id} could not use trusted account ${formatTranscriptAccountId(trustedAccountId)}`,
    );
  }
  const providerSource = ownership
    ? { ...sourceForResolution, accountId: resolvedAccountId }
    : sourceForResolution;
  if (params.configuredLifecycle && ownership && !providerSource.accountId?.trim()) {
    throw new Error(
      `transcripts provider ${params.provider.id} could not resolve an account for configured auto-start`,
    );
  }
  const channel = ownership?.channelId;
  if (
    params.configuredLifecycle &&
    !params.ctx.agentId &&
    params.ctx.config &&
    channel &&
    providerSource.channelId
  ) {
    providerSource.agentId = resolveAgentRoute({
      cfg: params.ctx.config,
      channel,
      accountId: providerSource.accountId,
      guildId: providerSource.guildId,
      peer: { kind: "channel", id: providerSource.channelId },
    }).agentId;
  }
  return providerSource;
}

export function stopTranscriptProviderCapture(params: {
  ctx: TranscriptsRuntimeContext;
  entry: ActiveTranscriptsSession;
  reason: string;
}): Promise<string | undefined> {
  const { entry } = params;
  if (entry.phase === "terminal") {
    return Promise.resolve(undefined);
  }
  return (entry.providerStopping ??= (async () => {
    const summariesStopped = entry.summaryUpdates?.stop();
    let error: string | undefined;
    try {
      const result = await entry.stopProvider({
        cfg: params.ctx.config,
        sessionId: entry.session.sessionId,
        source: entry.session.source,
        reason: params.reason,
      });
      error = result.ok ? undefined : result.error;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      await summariesStopped;
    }
    // Successful stops may drain final utterances. Fence only after failure, and
    // never turn an authoritative terminal notification back into pending cleanup.
    if (
      error !== undefined &&
      activeSessions.get(entry.session.sessionId) === entry &&
      entry.phase !== "terminal"
    ) {
      entry.cleanupPending = true;
    }
    return error;
  })().finally(() => {
    delete entry.providerStopping;
  }));
}

export async function startTranscripts(params: {
  ctx: TranscriptsRuntimeContext;
  store: TranscriptsStore;
  rawParams: Record<string, unknown>;
  abortSignal?: AbortSignal;
  startupWaitMs?: number;
  configuredLifecycle?: true;
  lifecycleToken?: symbol;
  existingSession?: TranscriptSessionDescriptor;
  existingSessionCondition?: Parameters<TranscriptsStore["writeSession"]>[1];
  /** Configured capture retains the original choice before supplying its selected ID. */
  sessionIdOrigin?: "generated" | "supplied";
  onCaptureEnded?: () => void;
}) {
  const getConfig = createRuntimeConfigReader(params.ctx.config ?? {});
  const assertEnabled = () =>
    assertTranscriptCaptureEnabled({ ...params.ctx, config: getConfig() });
  assertEnabled();
  if (params.abortSignal?.aborted) {
    throw new Error("transcripts start aborted");
  }
  const requestedSource = {
    ...sourceFromParams(params.rawParams),
    ...(params.ctx.agentId ? { agentId: params.ctx.agentId } : {}),
  };
  // Capture omissions before account resolution or provider handoff can replace them.
  const configuredSource = params.configuredLifecycle
    ? {
        providerId: requestedSource.providerId,
        accountId: requestedSource.accountId,
        guildId: requestedSource.guildId,
        channelId: requestedSource.channelId,
        meetingUrl: Boolean(requestedSource.meetingUrl),
      }
    : undefined;
  const acquired = await acquirePluginCapabilityProviders({
    key: "transcriptSourceProviders",
    providerId: requestedSource.providerId,
    cfg: params.ctx.config,
  });
  await using providerScope = new AsyncDisposableStack();
  providerScope.defer(acquired.release);
  const provider = acquired.providers[0];
  const startProvider = provider?.start;
  if (!provider || !startProvider) {
    throw new Error(`transcripts provider ${requestedSource.providerId} cannot start live capture`);
  }
  const providerSource = resolveTranscriptSourceOwnership({
    ctx: params.ctx,
    operation: "start",
    provider,
    source: requestedSource,
    configuredLifecycle: params.configuredLifecycle,
  });
  const agentId = params.ctx.agentId ?? providerSource.agentId;
  if (
    params.existingSession &&
    agentId !== undefined &&
    (params.existingSession.metadata?.agentId ?? "main") !== agentId
  ) {
    throw new TranscriptStartError(
      "id-conflict",
      new Error("transcripts capture belongs to a different agent; start a new capture"),
    );
  }
  if (!params.configuredLifecycle) {
    await authorizeTranscriptSource({
      action: "start",
      ctx: params.ctx,
      provider,
      source: providerSource,
    });
  }
  assertEnabled();
  const requestedSessionId = readTranscriptStringParam(params.rawParams, "sessionId");
  const session: TranscriptSessionDescriptor = {
    sessionId:
      params.existingSession?.sessionId ?? requestedSessionId ?? createTranscriptSessionId(),
    title: params.existingSession
      ? params.existingSession.title
      : readTranscriptStringParam(params.rawParams, "title"),
    source: params.existingSession?.source ?? sanitizeTranscriptSourceLocator(providerSource),
    startedAt: params.existingSession?.startedAt ?? new Date().toISOString(),
    metadata: params.existingSession
      ? params.existingSession.metadata
      : {
          ...(agentId ? { agentId } : {}),
          sessionIdOrigin:
            params.sessionIdOrigin ?? (requestedSessionId ? "supplied" : "generated"),
        },
  };
  if (activeSessions.has(session.sessionId) || startingSessions.has(session.sessionId)) {
    throw new TranscriptStartError(
      "id-conflict",
      new Error(`transcripts session already active: ${session.sessionId}`),
    );
  }
  const startupAbort = createStartupAbortScope(params.abortSignal);
  const startupSettled = createDeferredCore();
  const entry: ActiveTranscriptsSession = {
    abortStartup: startupAbort.abort,
    appends: createTranscriptCaptureAppends(() => {
      const current = activeSessions.get(session.sessionId);
      if (
        current !== entry &&
        (current !== undefined || startingSessions.get(session.sessionId) !== entry)
      ) {
        throw new Error("Transcript capture no longer owns its accepted append");
      }
    }),
    session,
    providerId: provider.id,
    stopProvider: (request) =>
      acquired.run(() =>
        runPluginCleanup(provider, () => {
          const stop = provider.stop;
          if (!stop) {
            throw new Error(`transcripts provider ${provider.id} cannot stop live capture`);
          }
          return stop.call(provider, request);
        }),
      ),
    releaseProvider: acquired.release,
    phase: "starting",
    configuredSource,
    lifecycleToken: params.lifecycleToken,
  };
  if (!params.configuredLifecycle) {
    entry.directCapture = {
      stateDir: params.ctx.stateDir,
      async drain() {
        await startupSettled.promise;
        if (activeSessions.get(session.sessionId) !== entry) {
          return;
        }
        const error = await stopTranscriptProviderCapture({
          ctx: params.ctx,
          entry,
          reason: "capture-disabled",
        });
        if (error !== undefined && entry.phase !== "terminal") {
          throw new Error(`transcripts provider cleanup failed: ${error}`);
        }
        await finalizeTranscriptCapture({ ...params, entry });
      },
    };
  }
  startingSessions.set(session.sessionId, entry);
  let admitted = false;
  let retry: TranscriptStartError["retry"];
  try {
    try {
      await params.store.writeSession(session, params.existingSessionCondition);
    } catch (error) {
      if (error instanceof TranscriptsSummaryChangedError) {
        throw new TranscriptStartError("id-conflict", error);
      }
      throw error;
    }
    admitted = true;
    try {
      assertEnabled();
      startupAbort.signal.throwIfAborted();
      entry.summaryUpdates = await createTranscriptSummaryUpdates({
        config: resolveTranscriptsConfig(params.ctx.config?.transcripts),
        cfg: params.ctx.config,
        store: params.store,
        session,
        logger: params.ctx.logger,
        assertCurrent: () => {
          if (
            activeSessions.get(session.sessionId) !== entry ||
            entry.phase !== "active" ||
            entry.stopping ||
            entry.cleanupPending
          ) {
            throw new TranscriptsSummaryChangedError();
          }
        },
      });
    } catch (error) {
      entry.phase = "failed";
      throw error;
    }
    let result: TranscriptsStartResult;
    try {
      assertEnabled();
      acquired.assertOpen();
      startupAbort.signal.throwIfAborted();
      result = await acquired.run(() =>
        startProvider.call(provider, {
          cfg: params.ctx.config,
          session: { ...session, source: { ...providerSource }, metadata: { ...session.metadata } },
          abortSignal: startupAbort.signal,
          startupWaitMs: params.startupWaitMs,
          onUtterance: async (utterance) => {
            // Reject empty speech and fence retired callbacks before any durable append.
            if (
              isTranscriptArtifactText(utterance.text) ||
              entry.phase === "terminal" ||
              entry.phase === "failed" ||
              entry.cleanupPending ||
              (entry.phase === "starting"
                ? startupAbort.signal?.aborted
                : activeSessions.get(session.sessionId) !== entry)
            ) {
              return;
            }
            await entry.appends.run((schedule) =>
              params.store.appendUtteranceForSession(session, utterance, schedule),
            );
          },
          onStatus: async (status) => {
            // Payload ids/source are descriptive, never authority over another capture.
            if (status.active || entry.phase === "failed" || entry.phase === "terminal") {
              return;
            }
            if (entry.phase !== "starting" && activeSessions.get(session.sessionId) !== entry) {
              return;
            }
            entry.phase = "terminal";
            entry.session = { ...session, stoppedAt: new Date().toISOString() };
            // Awaiting start here would deadlock providers that notify inline.
            if (activeSessions.get(session.sessionId) === entry) {
              try {
                await finalizeTranscriptCapture({ ...params, entry, providerCallback: true });
              } finally {
                if (!entry.stopping) {
                  params.onCaptureEnded?.();
                }
              }
            }
          },
        }),
      );
      if (!result.ok) {
        throw new Error(result.error);
      }
    } catch (error) {
      entry.phase = "failed";
      throw error;
    }
    // Provider failures retain cleanup ownership; only a successful result can
    // transfer a live capture to this lifecycle for abort/stop retry handling.
    // The capture now owns acquired.release, including failures that later finalization must join.
    providerScope.move();
    activeSessions.set(session.sessionId, entry);
    // Retries and reopens retain the admitted title, including its absence.
    if (!params.existingSession && !session.title) {
      const title = truncateUtf16Safe(result.session.title?.trim() ?? "", 120);
      if (title) {
        session.title = title;
        entry.session = { ...entry.session, title };
        await params.store.writeSession(entry.session);
      }
    }
    if (startupAbort.signal?.aborted) {
      entry.cleanupPending = true;
      const cleanupError = await stopTranscriptProviderCapture({
        ctx: params.ctx,
        entry,
        reason: "service-stop",
      });
      if (cleanupError !== undefined) {
        throw new Error(`transcripts start aborted; provider cleanup failed: ${cleanupError}`);
      }
      await finalizeTranscriptCapture({ ...params, entry });
      throw new Error("transcripts start aborted");
    }
    if (entry.phase === "terminal") {
      await finalizeTranscriptCapture({ ...params, entry });
      return { status: "ended" as const, session: entry.session };
    }
    entry.phase = "active";
    entry.summaryUpdates.start();
    return { status: "active" as const, session, providerId: provider.id };
  } catch (error) {
    const cleanupWasPending = entry.cleanupPending;
    // Fence new speech before waiting for already accepted capture work.
    entry.cleanupPending = true;
    let failure = error;
    let settlementFailed = false;
    try {
      await settleTranscriptCaptureWork(entry);
    } catch (settlementError) {
      settlementFailed = true;
      failure = new AggregateError(
        [error, settlementError],
        "Transcript startup and capture settlement failed",
      );
    }
    try {
      if (
        entry.phase === "starting" &&
        !cleanupWasPending &&
        activeSessions.get(session.sessionId) === entry
      ) {
        const cleanupError = await stopTranscriptProviderCapture({
          ctx: params.ctx,
          entry,
          reason: "startup-failed",
        });
        if (cleanupError !== undefined) {
          throw new Error(
            `transcripts start failed session=${session.sessionId}; provider cleanup failed: ${cleanupError}`,
            { cause: error },
          );
        }
        await finalizeTranscriptCapture({ ...params, entry });
      }
      // Failed reopening must not erase the durable stop time: the next bounded
      // attempt still needs to find this same meeting, not create an empty sibling.
      if (entry.phase === "failed") {
        const restored = params.existingSession ?? {
          ...session,
          stoppedAt: new Date().toISOString(),
        };
        await params.store.writeSession(restored);
        // Authority describes the durable tuple after restoration, including its
        // original stop time. A failed restoration or revision read grants none.
        const revision = await params.store.readSummaryInputRevision(restored);
        if (revision !== undefined) {
          retry = { session: restored, revision };
        }
      }
    } catch (cleanupError) {
      failure = settlementFailed
        ? new AggregateError([failure, cleanupError], "Transcript startup restoration failed")
        : cleanupError;
      retry = undefined;
    }
    // Cleanup and restoration failures remain terminal admissions, never authority
    // to start another provider behind retained cleanup or an unrestored tuple.
    if (!admitted && failure instanceof TranscriptSessionConflictError) {
      throw new TranscriptStartError("id-conflict", failure);
    }
    throw admitted ? new TranscriptStartError("admitted-start-failed", failure, retry) : failure;
  } finally {
    startupAbort.detach();
    try {
      await providerScope.disposeAsync();
    } finally {
      startupSettled.resolve();
      delete entry.abortStartup;
      if (startingSessions.get(session.sessionId) === entry) {
        startingSessions.delete(session.sessionId);
      }
    }
  }
}
