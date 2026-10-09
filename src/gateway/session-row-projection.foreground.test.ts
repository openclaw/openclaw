import { StatementSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { ACTIVITY_SUMMARY_FORMAT_REVISION } from "../config/sessions/activity-summary.js";
import * as sessions from "../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions/types.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "./server-methods.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import * as projectionWork from "./session-projection-work.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { observeSessionRowBackfill } from "./session-row-backfill.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import * as records from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import * as transcriptBackfill from "./session-row-transcript-backfill.js";
import { listProjectedSessions } from "./session-utils-list.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetGatewayWorkAdmission();
});

function holdBackfillPublication(signal?: AbortSignal) {
  const backfill = transcriptBackfill.backfillSessionRowTranscriptFields;
  const prepared = createDeferredCore<Awaited<ReturnType<typeof backfill>>>();
  const publish = createDeferredCore();
  const settled = createDeferredCore();
  const releaseLater = createDeferredCore();
  const successorStarted = createDeferredCore();
  const successorPublished = createDeferredCore();
  const accepted = createDeferredCore();
  const pending: Promise<unknown>[] = [];
  let first = true;
  let publishingSuccessor = false;
  function wait<T>(work: Promise<T>): Promise<T> {
    if (!signal) {
      return work;
    }
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new Error("Backfill wait aborted", { cause: signal.reason }));
      signal.addEventListener("abort", abort, { once: true });
      void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
  const publishTranscriptFields = records.publishTranscriptFields;
  vi.spyOn(records, "publishTranscriptFields").mockImplementation((...args) => {
    const changed = publishTranscriptFields(...args);
    accepted.resolve();
    if (publishingSuccessor) {
      successorPublished.resolve();
    }
    return changed;
  });
  vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields").mockImplementation(
    (params) => {
      const initial = first;
      first = false;
      const work = (async () => {
        if (!initial) {
          // A queued successor must not conceal the held publication's observable result.
          successorStarted.resolve();
          await releaseLater.promise;
          return backfill(params);
        }
        try {
          const fields = await backfill(params);
          prepared.resolve(fields);
          await publish.promise;
          return fields;
        } catch (error) {
          prepared.reject(error);
          throw error;
        } finally {
          settled.resolve();
        }
      })();
      pending.push(work);
      return work;
    },
  );
  return {
    get prepared() {
      return wait(prepared.promise);
    },
    async publish() {
      publish.resolve();
      await wait(settled.promise.then(nextTurn));
    },
    waitForSuccessor: () => wait(successorStarted.promise),
    async publishAvailable() {
      releaseLater.resolve();
      await wait(accepted.promise);
    },
    async publishSuccessor() {
      await wait(successorStarted.promise);
      publishingSuccessor = true;
      releaseLater.resolve();
      // A completed worker read is not proof that the host accepted its publication.
      await wait(successorPublished.promise);
    },
    async close() {
      publish.resolve();
      releaseLater.resolve();
      await Promise.allSettled(pending);
      await nextTurn();
    },
  };
}

it("publishes read-only transcript previews without acquiring stored row facts again", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:preview-only-backfill",
      sessionId: "preview-only-backfill",
    };
    const query = { agentId: scope.agentId, key: scope.sessionKey };
    sessions.replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await sessions.persistSessionTranscriptTurn(scope, {
      messages: [{ message: { role: "user", content: "Read-only transcript preview" } }],
      touchSessionEntry: false,
      updateMode: "none",
    });
    const reads = vi.fn();
    const readDatabases = history.withSessionHistoryWorkerDatabases;
    vi.spyOn(history, "withSessionHistoryWorkerDatabases").mockImplementation(
      (databases, consume) =>
        readDatabases(databases, (owners) =>
          consume(
            owners.map((owner) => ({
              ...owner,
              async readRowFacts(input) {
                const reply = await owner.readRowFacts(input);
                reads();
                return reply;
              },
            })),
          ),
        ),
    );
    const backfill = holdBackfillPublication();
    const releaseForeground = retainSessionListForegroundWork();
    let projection: Awaited<ReturnType<typeof createSessionRowProjection>> | undefined;
    try {
      projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      await projection.ensureMaterialized();
      releaseForeground();
      await backfill.prepared;
      await sessions.patchSessionEntryCore(scope, () => ({ displayName: "Renamed while reading" }));
      await projection.ensureMaterialized();
      const stored = structuredClone(sessions.loadSessionEntry(scope));
      expect(projection.dirtyRowCount).toBe(0);
      expect(reads).toHaveBeenCalled();
      const before = projection.snapshot(query, { includeLastMessage: true }).row;
      expect(before?.lastMessagePreview).toBeUndefined();
      const resident = projection.describe(query)!;
      const membership = [...resident.membership];
      const hasBoard = resident.hasBoard;
      await listProjectedSessions({ projection, opts: { includeLastMessage: true } });
      const select = vi.spyOn(projection, "selectEntries");
      const materializedCount = projection.materializedCount;
      const sequence = resident.materializedSequence;
      reads.mockClear();
      // Join the actual producer publication before a synchronous snapshot can consume dirty work.
      const hostReads = observeSqliteReadSql(StatementSync.prototype);
      try {
        await backfill.publish();
        await projection.ensureMaterialized();
        expect(
          hostReads.queries.filter((sql) =>
            /session_nodes|session_members|board_tabs|transcript_rewrite_watermarks/.test(sql),
          ),
        ).toEqual([]);
      } finally {
        hostReads.restore();
      }
      const after = projection.snapshot(query, { includeLastMessage: true }).row;
      expect(after?.lastMessagePreview).toBe("Read-only transcript preview");
      expect(after?.activitySummary).toEqual(before?.activitySummary);
      expect(sessions.loadSessionEntry(scope)).toEqual(stored);
      expect(projection.describe(query)?.hasBoard).toBe(hasBoard);
      expect([...projection.describe(query)!.membership]).toEqual(membership);
      expect(reads).not.toHaveBeenCalled();
      const current = projection.describe(query)!;
      expect(current.materialized.source.lastMessagePreview).toBe(after?.lastMessagePreview);
      expect(current.materialized.row.lastMessagePreview).toBe(after?.lastMessagePreview);
      const list = await listProjectedSessions({ projection, opts: { includeLastMessage: true } });
      expect(list.sessions[0]?.lastMessagePreview).toBe("Read-only transcript preview");
      expect(select).not.toHaveBeenCalled();
      expect(projection.materializedCount).toBe(materializedCount);
      expect(current.materializedSequence).toBe(sequence);
    } finally {
      projection?.dispose();
      releaseForeground();
      await backfill.close();
    }
  });
});

it("retains transcript previews across metadata edits and refreshes them after a transcript append", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:metadata-preview",
      sessionId: "metadata-preview",
    };
    const query = { agentId: scope.agentId, key: scope.sessionKey };
    sessions.replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await sessions.persistSessionTranscriptTurn(scope, {
      messages: [{ message: { role: "user", content: "Original preview" } }],
      touchSessionEntry: false,
      updateMode: "none",
    });
    const initial = observeSessionRowBackfill([scope.sessionKey]);
    const backfill = vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields");
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      await initial;
      backfill.mockClear();
      for (let edit = 0; edit < 10; edit++) {
        await sessions.patchSessionEntryCore(scope, () => ({
          displayName: `Renamed ${edit}`,
          pinnedAt: edit % 2 === 0 ? edit + 1 : undefined,
          updatedAt: edit + 2,
        }));
        await projection.ensureMaterialized();
        // Let the background owner reach its next admission boundary after each edit.
        await nextTurn();
        expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
          displayName: `Renamed ${edit}`,
          lastMessagePreview: "Original preview",
        });
      }
      expect(backfill.mock.calls.length).toBe(0);
      const appended = observeSessionRowBackfill([scope.sessionKey]);
      await sessions.persistSessionTranscriptTurn(scope, {
        messages: [{ message: { role: "assistant", content: "Appended preview" } }],
        touchSessionEntry: false,
      });
      await appended;
      expect(projection.snapshot(query, { includeLastMessage: true }).row?.lastMessagePreview).toBe(
        "Appended preview",
      );
      expect(backfill).toHaveBeenCalledTimes(1);
    } finally {
      projection.dispose();
    }
  });
});

it.for(["notice cleared", "selection changed"] as const)(
  "rejects a held fallback after same-session metadata changes: %s",
  (change, { signal, onTestFinished }) => {
    const run = withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:held-fallback",
        sessionId: "held-fallback",
      };
      const query = { agentId: scope.agentId, key: scope.sessionKey };
      const entry: InternalSessionEntry = {
        sessionId: scope.sessionId,
        updatedAt: 1,
        status: "done",
        lastRunId: "terminal-run",
        providerOverride: "unit-test",
        modelOverride: "selected",
        fallbackNotice: {
          kind: "active",
          selectedModel: "unit-test/selected",
          activeModel: "unit-test/fallback",
        },
      };
      sessions.replaceSessionEntrySync(scope, entry);
      await sessions.persistSessionTranscriptTurn(scope, {
        messages: [
          {
            message: {
              role: "assistant",
              content: "Finished",
              provider: "unit-test",
              model: "fallback",
              stopReason: "stop",
              __openclaw: { runId: "terminal-run" },
            },
          },
        ],
        touchSessionEntry: false,
        updateMode: "none",
      });
      const backfill = holdBackfillPublication(signal);
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      try {
        expect(await backfill.prepared).toEqual({
          lastMessagePreview: "Finished",
          fallbackModel: { provider: "unit-test", model: "fallback" },
        });
        const before = projection.describe(query)!;
        sessions.replaceSessionEntrySync(scope, {
          ...entry,
          updatedAt: 2,
          ...(change === "notice cleared"
            ? { fallbackNotice: undefined }
            : { modelOverride: "replacement" }),
        });
        await projection.ensureMaterialized();
        expect(projection.describe(query)?.generation).toBe(before.generation);
        expect(projection.snapshot(query).row?.activeModel).toBeUndefined();
        await backfill.publish();
        await backfill.waitForSuccessor();
        expect(
          projection.snapshot(query, { includeLastMessage: true }).row?.lastMessagePreview,
        ).toBeUndefined();
        expect(projection.describe(query)?.fallbackModel).toBeUndefined();
        await backfill.publishSuccessor();
        await projection.ensureMaterialized();
        expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
          lastMessagePreview: "Finished",
          model: change === "selection changed" ? "replacement" : "selected",
          activeModel: undefined,
          activeModelProvider: undefined,
        });
        expect(projection.describe(query)?.fallbackModel).toBeUndefined();
      } finally {
        projection.dispose();
        await backfill.close();
      }
    });
    onTestFinished(() => run);
    return run;
  },
);

it("keeps pending Worker metadata, membership, and summary facts across optional publication", ({
  signal,
  onTestFinished,
}) => {
  const run = withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {
      agents: {
        entries: { main: {} },
        defaults: { utilityModel: "unit-test/small" },
      },
    };
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:backfill-facts",
      sessionId: "backfill-facts",
    };
    const query = { agentId: scope.agentId, key: scope.sessionKey };
    const owner = ensureProfileForEmail("projection-owner@example.test");
    const viewer = ensureProfileForEmail("projection-viewer@example.test");
    const entry: SessionEntry = {
      sessionId: scope.sessionId,
      updatedAt: 1,
      label: "Original label",
      visibility: "read-only",
      createdActor: { type: "human", source: "profile", id: owner.id },
    };
    sessions.replaceSessionEntrySync(scope, entry);
    addSessionMember(scope, { identityId: viewer.id, addedBy: owner.id, addedAt: 1 });
    await sessions.persistSessionTranscriptTurn(scope, {
      messages: [{ message: { role: "user", content: "Read-only preview" } }],
      touchSessionEntry: false,
      updateMode: "none",
    });
    const watermark = sessions.readSessionTranscriptWatermark(scope);
    const backfill = holdBackfillPublication(signal);
    const captured = createDeferredCore();
    const release = createDeferredCore();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const context = bindSessionRowProjection(requestContext(cfg), () => projection);
    const client = identifiedClient(viewer.id);
    const request = {
      agentId: scope.agentId,
      includeActivitySummary: true,
      includeLastMessage: true,
    };
    let reading: ReturnType<typeof listSessions> | undefined;
    try {
      await backfill.prepared;
      await projection.ensureMaterialized();
      expect((await listSessions({ client, context, request })).sessions[0]).toMatchObject({
        label: "Original label",
        sharingRole: "member",
      });
      const readDatabases = history.withSessionHistoryWorkerDatabases;
      let reads = 0;
      vi.spyOn(history, "withSessionHistoryWorkerDatabases").mockImplementation(
        (databases, consume) =>
          readDatabases(databases, (owners) =>
            consume(
              owners.map((database) => ({
                ...database,
                async readRowFacts(input) {
                  const reply = await database.readRowFacts(input);
                  reads++;
                  if (reads === 1) {
                    captured.resolve();
                    await release.promise;
                  }
                  return reply;
                },
              })),
            ),
          ),
      );
      sessions.replaceSessionEntrySync(scope, {
        ...entry,
        updatedAt: 2,
        label: "Intermediate label",
      });
      reading = listSessions({ client, context, request });
      await Promise.race([
        captured.promise,
        reading.then(() => {
          throw new Error("List bypassed pending row facts");
        }),
      ]);
      sessions.replaceSessionEntrySync(scope, {
        ...entry,
        updatedAt: 3,
        label: "Current label",
        activitySummary: {
          version: 1,
          formatRevision: ACTIVITY_SUMMARY_FORMAT_REVISION,
          text: "Current summary",
          updatedAt: 3,
          sessionId: scope.sessionId,
          generation: watermark.generation,
          maxSeq: watermark.maxSeq,
          leafEntryId: null,
          coveredMessages: 1,
          totalMessages: 1,
          omittedContent: false,
        },
      });
      expect(removeSessionMember(scope, viewer.id)).not.toBeNull();
      await backfill.publish();
      expect(projection.dirtyRowCount).toBe(1);
      release.resolve();
      const result = await reading;
      expect(reads).toBe(2);
      expect(result.sessions).toEqual([
        expect.objectContaining({
          key: scope.sessionKey,
          label: "Current label",
          sharingRole: "viewer",
          activitySummary: expect.objectContaining({
            text: "Current summary",
            updatedAt: 3,
            state: "current",
          }),
        }),
      ]);
      expect(result.sessions[0]?.lastMessagePreview).toBeUndefined();
      expect(projection.dirtyRowCount).toBe(0);
      await backfill.publishAvailable();
      expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
        label: "Current label",
        lastMessagePreview: "Read-only preview",
        activitySummary: { text: "Current summary", updatedAt: 3, state: "current" },
      });
      expect(projection.describe(query)?.membership.has(viewer.id)).toBe(false);
      expect(reads).toBe(2);
    } finally {
      release.resolve();
      await Promise.allSettled(reading ? [reading] : []);
      projection.dispose();
      await backfill.close();
    }
  });
  onTestFinished(() => run);
  return run;
});

it.each(["before transcript work", "before preview publication"] as const)(
  "gives an in-flight Gateway request priority %s and resumes read-only previews afterward",
  async (phase) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      resetGatewayWorkAdmission();
      const cfg = { agents: { entries: { main: {} } } };
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:foreground-backfill",
        sessionId: "foreground-backfill",
      };
      const query = { agentId: scope.agentId, key: scope.sessionKey };
      sessions.replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await sessions.persistSessionTranscriptTurn(scope, {
        messages: [{ message: { role: "user", content: "Preview the legacy session" } }],
        touchSessionEntry: false,
        updateMode: "none",
      });
      const entered = createDeferredCore();
      const response = createDeferredCore();
      const previewPrepared = createDeferredCore();
      const previewPublication = createDeferredCore();
      const backgroundWaiting = createDeferredCore();
      const yieldBackground = projectionWork.yieldSessionListBackgroundWork;
      let previewReleased = false;
      vi.spyOn(projectionWork, "yieldSessionListBackgroundWork").mockImplementation(() => {
        const pending = yieldBackground();
        if (phase === "before transcript work" || previewReleased) {
          backgroundWaiting.resolve();
        }
        return pending;
      });
      const before = sessions.loadSessionEntry(scope);
      if (phase === "before preview publication") {
        const readDatabase = history.withSessionHistoryWorkerDatabase;
        vi.spyOn(history, "withSessionHistoryWorkerDatabase").mockImplementation(
          (options, consume, lane) =>
            readDatabase(
              options,
              (owner) =>
                consume({
                  ...owner,
                  async readRowBackfill(input) {
                    const fields = await owner.readRowBackfill(input);
                    previewPrepared.resolve();
                    await previewPublication.promise;
                    return fields;
                  },
                }),
              lane,
            ),
        );
      }
      const request = () =>
        handleGatewayRequest({
          req: { type: "req", id: "foreground-read", method: "health", params: {} },
          context: requestContext(cfg),
          client: identifiedClient("owner@example.com"),
          isWebchatConnect: () => false,
          respond: vi.fn(),
          extraHandlers: {
            health: async ({ respond }) => {
              entered.resolve();
              await response.promise;
              respond(true, {});
            },
          },
        });
      let foreground: Promise<void> | undefined;
      if (phase === "before transcript work") {
        foreground = request();
        await entered.promise;
      }
      const backfilled = observeSessionRowBackfill([scope.sessionKey]);
      const projection = await createSessionRowProjection({ cfg });
      // Observe the row at completion, before a later retry can conceal a premature signal.
      const observedPreview = backfilled.then(
        () => projection.snapshot(query, { includeLastMessage: true }).row?.lastMessagePreview,
      );
      try {
        if (phase === "before preview publication") {
          await previewPrepared.promise;
          foreground = request();
          await entered.promise;
          previewReleased = true;
          previewPublication.resolve();
        }
        await backgroundWaiting.promise;
        expect(sessions.loadSessionEntry(scope)).toEqual(before);
        expect(
          projection.snapshot(query, { includeLastMessage: true }).row?.lastMessagePreview,
        ).toBeUndefined();
        response.resolve();
        await foreground;
        expect(await observedPreview).toBe("Preview the legacy session");
        expect(
          projection.snapshot(query, { includeLastMessage: true }).row?.lastMessagePreview,
        ).toBe("Preview the legacy session");
        expect(sessions.loadSessionEntry(scope)).toEqual(before);
      } finally {
        previewPublication.resolve();
        response.resolve();
        await foreground;
        projection.dispose();
      }
    });
  },
);
