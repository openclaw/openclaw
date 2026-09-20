import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTranscriptArtifactText } from "../media-understanding/transcription-text.js";
import { runWithGatewayDetachedWorkAdmission } from "../process/gateway-work-admission.js";
import { getAsyncWorkSignal, runInDetachedAsyncContext } from "../shared/async-work-scope.js";
import type { resolveTranscriptsConfig } from "./config.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";
import { TranscriptsSummaryChangedError } from "./store-errors.js";
import type { TranscriptSummarySnapshot, TranscriptsStore } from "./store.js";
import { summarizeTranscriptsWithModel } from "./summary-model.js";
import { runSummaryWork } from "./summary-work.js";
import { summarizeTranscripts } from "./summary.js";

type SummaryParams = {
  config: ReturnType<typeof resolveTranscriptsConfig>;
  cfg?: OpenClawConfig;
  store: TranscriptsStore;
  session: TranscriptSessionDescriptor;
  expectedInputRevision?: string;
  assertCurrent?: () => void;
  allowAppends?: boolean;
};
type SummaryLane = {
  tail: Promise<void>;
  pending: number;
  generation: number;
  abort?: AbortController;
  live?: {
    lastSequence: number;
    stop(): Promise<void>;
    capture?: { session: TranscriptSessionDescriptor; isActive(): boolean };
  };
};
const lanes = new Map<string, SummaryLane>();
const LIVE_SUMMARY_INTERVAL_MS = 5 * 60_000;

/** Read source-owned capture facts; timer and inference state do not imply liveness. */
export function readSummaryCaptureLiveness() {
  return [...lanes.values()].flatMap(({ live }) => {
    if (!live?.capture?.isActive()) {
      return [];
    }
    const { session } = live.capture;
    return [
      {
        session: {
          sessionId: session.sessionId,
          startedAt: session.startedAt,
          source: { ...session.source },
        },
        providerId: session.source.providerId,
        configuredSource: undefined,
        lifecycleToken: undefined,
        state: "armed" as const,
      },
    ];
  });
}

function laneFor(params: Pick<SummaryParams, "store" | "session">) {
  const key = params.store.summaryScope(params.session);
  let lane = lanes.get(key);
  if (!lane) {
    lane = { tail: Promise.resolve(), pending: 0, generation: 0 };
    lanes.set(key, lane);
  }
  return { key, lane };
}

function enqueueSummary<T>(
  params: SummaryParams,
  run: (lane: SummaryLane, owned: SummaryParams) => Promise<T>,
) {
  const { key, lane } = laneFor(params);
  const generation = lane.generation;
  const owned = {
    ...params,
    assertCurrent: () => {
      if (lane.generation !== generation) {
        throw new TranscriptsSummaryChangedError();
      }
      params.assertCurrent?.();
    },
  };
  lane.pending++;
  const parentSignal = getAsyncWorkSignal();
  const result = lane.tail.then(() => runSummaryWork(parentSignal, () => run(lane, owned)));
  lane.tail = result
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      lane.pending--;
      if (!lane.pending && !lane.live && lanes.get(key) === lane) {
        lanes.delete(key);
      }
    });
  return result;
}

async function readTranscriptSummary(
  params: SummaryParams & { snapshot: TranscriptSummarySnapshot; abortSignal?: AbortSignal },
) {
  params.abortSignal?.throwIfAborted();
  const utterances = params.snapshot.utterances;
  const agentId = params.session.metadata?.agentId;
  try {
    if (params.cfg) {
      const modeled = await summarizeTranscriptsWithModel({
        cfg: params.cfg,
        agentId:
          typeof agentId === "string" && agentId.trim()
            ? agentId
            : resolveDefaultAgentId(params.cfg),
        session: params.session,
        utterances,
        abortSignal: params.abortSignal,
        assertCurrent: params.assertCurrent,
      });
      params.abortSignal?.throwIfAborted();
      if (modeled) {
        return modeled;
      }
    }
  } catch {
    params.abortSignal?.throwIfAborted();
    // Historical captures may have no resolvable agent; they still get notes.
  }
  return summarizeTranscripts({ session: params.session, utterances });
}

async function persistSnapshot(
  params: SummaryParams,
  lane: SummaryLane,
  snapshot: TranscriptSummarySnapshot,
) {
  params.assertCurrent?.();
  if (
    (params.allowAppends && snapshot.stoppedAt !== undefined) ||
    (params.expectedInputRevision !== undefined &&
      snapshot.inputRevision !== params.expectedInputRevision)
  ) {
    throw new TranscriptsSummaryChangedError();
  }
  const abort = new AbortController();
  lane.abort = abort;
  try {
    const summary = await readTranscriptSummary({ ...params, snapshot, abortSignal: abort.signal });
    const intendedSummaryPath = await params.store.writeSummary(
      summary,
      params.session,
      undefined,
      () => {
        abort.signal.throwIfAborted();
        params.assertCurrent?.();
        params.store.assertSummarySnapshotCurrent(
          params.session,
          snapshot,
          params.allowAppends === true,
        );
      },
    );
    if (lane.live) {
      lane.live.lastSequence = snapshot.nextSequence;
    }
    return { summary, intendedSummaryPath };
  } finally {
    if (lane.abort === abort) {
      delete lane.abort;
    }
  }
}

async function readCurrentSnapshot(params: SummaryParams) {
  params.assertCurrent?.();
  const snapshot = await params.store.readSummarySnapshot(
    params.session,
    params.config.maxUtterances,
  );
  params.assertCurrent?.();
  if (!snapshot) {
    throw new TranscriptsSummaryChangedError();
  }
  return snapshot;
}

export function persistTranscriptSummary(params: SummaryParams) {
  return enqueueSummary(params, async (lane, owned) =>
    persistSnapshot(owned, lane, await readCurrentSnapshot(owned)),
  );
}

/** Missing-note requests share the capture lane and never replace saved notes. */
export function ensureTranscriptSummary(params: SummaryParams) {
  return enqueueSummary(params, async (lane, owned) => {
    owned.assertCurrent?.();
    const stored = await params.store.readSummary(params.session);
    owned.assertCurrent?.();
    if (stored.summary || stored.markdown !== undefined) {
      return;
    }
    const snapshot = await readCurrentSnapshot(owned);
    if (snapshot.utterances.some((utterance) => !isTranscriptArtifactText(utterance.text))) {
      await persistSnapshot(owned, lane, snapshot);
    }
  });
}

/** Capture lifecycles start and retire this owner; reads never generate notes. */
export async function createTranscriptSummaryUpdates(
  params: SummaryParams & {
    logger: { warn(message: string): void };
    isCaptureActive?: () => boolean;
  },
) {
  const { key, lane } = laneFor(params);
  // Reserve the lane across startup reads and the previous owner's retirement.
  lane.pending++;
  try {
    await lane.live?.stop();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingUpdate: Promise<void> | undefined;
    const lifetime = new AbortController();
    const retire = () => {
      stopped = true;
      lifetime.abort();
      clearTimeout(timer);
      timer = undefined;
      if (lane.live === owner) {
        lane.generation++;
        delete lane.live;
        lane.abort?.abort(new TranscriptsSummaryChangedError());
      }
    };
    const owner = {
      // Stored notes have no coverage watermark; resumed captures need one fresh pass.
      lastSequence: 0,
      capture: params.isCaptureActive
        ? { session: params.session, isActive: params.isCaptureActive }
        : undefined,
      start() {
        if (stopped || timer !== undefined || pendingUpdate) {
          return;
        }
        timer = setTimeout(() => {
          timer = undefined;
          pendingUpdate = runInDetachedAsyncContext(() =>
            runWithGatewayDetachedWorkAdmission(
              update,
              "transcripts:live-summary",
              lifetime.signal,
            ),
          )
            .catch((error: unknown) => {
              if (!stopped) {
                params.logger.warn(
                  `transcripts live summary failed session=${params.session.sessionId}: ${String(error)}`,
                );
              }
            })
            .finally(() => {
              pendingUpdate = undefined;
              owner.start();
            });
        }, LIVE_SUMMARY_INTERVAL_MS);
        timer.unref();
      },
      async stop() {
        retire();
        await pendingUpdate;
        await lane.tail;
        if (!lane.pending && !lane.live && lanes.get(key) === lane) {
          lanes.delete(key);
        }
      },
    };
    const update = async () => {
      let attemptedSequence: number | undefined;
      try {
        await enqueueSummary(params, async (currentLane, owned) => {
          if (stopped || currentLane.live !== owner) {
            return;
          }
          owned.assertCurrent?.();
          const snapshot = await params.store.readSummarySnapshot(
            params.session,
            params.config.maxUtterances,
          );
          if (!snapshot || snapshot.nextSequence <= owner.lastSequence) {
            return;
          }
          attemptedSequence = snapshot.nextSequence;
          await persistSnapshot({ ...owned, allowAppends: true }, currentLane, snapshot);
        });
      } catch (error) {
        if (!stopped && !(error instanceof TranscriptsSummaryChangedError)) {
          throw error;
        }
        if (!stopped && attemptedSequence !== undefined) {
          // A superseding write settles this prefix; later speech still gets new notes.
          owner.lastSequence = Math.max(owner.lastSequence, attemptedSequence);
        }
        try {
          params.assertCurrent?.();
        } catch {
          retire();
        }
      }
    };
    lane.live = owner;
    lane.generation++;
    try {
      const initial = await params.store.readSummarySnapshot(
        params.session,
        params.config.maxUtterances,
      );
      if (!initial || stopped || lane.live !== owner) {
        throw new TranscriptsSummaryChangedError();
      }
      return owner;
    } catch (error) {
      await owner.stop();
      throw error;
    }
  } finally {
    lane.pending--;
    if (!lane.pending && !lane.live && lanes.get(key) === lane) {
      lanes.delete(key);
    }
  }
}
