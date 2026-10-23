import fs from "node:fs";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import type { WorkerTaskChannel } from "../../infra/worker-task-server.js";
import type { SessionCompactionPreparation } from "./session-history-read.types.js";
import type { SessionTranscriptHydrationWorkerRequest } from "./session-transcript-hydration.types.js";
import type { SessionEntryWorkerInput } from "./session-transcript-worker-read.types.js";
import {
  MAX_SESSION_ROW_FACTS_KEYS,
  type SessionTranscriptWorkerValues,
} from "./session-transcript-worker.types.js";

export async function readSessionEntrySnapshotRequest(
  request: Extract<SessionEntryWorkerInput, { mode: "snapshot" }>,
  channel: WorkerTaskChannel | undefined,
  control: WorkerTaskControl,
) {
  if (request.includeOriginalMessages) {
    if (!channel) {
      throw new Error("Original session exports require their host source owner");
    }
    return control.runNativeSection(async () => {
      // The host owns the private directory before disclosing it, including failed
      // exchanges. Cleanup waits for native settlement, never just a worker reply.
      const response = await channel.request({ kind: "session-entry-source" });
      let filePath: string;
      try {
        const destination = asOptionalRecord(response.input)?.filePath;
        if (typeof destination !== "string") {
          throw new Error("Original session export destination is unavailable");
        }
        filePath = destination;
      } finally {
        response.consumed();
      }
      control.throwIfCancelled();
      const { readTranscriptExportSourceReadOnlySync } =
        await import("./session-accessor.sqlite-read.js");
      const { readPreparedSessionEntryRecords } =
        await import("./session-entry-prepared-source.js");
      const { resolveSessionResetRecallBoundary } =
        await import("../../../packages/memory-host-sdk/src/host/session-reset-recall.js");
      const fd = fs.openSync(filePath, "wx", 0o600);
      let snapshot;
      let failure: { error: unknown } | undefined;
      try {
        let position = 0;
        const write = (buffer: Buffer, length: number) => {
          for (let offset = 0; offset < length;) {
            const written = fs.writeSync(fd, buffer, offset, length - offset, position);
            offset += written;
            position += written;
          }
        };
        // Only this operation owns the workspace; publish the initialized frame prefix.
        let frame = Buffer.alloc(0);
        snapshot = readTranscriptExportSourceReadOnlySync(request.options, {
          reset() {
            fs.ftruncateSync(fd);
            position = 0;
          },
          write(json) {
            control.throwIfCancelled();
            const payloadBytes = Buffer.byteLength(json, "utf8");
            const length = 4 + payloadBytes;
            if (frame.length < length) {
              frame = Buffer.allocUnsafe(length);
            }
            frame.writeUInt32BE(payloadBytes);
            frame.write(json, 4, payloadBytes, "utf8");
            write(frame, length);
          },
        });
      } catch (error) {
        failure = { error };
      }
      try {
        fs.closeSync(fd);
      } catch (cleanupError) {
        throw failure
          ? new AggregateError(
              [failure.error, cleanupError],
              "Session export preparation and file close failed",
              { cause: failure.error },
            )
          : cleanupError;
      }
      if (failure) {
        throw failure.error;
      }
      if (!snapshot) {
        return { preparedSource: undefined };
      }
      // Validate the complete source after its read transactions and writer FD close.
      // Only reset navigation and the largest decoded event stay live in this pass.
      let eventCount = 0;
      let reset: { firstKeptEntryId: unknown; index: number } | undefined;
      for (const event of readPreparedSessionEntryRecords(filePath)) {
        control.throwIfCancelled();
        const record = asOptionalRecord(event);
        if (record?.type === "reset") {
          reset = { firstKeptEntryId: record.firstKeptEntryId, index: eventCount };
        }
        eventCount++;
      }
      let keptIndex = -1;
      const keptId = reset?.firstKeptEntryId;
      if (reset && typeof keptId === "string" && keptId.trim()) {
        let index = 0;
        for (const event of readPreparedSessionEntryRecords(filePath)) {
          control.throwIfCancelled();
          if (index >= reset.index) {
            break;
          }
          if (asOptionalRecord(event)?.id === keptId) {
            keptIndex = index;
            break;
          }
          index++;
        }
      }
      return {
        preparedSource: {
          snapshot,
          resetRecallCutoff: reset
            ? resolveSessionResetRecallBoundary(
                reset.firstKeptEntryId,
                reset.index,
                () => keptIndex,
              )
            : { state: "absent" as const },
        },
      };
    });
  }
  const { readTranscriptExportSnapshotReadOnlySync } =
    await import("./session-accessor.sqlite-read.js");
  const { projectSessionEntryRecord } =
    await import("../../../packages/memory-host-sdk/src/host/session-entry-projection.js");
  const { prepareAssistantTranscriptText } = await import("../../shared/chat-message-content.js");
  return {
    snapshot: readTranscriptExportSnapshotReadOnlySync(request.options, {
      projectEvent: (event) => projectSessionEntryRecord(event, prepareAssistantTranscriptText),
    }),
  };
}

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
      (database) => readSessionTranscriptMaintenance(database, request.target, request.request),
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
  const { readSessionTranscriptBoundedActiveContextCore } =
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
    const snapshot = readSessionTranscriptBoundedActiveContextCore(request.target, {
      ...request.limits,
      readOnly: true,
      resolvedScope: request.resolvedScope,
      onRead: (projection, rows, messagePresence) => {
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
    });
    return {
      kind: "bounded" as const,
      snapshot,
      residentRows,
      ...(selection ? { transcript } : {}),
      ...(compaction ? { compaction } : {}),
    };
  }
  if (!channel) {
    throw new Error("Full transcript hydration requires its host channel");
  }
  return streamSessionTranscriptHydration(request, channel, control);
}
