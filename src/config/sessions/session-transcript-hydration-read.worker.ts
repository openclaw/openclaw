import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import type { WorkerTaskChannel } from "../../infra/worker-task-server.js";
import type { SessionCompactionPreparation } from "./session-history-read.types.js";
import { createSessionTranscriptHydrationDecoder } from "./session-transcript-hydration-decoder.js";
import type {
  SessionTranscriptHydrationWorkerRequest,
  SessionTranscriptHydrationWorkerInput,
  SessionTranscriptHydrationWorkerResult,
} from "./session-transcript-hydration.types.js";
import type { SessionTranscriptHydrationConsumer } from "./session-transcript-hydration.worker.js";
import {
  MAX_SESSION_ROW_FACTS_KEYS,
  type SessionTranscriptWorkerValues,
} from "./session-transcript-worker.types.js";

// Private preparation retains decoded/replay graphs inside the fixed 512 MiB reader.
// Larger windows stay on the complete streamed host path, never a clipped context.
const MAX_COMPACTION_PREPARATION_BYTES = 16 * 1024 * 1024;

/** Read each hydrated view under the same worker-owned quarantine and snapshot admission. */
export async function readSessionTranscriptHydrationRequest(
  request: SessionTranscriptHydrationWorkerRequest,
  channel: WorkerTaskChannel | undefined,
  control: WorkerTaskControl,
): Promise<SessionTranscriptWorkerValues[SessionTranscriptHydrationWorkerRequest["kind"]]> {
  if (request.kind === "transcript-maintenance") {
    const { withOpenClawAgentDatabaseReadOnly } =
      await import("../../state/openclaw-agent-db-readonly.js");
    const { readSessionTranscriptMaintenance } =
      await import("./session-transcript-maintenance-read.js");
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        readSessionTranscriptMaintenance(
          database,
          request.target,
          request.request,
          request.resolvedScope,
        ),
      { ...request.database, env: request.target.env },
    );
    if (!result.found) {
      throw new Error("Session transcript is unavailable for maintenance planning");
    }
    return result.value;
  }
  if (request.kind === "latest-active-message") {
    const { readLatestSessionTranscriptMessageEvent } =
      await import("./session-accessor.sqlite-active-events.js");
    return {
      kind: "latest-active-message",
      message: readLatestSessionTranscriptMessageEvent(request.target, {
        readOnly: true,
        resolvedScope: request.resolvedScope,
      }),
    };
  }
  if (request.kind === "recent-active-events") {
    const { readRecentSessionTranscriptActiveEvents } =
      await import("./session-accessor.sqlite-active-events.js");
    return {
      kind: "recent-active-events",
      events: readRecentSessionTranscriptActiveEvents(request.target, request.maxEvents, {
        readOnly: true,
        resolvedScope: request.resolvedScope,
      }),
    };
  }
  if (request.kind === "current-turn-entry") {
    const { readSessionTranscriptCurrentTurnEntry } =
      await import("./session-accessor.sqlite-current-turn.js");
    return readSessionTranscriptCurrentTurnEntry(request.target, {
      entryId: request.entryId,
      version: request.version,
      includeEntry: request.includeEntry,
      readOnly: true,
      resolvedScope: request.resolvedScope,
    });
  }
  const consume: SessionTranscriptHydrationConsumer | undefined = channel
    ? async (chunk, transfers) => {
        const response = await channel.request(chunk, transfers);
        response.consumed();
      }
    : undefined;
  return readTranscriptHydration(request, consume, control);
}

/** @internal Keep full-fidelity payloads in the admitted worker preparation task. */
export async function readCompactionTranscriptForPreparation(
  request: SessionTranscriptHydrationWorkerInput,
  control: WorkerTaskControl,
) {
  const { readSessionTranscriptBoundedActiveContextCore } =
    await import("./session-accessor.sqlite-active-context.js");
  const { assertOpenClawAgentDatabaseIdentity } =
    await import("../../state/openclaw-agent-db-identity.js");
  return await control.runNativeSection(() => {
    control.throwIfCancelled();
    let sequences: number[] = [];
    // This consumer already lives beside the database. Materialize once at the
    // selection owner instead of parsing its metadata pass and a byte stream.
    const snapshot = readSessionTranscriptBoundedActiveContextCore(request.target, {
      compaction: true,
      maxMaterializedBytes: MAX_COMPACTION_PREPARATION_BYTES,
      readOnly: true,
      resolvedScope: request.resolvedScope,
      onRead: (projection, rows) => {
        if (request.expectedIdentity) {
          assertOpenClawAgentDatabaseIdentity(projection.database, request.expectedIdentity);
        }
        sequences = rows.map((row) => row.rawSeq);
      },
    });
    control.throwIfCancelled();
    return { prepared: { kind: "bounded" as const, snapshot }, sequences };
  });
}

async function readTranscriptHydration(
  request: SessionTranscriptHydrationWorkerInput,
  consume: SessionTranscriptHydrationConsumer | undefined,
  control: WorkerTaskControl,
): Promise<SessionTranscriptHydrationWorkerResult> {
  const { readSessionTranscriptBoundedActiveContextCore, readSessionTranscriptCompactionPlan } =
    await import("./session-accessor.sqlite-active-context.js");
  const { readSessionCompactionPreparation, streamSessionTranscriptHydration } =
    await import("./session-transcript-hydration.worker.js");
  if (request.limits) {
    const selection = request.transcript;
    if (
      selection &&
      (selection.sessionKey !== request.resolvedScope.sessionKey ||
        selection.entryIds.length > MAX_SESSION_ROW_FACTS_KEYS)
    ) {
      throw new Error("Transcript hydration cohort must select its own bounded session");
    }
    const { readSessionTranscriptAnchorFactsInDatabase } =
      await import("./session-transcript-anchor-read.kernel.js");
    const { assertOpenClawAgentDatabaseIdentity } =
      await import("../../state/openclaw-agent-db-identity.js");
    let transcript: Extract<
      SessionTranscriptWorkerValues["transcript-hydration"],
      { kind: "bounded" }
    >["transcript"];
    let residentRows: Array<{ rawSeq: number; serializedBytes: number }> | undefined;
    let compaction: SessionCompactionPreparation | undefined;
    let sequences: number[] = [];
    const options: Parameters<typeof readSessionTranscriptBoundedActiveContextCore>[1] = {
      ...request.limits,
      readOnly: true,
      resolvedScope: request.resolvedScope,
      onRead: (projection, rows, messagePresence) => {
        sequences = rows.map((row) => row.rawSeq);
        if (!projection.hasUnindexedPrefix) {
          residentRows = rows;
        }
        const { database, resolved } = projection;
        if (request.expectedIdentity) {
          assertOpenClawAgentDatabaseIdentity(database, request.expectedIdentity);
        }
        if (request.compaction) {
          compaction = readSessionCompactionPreparation(database, request);
        }
        if (selection) {
          transcript = readSessionTranscriptAnchorFactsInDatabase(
            database,
            { ...resolved, sessionKey: selection.sessionKey },
            selection,
            undefined,
            projection,
            request.preparedEntry,
            messagePresence,
          );
        }
      },
    };
    const facts = () => ({
      residentRows,
      ...(selection ? { transcript } : {}),
      ...(compaction ? { compaction } : {}),
    });
    if ("compaction" in request.limits && request.limits.compaction) {
      if (!consume) {
        throw new Error("Compaction transcript hydration requires its host channel");
      }
      return streamSessionTranscriptHydration(request, consume, control, (database) => {
        const snapshot = readSessionTranscriptCompactionPlan(request.target, {
          ...options,
          transaction: database,
        });
        return { snapshot, sequences, ...facts() };
      });
    }
    const snapshot = readSessionTranscriptBoundedActiveContextCore(request.target, options);
    return { kind: "bounded" as const, snapshot, ...facts() };
  }
  if (!consume) {
    throw new Error("Full transcript hydration requires its host channel");
  }
  return streamSessionTranscriptHydration(request, consume, control);
}

/** @internal Reread only captured full-fidelity rows, once per render task. */
export async function readCompactionRowsForRendering(
  request: SessionTranscriptHydrationWorkerInput,
  sequences: readonly number[],
  version: import("./session-transcript-context-version.types.js").SessionTranscriptContextVersion,
  control: WorkerTaskControl,
) {
  const { streamSessionTranscriptHydration } =
    await import("./session-transcript-hydration.worker.js");
  const { validateSessionTranscriptContextInDatabase } =
    await import("./session-accessor.sqlite-model-context.js");
  const decoder = createSessionTranscriptHydrationDecoder({ selected: true });
  const selectedSequences = [...new Set(sequences)];
  const value = await streamSessionTranscriptHydration(
    request,
    (chunk) => decoder.accept(chunk),
    control,
    (database) => {
      validateSessionTranscriptContextInDatabase(
        database,
        request.resolvedScope,
        { version, admission: request.admission },
        "prefix",
      );
      return { sequences: selectedSequences };
    },
    MAX_COMPACTION_PREPARATION_BYTES,
  );
  let sourceSequences: readonly number[] | undefined;
  const prepared = decoder.finish(value, (_events, rows) => {
    sourceSequences = rows;
  });
  if (prepared.kind !== "full" || !sourceSequences) {
    throw new Error("Compaction rendering requires captured source rows");
  }
  const rows = new Map(
    sourceSequences.map((seq, index) => [seq, prepared.snapshot.events[index]!]),
  );
  if (rows.size !== selectedSequences.length || selectedSequences.some((seq) => !rows.has(seq))) {
    throw new Error("Compaction source rows are no longer available");
  }
  return sequences.map((seq) => rows.get(seq)!);
}
