import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import {
  prepareCompactionPlan,
  renderPreparedCompactionRows,
} from "../../agents/embedded-agent-runner/prepared-compaction-plan.js";
import { prepareCompactionReplay } from "../../agents/embedded-agent-runner/prepared-compaction-replay.js";
import { SessionManagerCore } from "../../agents/sessions/session-manager-core.js";
import type { SessionEntry } from "../../agents/sessions/session-manager-types.js";
import { sessionManagerReadTranscriptBranch } from "../../agents/sessions/session-manager-view-types.js";
import type { WorkerTaskChannel } from "../../infra/worker-task-server.js";
import { bindCacheTtlProjectionPrefixes } from "./session-cache-ttl-prefix.js";
import type {
  SessionPreparedCompactionInput,
  SessionPreparedCompactionWireValue,
  SessionPreparedCompactionBody,
} from "./session-compaction-prepared.types.js";
import {
  assertCurrentSessionTranscriptHeader,
  findSessionTranscriptHeader,
  isIndexedSessionEntry,
} from "./session-entry-codec.js";
import {
  readCompactionRowsForRendering,
  readCompactionTranscriptForPreparation,
} from "./session-transcript-hydration-read.worker.js";
import { createSessionTranscriptHydrationStream } from "./session-transcript-hydration-stream.js";
import type { SessionTranscriptHydrationWorkerInput } from "./session-transcript-hydration.types.js";

/** Short read tasks; no model, credential, writer, or retained worker across inference. */
export async function readPreparedSessionCompaction(
  request: SessionPreparedCompactionInput,
  control: WorkerTaskControl,
  channel?: WorkerTaskChannel,
): Promise<SessionPreparedCompactionWireValue> {
  const body = await readPreparedSessionCompactionBody(request, control);
  if (body.status !== "prepared") {
    return { kind: "compaction-preparation", ...body };
  }
  if (!channel) {
    throw new Error("Prepared retained context requires its hydration channel");
  }
  const { retained, ...plan } = body.plan;
  const stream = createSessionTranscriptHydrationStream(
    "utf-8",
    async (chunk, transfers) => {
      const response = await channel.request(chunk, transfers);
      response.consumed();
    },
    control,
  );
  for (const entry of retained) {
    await stream.writeJsonEvent(entry);
  }
  const retainedEventCount = await stream.finish();
  return { ...body, kind: "compaction-preparation", plan, retainedEventCount };
}

async function readPreparedSessionCompactionBody(
  request: SessionPreparedCompactionInput,
  control: WorkerTaskControl,
): Promise<SessionPreparedCompactionBody> {
  control.throwIfCancelled();
  const { operation, ...source } = request;
  const hydration: SessionTranscriptHydrationWorkerInput = {
    ...source,
    kind: "transcript-hydration",
    caller: "compaction",
  };
  if (operation.kind === "render") {
    const rows = await readCompactionRowsForRendering(
      hydration,
      operation.sequences,
      operation.version,
      control,
    );
    control.throwIfCancelled();
    const entries: SessionEntry[] = [];
    for (const row of rows) {
      if (!isIndexedSessionEntry(row)) {
        throw new Error("Prepared summary source no longer contains its message row");
      }
      entries.push(row);
    }
    const conversation = renderPreparedCompactionRows(entries, operation.maxChars);
    control.throwIfCancelled();
    return { status: "rendered", conversation };
  }
  const { prepared, sequences } = await readCompactionTranscriptForPreparation(hydration, control);
  control.throwIfCancelled();
  const snapshot = prepared.snapshot;
  const header = findSessionTranscriptHeader(snapshot.events);
  assertCurrentSessionTranscriptHeader(header);
  if (!header) {
    return { status: "unsupported", reason: "empty transcript has no preparation source" };
  }
  // Adopt the native reader's exclusive graph without a public clone or a writer.
  // The same codec, opaque ancestry, bounded indexes and migrations own this view.
  const manager = new SessionManagerCore(header.cwd, undefined, snapshot.events, {
    ...snapshot,
    limits: { compaction: true },
  });
  const branch = manager[sessionManagerReadTranscriptBranch]();
  if (snapshot.activeLeafEntryId !== branch.at(-1)?.id) {
    return { status: "unsupported", reason: "prepared compaction requires its indexed leaf" };
  }
  const sourceSequences = new Map<string, number>();
  for (let index = 0; index < snapshot.events.length; index += 1) {
    const entry = snapshot.events[index];
    if (isIndexedSessionEntry(entry)) {
      sourceSequences.set(entry.id, sequences[index]!);
    }
  }
  const replay = await prepareCompactionReplay(branch, operation.replay);
  control.throwIfCancelled();
  if (replay.status === "unsupported") {
    return replay;
  }
  if (!replay.hasRealConversation) {
    return {
      status: "skipped",
      reason: "no real conversation messages",
      beforeHookMetrics: replay.beforeHookMetrics,
    };
  }
  const result = prepareCompactionPlan(branch, sourceSequences, operation.options);
  control.throwIfCancelled();
  if (result.status !== "prepared") {
    return result.status === "skipped"
      ? { ...result, beforeHookMetrics: replay.beforeHookMetrics }
      : result;
  }
  const retained = new Map(result.plan.retained.map((entry) => [entry.id, entry]));
  const cacheTtlProjectionPrefixes = bindCacheTtlProjectionPrefixes(snapshot, {
    getBranch: () => result.plan.retained,
    getEntry: (id) => retained.get(id),
  });
  return {
    ...result,
    cacheTtlProjectionPrefixes,
    header,
    version: snapshot.version,
    leafEntryId: snapshot.activeLeafEntryId,
    boundaryCount: snapshot.boundaryCount,
    persistedSuffixStartSeq: snapshot.persistedSuffixStartSeq,
    transcriptMutationAt: snapshot.transcriptMutationAt,
    beforeHookMetrics: replay.beforeHookMetrics,
    hasRealConversation: replay.hasRealConversation,
  };
}
