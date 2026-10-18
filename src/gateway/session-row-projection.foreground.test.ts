import { symlinkSync } from "node:fs";
import path from "node:path";
import { StatementSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { ACTIVITY_SUMMARY_FORMAT_REVISION } from "../config/sessions/activity-summary.js";
import * as sessions from "../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
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
import {
  clearStoredSessionRowTranscriptForTest,
  observeSessionRowBackfill,
} from "./session-row-backfill.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import * as records from "./session-row-projection-record.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import {
  createTestProjection,
  watchRowFacts as observeRowFacts,
} from "./session-row-projection.read-fixture.test-support.js";
import * as transcriptBackfill from "./session-row-transcript-backfill.js";
import { listProjectedSessions } from "./session-utils-list.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetGatewayWorkAdmission();
});

const cfg = { agents: { entries: { main: {} } } };
async function seedPreview(sessionId: string, content: string, config?: OpenClawConfig) {
  const scope = { agentId: "main", sessionKey: `agent:main:${sessionId}`, sessionId };
  sessions.replaceSessionEntrySync(scope, { sessionId, updatedAt: 1 });
  await sessions.persistSessionTranscriptTurn(scope, {
    ...(config ? { config } : {}),
    messages: [{ message: { role: "user", content } }],
    touchSessionEntry: false,
    updateMode: "none",
  });
  return { scope, query: { agentId: scope.agentId, key: scope.sessionKey } };
}
const preview = (
  projection: SessionRowProjection,
  query: Parameters<SessionRowProjection["snapshot"]>[0],
) => projection.snapshot(query, { includeLastMessage: true }).row?.lastMessagePreview;

function holdBackfillPublication(signal?: AbortSignal) {
  const backfill = transcriptBackfill.backfillSessionRowTranscriptFields;
  const prepared = createDeferredCore<Awaited<ReturnType<typeof backfill>>>();
  const publish = createDeferredCore();
  const settled = createDeferredCore();
  const releaseLater = createDeferredCore();
  const accepted = createDeferredCore();
  const pending: Promise<unknown>[] = [];
  let first = true;
  function wait<T>(work: Promise<T>): Promise<T> {
    return signal ? withinTest(work, signal) : work;
  }
  const publishTranscriptFields = records.publishTranscriptFields;
  vi.spyOn(records, "publishTranscriptFields").mockImplementation((...args) => {
    const changed = publishTranscriptFields(...args);
    accepted.resolve();
    return changed;
  });
  vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields").mockImplementation(
    (params) => {
      const initial = first;
      first = false;
      const work = (async () => {
        if (!initial) {
          // A queued successor must not conceal the held publication's observable result.
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
    async publishAvailable() {
      releaseLater.resolve();
      await wait(accepted.promise);
    },
    async close() {
      publish.resolve();
      releaseLater.resolve();
      await Promise.allSettled(pending);
      await nextTurn();
    },
  };
}

it("publishes legacy transcript previews without acquiring stored row facts again", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot(cfg);
    const { scope, query } = await seedPreview(
      "preview-only-backfill",
      "Read-only transcript preview",
    );
    const reads = vi.fn();
    observeRowFacts((owner) => async (input) => {
      const reply = await owner.readRowFacts(input);
      reads();
      return reply;
    });
    clearStoredSessionRowTranscriptForTest(scope);
    const backfill = holdBackfillPublication();
    const releaseForeground = retainSessionListForegroundWork();
    let projection: Awaited<ReturnType<typeof createSessionRowProjection>> | undefined;
    try {
      projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      await projection.ensureMaterialized();
      projection.describe(query);
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

it("retains transcript previews across metadata edits and consumes committed alias appends without reads", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot(cfg);
    const { scope, query } = await seedPreview("metadata-preview", "Original preview", cfg);
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: scope.agentId, env: state.env });
    const aliasDirectory = state.path("transcript-alias");
    symlinkSync(
      path.dirname(storePath),
      aliasDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    const aliasPath = path.join(aliasDirectory, path.basename(storePath));
    openOpenClawAgentDatabase({ agentId: scope.agentId, path: aliasPath });
    const initial = observeSessionRowBackfill([scope.sessionKey]);
    const backfill = vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields");
    using projection = await createTestProjection({ cfg, modelCatalog: [] });

    await projection.ensureMaterialized();
    projection.describe(query);
    await initial;
    // A user-only transcript needs one bounded read to establish assistant absence.
    await vi.waitFor(() => expect(backfill).toHaveBeenCalledTimes(1));
    await backfill.mock.results[0]?.value;
    backfill.mockClear();
    for (let edit = 0; edit < 10; edit++) {
      await sessions.patchSessionEntryCore(scope, () => ({
        displayName: `Renamed ${edit}`,
        pinnedAt: edit % 2 === 0 ? edit + 1 : undefined,
        sidebarRoot: edit % 2 === 0 ? true : undefined,
        updatedAt: edit + 2,
      }));
      await projection.ensureMaterialized();
      // Let the background owner reach its next admission boundary after each edit.
      await nextTurn();
      expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
        displayName: `Renamed ${edit}`,
        sidebarRoot: edit % 2 === 0,
        lastMessagePreview: "Original preview",
      });
    }
    expect(backfill.mock.calls.length).toBe(0);
    const reads = vi.fn();
    observeRowFacts((owner) => async (input) => {
      reads();
      return owner.readRowFacts(input);
    });
    const appended = observeSessionRowBackfill([scope.sessionKey]);
    const append = sessions.appendTranscriptMessageSync(
      { ...scope, storePath: aliasPath },
      { config: cfg, message: { role: "assistant", content: "Appended preview" } },
    );
    expect(append).toMatchObject({ ok: true, value: { appended: true } });
    expect(projection.capture(query)?.retainedDatabaseFacts).toMatchObject({
      activitySummaryWatermark: { maxSeq: 2 },
      transcriptPreview: "Appended preview",
    });
    const aliasQuery = { ...query, storePath: aliasPath };
    expect(projection.capture(aliasQuery)?.retainedDatabaseFacts).toMatchObject({
      activitySummaryWatermark: { maxSeq: 2 },
      transcriptPreview: "Appended preview",
    });
    await appended;
    expect(preview(projection, query)).toBe("Appended preview");
    const refreshed = vi.fn();
    projection.onFactsChange(refreshed);
    emitSessionTranscriptUpdate({ target: { ...scope, storePath: aliasPath } });
    await projection.ensureMaterialized();
    await nextTurn();
    expect(refreshed).toHaveBeenCalledWith({ kind: "row", key: scope.sessionKey });
    expect(preview(projection, aliasQuery)).toBe("Appended preview");
    expect(backfill).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    await sessions.patchSessionEntryCore(scope, () => ({ displayName: "After append" }));
    await projection.ensureMaterialized();
    await nextTurn();
    expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
      displayName: "After append",
      lastMessagePreview: "Appended preview",
    });
    expect(backfill).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
  });
});

it("reuses an unknown preview until a committed transcript watermark changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot(cfg);
    const { scope, query } = await seedPreview("preview-notifications", "Original preview", cfg);
    clearStoredSessionRowTranscriptForTest(scope);
    const initial = observeSessionRowBackfill([scope.sessionKey]);
    const backfill = vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields");
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      await projection.ensureMaterialized();
      projection.describe(query);
      await initial;
      expect(projection.capture(query)?.retainedDatabaseFacts?.transcriptPreview).toBeUndefined();
      expect(backfill).toHaveBeenCalledTimes(1);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      emitSessionTranscriptUpdate({ target: scope });
      emitSessionTranscriptUpdate({
        target: scope,
        message: { role: "user", content: "Original preview" },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await projection.ensureMaterialized();
      await nextTurn();
      expect(backfill).toHaveBeenCalledTimes(1);
      expect(preview(projection, query)).toBe("Original preview");

      const refreshed = observeSessionRowBackfill([scope.sessionKey], projection);
      await sessions.persistSessionTranscriptTurn(scope, {
        config: cfg,
        messages: [
          { message: { role: "assistant", content: "Updated preview" } },
          { message: { role: "assistant", content: "Hidden append", display: false } },
        ],
        touchSessionEntry: false,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await refreshed;
      expect(backfill).toHaveBeenCalledTimes(2);
      expect(preview(projection, query)).toBe("Updated preview");
    } finally {
      projection.dispose();
      vi.useRealTimers();
    }
  });
});

it("keeps a committed append preview when an older background read finishes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { scope, query } = await seedPreview("preview-receipt", "Older preview", cfg);
    clearStoredSessionRowTranscriptForTest(scope);
    const backfill = holdBackfillPublication();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      await projection.ensureMaterialized();
      projection.describe(query);
      expect(await backfill.prepared).toMatchObject({ lastMessagePreview: "Older preview" });
      await sessions.persistSessionTranscriptTurn(scope, {
        config: cfg,
        messages: [{ message: { role: "assistant", content: "Committed preview" } }],
        touchSessionEntry: false,
      });
      await projection.ensureMaterialized();
      expect(preview(projection, query)).toBe("Committed preview");
      await backfill.publish();
      expect(preview(projection, query)).toBe("Committed preview");
    } finally {
      projection.dispose();
      await backfill.close();
    }
  });
});

it("drops an older backfill after broad invalidation clears retained preview facts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { scope, query } = await seedPreview("preview-invalidated", "Older preview", cfg);
    clearStoredSessionRowTranscriptForTest(scope);
    const backfill = holdBackfillPublication();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      await projection.ensureMaterialized();
      projection.describe(query);
      expect(await backfill.prepared).toMatchObject({ lastMessagePreview: "Older preview" });
      await sessions.persistSessionTranscriptTurn(scope, {
        config: cfg,
        messages: [{ message: { role: "assistant", content: "Committed preview" } }],
        touchSessionEntry: false,
      });
      await projection.ensureMaterialized();
      const row = projection.describe(query)!;
      expect(row.lastMessagePreview).toBe("Committed preview");
      sessionChanges.emit({ all: true, scope: { agentId: "main" }, factsInvalidated: true });
      expect(row.retainedDatabaseFacts).toBeUndefined();
      await backfill.publish();
      expect(row.lastMessagePreview).toBe("Committed preview");
      await projection.ensureMaterialized();
      expect(preview(projection, query)).toBe("Committed preview");
    } finally {
      projection.dispose();
      await backfill.close();
    }
  });
});

it("keeps pending Worker metadata, membership, and summary facts across optional publication", ({
  signal,
  onTestFinished,
}) => {
  const run = withOpenClawTestState({ scenario: "minimal" }, async () => {
    const summaryConfig = {
      agents: {
        entries: { main: {} },
        defaults: { utilityModel: "unit-test/small" },
      },
    };
    setRuntimeConfigSnapshot(summaryConfig);
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
    clearStoredSessionRowTranscriptForTest(scope);
    const backfill = holdBackfillPublication(signal);
    const captured = createDeferredCore();
    const release = createDeferredCore();
    const projection = await createSessionRowProjection({ cfg: summaryConfig, modelCatalog: [] });
    const context = bindSessionRowProjection(requestContext(summaryConfig), () => projection);
    const client = identifiedClient(viewer.id);
    const request = {
      agentId: scope.agentId,
      includeActivitySummary: true,
      includeLastMessage: true,
    };
    let reading: ReturnType<typeof listSessions> | undefined;
    try {
      await projection.ensureMaterialized();
      expect((await listSessions({ client, context, request })).sessions[0]).toMatchObject({
        label: "Original label",
        sharingRole: "member",
      });
      await backfill.prepared;
      let reads = 0;
      observeRowFacts((database) => async (input) => {
        const reply = await database.readRowFacts(input);
        if (++reads === 1) {
          captured.resolve();
          await release.promise;
        }
        return reply;
      });
      sessions.replaceSessionEntrySync(scope, {
        ...entry,
        updatedAt: 2,
        label: "Intermediate label",
      });
      sessionChanges.emit({ ...scope, factsInvalidated: true });
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
      // The metadata reload also carries the completed durable backfill, even while
      // its original optional publication is held.
      expect(result.sessions[0]?.lastMessagePreview).toBe("Read-only preview");
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

it("gives an in-flight Gateway request priority before starting legacy preview backfill", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    resetGatewayWorkAdmission();
    setRuntimeConfigSnapshot(cfg);
    const { scope, query } = await seedPreview("foreground-backfill", "Preview the legacy session");
    clearStoredSessionRowTranscriptForTest(scope);
    const entered = createDeferredCore();
    const response = createDeferredCore();
    const backgroundWaiting = createDeferredCore();
    const yieldBackground = projectionWork.yieldSessionListBackgroundWork;
    vi.spyOn(projectionWork, "yieldSessionListBackgroundWork").mockImplementation(() => {
      const pending = yieldBackground();
      backgroundWaiting.resolve();
      return pending;
    });
    const before = sessions.loadSessionEntry(scope);
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
    const foreground = request();
    await entered.promise;
    const backfilled = observeSessionRowBackfill([scope.sessionKey]);
    const projection = await createSessionRowProjection({ cfg });
    // Observe the row at completion, before a later retry can conceal a premature signal.
    const observedPreview = backfilled.then(() => preview(projection, query));
    try {
      await projection.ensureMaterialized();
      projection.describe(query);
      await backgroundWaiting.promise;
      expect(sessions.loadSessionEntry(scope)).toEqual(before);
      expect(preview(projection, query)).toBeUndefined();
      response.resolve();
      await foreground;
      expect(await observedPreview).toBe("Preview the legacy session");
      expect(preview(projection, query)).toBe("Preview the legacy session");
      expect(sessions.loadSessionEntry(scope)).toEqual(before);
    } finally {
      response.resolve();
      await foreground;
      projection.dispose();
    }
  });
});
