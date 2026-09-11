// Agent-database projection for live local sessions: the session row a device
// thread maps to, the transcript messages its records become, and the replay
// checkpoint that bounds what a reconnect must resend.
import { patchSessionEntryWithKey } from "../../config/sessions/session-accessor.js";
import {
  advanceLocalSessionMirrorCheckpoint,
  readLocalSessionMirrorCheckpoint,
} from "../../config/sessions/session-local-store.js";
import type { SessionLocalSource } from "../../config/sessions/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withSessionTranscriptWriteLock } from "../../plugin-sdk/session-transcript-runtime.js";
import type {
  LocalSessionRecord,
  LocalSessionSourceSessionFrame,
  LocalSessionThreadState,
} from "../../sessions/local-session-source-protocol.js";
import type { LocalSessionEnrollment } from "../../state/local-session-enrollments.js";
import { createGatewaySession } from "../session-create-service.js";
import { loadSessionEntry } from "../session-utils.js";
import type { LocalSessionBridgeDeps, LocalSessionSourceDescriptor } from "./bridge.js";

const log = createSubsystemLogger("gateway/local-sessions");

export type LiveThread = {
  sessionKey: string;
  sessionId: string;
  agentId: string;
  storePath: string;
  threadId: string;
  state: LocalSessionThreadState;
  canInput: boolean;
  reason?: string;
  earliestSeq?: number;
  acceptedSeq: number;
  /** Serializes record batches per thread so seq order survives async appends. */
  appendChain: Promise<void>;
};

export function buildLocalSessionKey(params: {
  agentId: string;
  sourceId: string;
  deviceId: string;
  ownerProfileId: string;
  threadId: string;
}): string {
  // Device and sharing owner are part of the identity: two laptops can hold the
  // same native thread id (copied or resumed session stores), and a thread
  // re-shared by a different profile must not inherit the earlier owner's row,
  // creator provenance, or access state.
  const { agentId, sourceId, deviceId, ownerProfileId, threadId } = params;
  return `agent:${agentId}:local:${sourceId}:${deviceId}:${ownerProfileId}:${threadId}`;
}

function recordToMessage(record: LocalSessionRecord, source: SessionLocalSource) {
  const idempotencyKey = `local:${source.sourceId}:${source.threadId}:${record.id}`;
  if (record.kind === "user") {
    return {
      role: "user" as const,
      content: record.text,
      timestamp: record.ts,
      idempotencyKey,
      __openclaw: {
        mirrorOrigin: "local-session",
        ...(record.clientId ? { localInputId: record.clientId } : {}),
      },
    };
  }
  const prefix =
    record.kind === "reasoning"
      ? "Thinking\n\n"
      : record.kind === "toolCall"
        ? `Tool call${record.toolName ? ` · ${record.toolName}` : ""}\n\n`
        : record.kind === "toolResult"
          ? `Tool result${record.toolName ? ` · ${record.toolName}` : ""}\n\n`
          : "";
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: `${prefix}${record.text}` }],
    timestamp: record.ts,
    api: "openclaw-local-session",
    provider: source.pluginId,
    model: "native-live",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    idempotencyKey,
  };
}

/** Resolve (creating on first sight) the session row a device thread projects into. */
export async function ensureLocalSessionThread(params: {
  cfg: ReturnType<LocalSessionBridgeDeps["getRuntimeConfig"]>;
  enrollment: LocalSessionEnrollment;
  source: LocalSessionSourceDescriptor;
  deviceId: string;
  frame: LocalSessionSourceSessionFrame;
}): Promise<LiveThread | undefined> {
  const { cfg, enrollment, source, frame } = params;
  const sessionKey = buildLocalSessionKey({
    agentId: enrollment.agentId,
    sourceId: source.sourceId,
    deviceId: params.deviceId,
    ownerProfileId: enrollment.ownerProfileId,
    threadId: frame.threadId,
  });
  const localSource: SessionLocalSource = {
    pluginId: source.pluginId,
    sourceId: source.sourceId,
    deviceId: params.deviceId,
    threadId: frame.threadId,
    enrollmentId: enrollment.enrollmentId,
  };
  let loaded = loadSessionEntry(sessionKey, { agentId: enrollment.agentId });
  if (!loaded.entry?.localSource) {
    const created = await createGatewaySession({
      cfg,
      key: sessionKey,
      agentId: enrollment.agentId,
      ...(frame.title ? { displayName: frame.title } : {}),
      commandSource: "local-session-bridge",
      initialEntry: { pluginOwnerId: source.pluginId, localSource },
      authorizedPluginId: source.pluginId,
      creation: {
        via: "plugin",
        actor: {
          type: "human",
          id: enrollment.ownerProfileId,
          label: enrollment.ownerLabel,
          source: "profile",
        },
      },
    });
    if (!created.ok) {
      log.warn(
        `local session row for ${frame.threadId} could not be created: ${created.error.message}`,
      );
      return undefined;
    }
    loaded = loadSessionEntry(sessionKey, { agentId: enrollment.agentId });
  } else if (loaded.entry.localSource.enrollmentId !== enrollment.enrollmentId) {
    // Same owner shared again (the key pins the owner): the row is theirs, but
    // its source identity must name the enrollment that currently authorizes it.
    await patchSessionEntryWithKey(
      { agentId: enrollment.agentId, sessionKey, storePath: loaded.storePath },
      () => ({ localSource }),
    );
    loaded = loadSessionEntry(sessionKey, { agentId: enrollment.agentId });
  }
  const entry = loaded.entry;
  if (!entry?.sessionId) {
    return undefined;
  }
  const checkpoint = readLocalSessionMirrorCheckpoint(
    { agentId: enrollment.agentId, sessionKey, storePath: loaded.storePath },
    entry.sessionId,
  );
  const thread: LiveThread = {
    sessionKey,
    sessionId: entry.sessionId,
    agentId: enrollment.agentId,
    storePath: loaded.storePath,
    threadId: frame.threadId,
    state: frame.state,
    canInput: frame.canInput,
    acceptedSeq: checkpoint?.acceptedSeq ?? 0,
    ...(checkpoint?.earliestSeq !== undefined ? { earliestSeq: checkpoint.earliestSeq } : {}),
    appendChain: Promise.resolve(),
  };
  return thread;
}

/** Append the records past the checkpoint; returns the last seq now durable, if any. */
export async function appendMirroredRecords(params: {
  cfg: ReturnType<LocalSessionBridgeDeps["getRuntimeConfig"]>;
  thread: LiveThread;
  source: SessionLocalSource;
  records: LocalSessionRecord[];
}): Promise<number | undefined> {
  const { thread, records, source: localSource } = params;
  const fresh = records
    .filter((record) => record.seq > thread.acceptedSeq)
    .toSorted((a, b) => a.seq - b.seq);
  const last = fresh[fresh.length - 1];
  if (!last) {
    return undefined;
  }
  const scope = {
    agentId: thread.agentId,
    sessionKey: thread.sessionKey,
    sessionId: thread.sessionId,
    storePath: thread.storePath,
    config: params.cfg,
  };
  await withSessionTranscriptWriteLock(scope, async (transcript) => {
    for (const record of fresh) {
      await transcript.appendMessage({
        message: recordToMessage(record, localSource),
        idempotencyLookup: "scan",
      });
    }
    await transcript.publishUpdate();
  });
  thread.acceptedSeq = last.seq;
  advanceLocalSessionMirrorCheckpoint(scope, {
    sessionId: thread.sessionId,
    deviceId: localSource.deviceId,
    threadId: thread.threadId,
    acceptedSeq: last.seq,
    ...(thread.earliestSeq !== undefined ? { earliestSeq: thread.earliestSeq } : {}),
  });
  return last.seq;
}
