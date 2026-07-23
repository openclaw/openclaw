import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveTranscriptsConfig } from "../transcripts/config.js";
import type {
  TranscriptSessionDescriptor,
  TranscriptStartRequest,
  TranscriptsStartResult,
  TranscriptsStopResult,
  TranscriptUtterance,
} from "../transcripts/provider-types.js";
import { sanitizeTranscriptSourceLocator } from "../transcripts/source-locator.js";
import { TranscriptsStore } from "../transcripts/store.js";
import { summarizeTranscripts } from "../transcripts/summary.js";
import { MeetingTranscriptDeliveryError } from "./session-transcript-store.js";
import type { MeetingSessionRecord, MeetingTranscriptLine } from "./session-types.js";
import type {
  MeetingDurableTranscriptBridge,
  MeetingDurableTranscriptsOptions,
  MeetingTranscriptBridgeLogger,
} from "./transcripts-bridge.js";

const CAPTURE_INTERVAL_MS = 5_000;

type ActiveCapture<TSession extends MeetingSessionRecord> = {
  closing: boolean;
  descriptor: TranscriptSessionDescriptor;
  runCapture(task: () => Promise<void>): Promise<void>;
  session: TSession;
  timer?: ReturnType<typeof setInterval>;
  utteranceCount: number;
};

type Subscriber = {
  agentId: string;
  deliveredUtteranceIds: Set<string>;
  meetingSessionId: string;
  onStatus?: TranscriptStartRequest["onStatus"];
  onUtterance: TranscriptStartRequest["onUtterance"];
};

function descriptorForSession(
  session: MeetingSessionRecord,
  options: MeetingDurableTranscriptsOptions,
): TranscriptSessionDescriptor {
  return {
    sessionId: session.id,
    title: `${options.providerName} meeting`,
    source: sanitizeTranscriptSourceLocator({
      providerId: options.providerId,
      kind: "live-caption",
      meetingUrl: session.url,
    }),
    startedAt: session.createdAt,
    metadata: {
      agentId: session.agentId,
      meetingSessionId: session.id,
      mode: session.mode,
      participantIdentity: session.participantIdentity,
    },
  };
}

function utteranceFromLine(params: {
  line: MeetingTranscriptLine;
  session: MeetingSessionRecord;
  sequence: number;
}): TranscriptUtterance {
  return {
    id: `${params.session.id}:${params.sequence}`,
    sessionId: params.session.id,
    startedAt: params.line.at,
    speaker: params.line.speaker ? { label: params.line.speaker } : undefined,
    text: params.line.text,
    final: true,
    metadata: {
      agentId: params.session.agentId,
      meetingSessionId: params.session.id,
    },
  };
}

export function createMeetingDurableTranscriptBridge<
  TSession extends MeetingSessionRecord,
>(params: {
  logger: MeetingTranscriptBridgeLogger;
  options: MeetingDurableTranscriptsOptions;
}): MeetingDurableTranscriptBridge<TSession> {
  const config = resolveTranscriptsConfig(params.options.config);
  const stateDir = params.options.stateDir ?? resolveStateDir();
  const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  const captures = new Map<string, ActiveCapture<TSession>>();
  const pendingSubscribers = new Map<string, { agentId: string; meetingSessionId: string }>();
  const subscribers = new Map<string, Subscriber>();
  const lifecycleTasks = new Map<string, Promise<void>>();
  const tasks = new Map<string, Promise<void>>();

  const runSerial = async <T>(sessionId: string, task: () => Promise<T>): Promise<T> => {
    const previous = tasks.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(task);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    tasks.set(sessionId, settled);
    try {
      return await result;
    } finally {
      if (tasks.get(sessionId) === settled) {
        tasks.delete(sessionId);
      }
    }
  };

  const runLifecycle = async <T>(sessionId: string, task: () => Promise<T>): Promise<T> => {
    const previous = lifecycleTasks.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(task);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    lifecycleTasks.set(sessionId, settled);
    try {
      return await result;
    } finally {
      if (lifecycleTasks.get(sessionId) === settled) {
        lifecycleTasks.delete(sessionId);
      }
    }
  };

  const reportCaptureError = (sessionId: string, error: unknown) => {
    params.logger.debug?.(
      `[meeting-transcripts] capture ignored session=${sessionId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  };

  return {
    enabled: config.enabled,
    async start(session, capture) {
      await runLifecycle(session.id, async () => {
        if (!config.enabled || captures.has(session.id)) {
          return;
        }
        const descriptor = descriptorForSession(session, params.options);
        try {
          await store.writeSession(descriptor);
        } catch (error) {
          params.logger.warn(
            `[meeting-transcripts] could not start durable capture session=${session.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return;
        }
        let captureQueue = Promise.resolve();
        const runCapture = async (task: () => Promise<void>) => {
          const result = captureQueue.catch(() => {}).then(task);
          captureQueue = result.then(
            () => undefined,
            () => undefined,
          );
          return await result;
        };
        const active: ActiveCapture<TSession> = {
          closing: false,
          descriptor,
          runCapture,
          session,
          utteranceCount: 0,
        };
        const timer = setInterval(() => {
          void active
            .runCapture(capture)
            .catch((error: unknown) => reportCaptureError(session.id, error));
        }, CAPTURE_INTERVAL_MS);
        timer.unref?.();
        active.timer = timer;
        captures.set(session.id, active);
        await active
          .runCapture(capture)
          .catch((error: unknown) => reportCaptureError(session.id, error));
      });
    },
    async ingest(session, lines) {
      const active = captures.get(session.id);
      if (!active || lines.length === 0) {
        return;
      }
      await runSerial(session.id, async () => {
        for (const line of lines) {
          const sequence = active.utteranceCount;
          const utterance = utteranceFromLine({
            line,
            session,
            sequence,
          });
          await store.appendUtteranceForSession(active.descriptor, utterance);
          for (const [subscriberSessionId, subscriber] of subscribers) {
            if (
              subscriber.meetingSessionId !== session.id ||
              (utterance.id && subscriber.deliveredUtteranceIds.has(utterance.id))
            ) {
              continue;
            }
            const subscriberUtterance = {
              ...utterance,
              id: `${subscriberSessionId}:${utterance.id ?? sequence}`,
              sessionId: subscriberSessionId,
            };
            await subscriber.onUtterance(subscriberUtterance);
            if (utterance.id) {
              subscriber.deliveredUtteranceIds.add(utterance.id);
            }
          }
          active.utteranceCount += 1;
        }
      });
    },
    async stop(session, finalCapture) {
      const active = await runLifecycle(session.id, async () => {
        const current = captures.get(session.id);
        if (!current) {
          return undefined;
        }
        current.closing = true;
        if (current.timer) {
          clearInterval(current.timer);
          delete current.timer;
        }
        return current;
      });
      if (!active) {
        return false;
      }
      let deliveryError: MeetingTranscriptDeliveryError | undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await active.runCapture(finalCapture);
          deliveryError = undefined;
          break;
        } catch (error) {
          if (!(error instanceof MeetingTranscriptDeliveryError)) {
            reportCaptureError(session.id, error);
            deliveryError = undefined;
            break;
          }
          deliveryError = error;
        }
      }
      if (deliveryError) {
        throw deliveryError;
      }
      const stoppedAt = new Date().toISOString();
      const stopped = { ...active.descriptor, stoppedAt };
      try {
        await runSerial(session.id, async () => {
          await store.writeSession(stopped);
          const utterances = await store.readUtterancesForSession(stopped, {
            maxUtterances: config.maxUtterances,
          });
          await store.writeSummary(summarizeTranscripts({ session: stopped, utterances }), stopped);
          for (const [subscriberSessionId, subscriber] of subscribers) {
            if (subscriber.meetingSessionId !== session.id) {
              continue;
            }
            await subscriber.onStatus?.({
              sessionId: subscriberSessionId,
              active: false,
              message: `${params.options.providerName} meeting capture ended.`,
              source: stopped.source,
            });
            subscribers.delete(subscriberSessionId);
          }
        });
      } catch (error) {
        params.logger.warn(
          `[meeting-transcripts] could not finalize durable capture session=${session.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        throw error;
      }
      captures.delete(session.id);
      return true;
    },
    async attach(session, request): Promise<TranscriptsStartResult> {
      const active = captures.get(session.id);
      if (!config.enabled || !active || active.closing) {
        return {
          ok: false,
          error: `${params.options.providerName} meeting capture is not active.`,
        };
      }
      if (
        subscribers.has(request.session.sessionId) ||
        pendingSubscribers.has(request.session.sessionId)
      ) {
        return {
          ok: false,
          error: `transcripts session already attached: ${request.session.sessionId}`,
        };
      }
      let attached = false;
      pendingSubscribers.set(request.session.sessionId, {
        agentId: session.agentId,
        meetingSessionId: session.id,
      });
      try {
        await runSerial(session.id, async () => {
          if (captures.get(session.id) !== active || active.closing) {
            return;
          }
          const utterances = await store.readUtterancesForSession(active.descriptor);
          const deliveredUtteranceIds = new Set<string>();
          for (const utterance of utterances) {
            await request.onUtterance({
              ...utterance,
              id: `${request.session.sessionId}:${utterance.id ?? "replay"}`,
              sessionId: request.session.sessionId,
            });
            if (utterance.id) {
              deliveredUtteranceIds.add(utterance.id);
            }
          }
          subscribers.set(request.session.sessionId, {
            agentId: session.agentId,
            deliveredUtteranceIds,
            meetingSessionId: session.id,
            onStatus: request.onStatus,
            onUtterance: request.onUtterance,
          });
          try {
            await request.onStatus?.({
              sessionId: request.session.sessionId,
              active: true,
              message: `Attached to active ${params.options.providerName} meeting capture.`,
              source: active.descriptor.source,
            });
            attached = true;
          } catch (error) {
            subscribers.delete(request.session.sessionId);
            throw error;
          }
        });
      } finally {
        pendingSubscribers.delete(request.session.sessionId);
      }
      return attached
        ? { ok: true, session: request.session }
        : { ok: false, error: `${params.options.providerName} meeting capture is ending.` };
    },
    async detach(request): Promise<TranscriptsStopResult> {
      const subscriber = subscribers.get(request.sessionId);
      const pending = pendingSubscribers.get(request.sessionId);
      const owner = subscriber ?? pending;
      if (!owner) {
        return { ok: true, sessionId: request.sessionId, stoppedAt: new Date().toISOString() };
      }
      if (request.source.agentId !== owner.agentId) {
        return { ok: false, error: "transcripts session belongs to another agent" };
      }
      return await runSerial(owner.meetingSessionId, async () => {
        const current = subscribers.get(request.sessionId);
        if (!current) {
          return { ok: true, sessionId: request.sessionId, stoppedAt: new Date().toISOString() };
        }
        if (request.source.agentId !== current.agentId) {
          return { ok: false as const, error: "transcripts session belongs to another agent" };
        }
        await current.onStatus?.({
          sessionId: request.sessionId,
          active: false,
          message: `Detached from ${params.options.providerName} meeting capture.`,
          source: request.source,
        });
        subscribers.delete(request.sessionId);
        return {
          ok: true as const,
          sessionId: request.sessionId,
          stoppedAt: new Date().toISOString(),
        };
      });
    },
  };
}
