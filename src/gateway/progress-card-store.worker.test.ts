import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createProgressCardTool } from "../agents/tools/progress-card-tool.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { readSessionTranscriptIndexStatus } from "../config/sessions/session-transcript-projection-writer.js";
import { withSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { readSessionProgressCard } from "../session-cards/progress-card-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import * as publications from "../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { progressCardStore } from "./progress-card-store.js";
import { createProgressCardHandlers } from "./server-methods/progress-card.js";
import type { GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";

const sessionKey = "agent:main:progress-worker";
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "persists tool and conditional RPC clears without caller SQL (custom=%s)",
  async (custom) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = custom
        ? { session: { store: path.join(state.stateDir, "cards.sqlite") } }
        : {};
      setRuntimeConfigSnapshot(cfg, cfg);
      await replaceSessionEntry(
        { sessionKey, agentId: "main", storePath: cfg.session?.store },
        { sessionId: "card-session", updatedAt: 1 },
      );
      const target = { agentId: "main", path: cfg.session?.store };
      const db = openOpenClawAgentDatabase(target).db;
      const handlers = createProgressCardHandlers();
      const broadcast = vi.fn();
      const invoke = async (params: unknown) => {
        const respond = vi.fn<RespondFn>();
        await handlers["progressCard.put"]!({
          params,
          respond,
          context: { getRuntimeConfig: () => cfg, broadcast } as unknown as GatewayRequestContext,
        } as never);
        expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
        return respond.mock.calls[0]?.[1];
      };
      const tool = createProgressCardTool({
        agentSessionKey: sessionKey,
        callGateway: async <T>(_method: string, params: Record<string, unknown>) =>
          (await invoke(params)) as T,
      });
      const sql = observeHostDataSql();
      try {
        await tool.execute("create", {
          markdown: "First",
          plan: [{ step: "Persist", status: "in_progress" }],
        });
        await tool.execute("replace", { markdown: "Second" });
        expect(await invoke({ sessionKey, expectedRevision: 1 })).toMatchObject({
          card: { revision: 2, markdown: "Second" },
        });
        expect(await invoke({ sessionKey, expectedRevision: 2 })).toEqual({ card: null });
        await tool.execute("recreate", { plan: [{ step: "Done", status: "completed" }] });
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      expect(readSessionProgressCard(db, sessionKey)).toMatchObject({
        revision: 4,
        steps: [{ step: "Done", status: "completed" }],
      });
      expect(broadcast.mock.calls.map((call) => call[1].revision)).toEqual([1, 2, null, 4]);
    });
  },
);

it("keeps queued inputs and FIFO revisions, refusing a changed target before mutation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = {};
    setRuntimeConfigSnapshot(cfg, cfg);
    await replaceSessionEntry(
      { sessionKey, agentId: "main" },
      { sessionId: "queued-session", updatedAt: 1 },
    );
    const target = { agentId: "main" };
    const release = createDeferredCore();
    const holding = runOpenClawAgentWriteAdmission(target, () => release.promise);
    const steps = [{ step: "Captured", status: "pending" as const }];
    const first = progressCardStore.put(sessionKey, { steps });
    const second = progressCardStore.put(sessionKey, { markdown: "Second" });
    steps[0]!.step = "Changed after acceptance";
    release.resolve();
    try {
      expect(await first).toMatchObject({ card: { revision: 1, steps: [{ step: "Captured" }] } });
      expect(await second).toMatchObject({ card: { revision: 2, markdown: "Second" } });
    } finally {
      await Promise.allSettled([first, second, holding]);
    }
    const changed = progressCardStore.put(sessionKey, { markdown: "Wrong store" });
    const next = { session: { store: "/synthetic/changed/cards.sqlite" } };
    setRuntimeConfigSnapshot(next, next);
    await expect(changed).rejects.toThrow("progress-card session changed");
    setRuntimeConfigSnapshot(cfg, cfg);
    expect(await progressCardStore.get(sessionKey)).toMatchObject({
      revision: 2,
      markdown: "Second",
    });
  });
});

it("settles card discovery cleanup while history waits for the same database writer", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({}, {});
    await replaceSessionEntry(
      { sessionKey, agentId: "main" },
      { sessionId: "concurrent-history-session", updatedAt: 1 },
    );
    const target = { agentId: "main" };
    const committed = createDeferredCore();
    const statusRequested = createDeferredCore();
    const releaseOnFailure = createDeferredCore<boolean>();
    let status: Promise<boolean> | undefined;
    // Start outside the card's write admission so the host publication must queue behind it.
    const history = (async () => {
      await committed.promise;
      return withSessionHistoryWorkerDatabase(target, (owner) =>
        owner.searchTranscripts({ agentId: "main", query: "concurrent" }, () => {
          status = readSessionTranscriptIndexStatus(target, owner.assertCurrent);
          statusRequested.resolve();
          // Test cancellation releases the reader before joining the actual admitted write.
          return Promise.race([status, releaseOnFailure.promise]);
        }),
      );
    })();
    const open = publications.openOpenClawAgentSqliteWorkerStore;
    const spy = vi
      .spyOn(publications, "openOpenClawAgentSqliteWorkerStore")
      .mockImplementation(async (...args) => {
        const worker = await open(...args);
        return {
          ...worker,
          execute: async (...command) => {
            const receipt = await worker.execute(...command);
            committed.resolve();
            await awaitGateBeforeSettlement(
              statusRequested.promise,
              history,
              "history finished before requesting its writer-backed status",
            );
            return receipt;
          },
        };
      });
    const card = progressCardStore.put(sessionKey, { markdown: "Concurrent history" });
    try {
      const [saved, searched] = await withinTest(Promise.all([card, history]), signal);
      expect(saved).toMatchObject({ card: { revision: 1, markdown: "Concurrent history" } });
      expect(searched.hits).toEqual([]);
      expect(await status).toBe(false);
      expect(await progressCardStore.get(sessionKey)).toMatchObject({ revision: 1 });
    } finally {
      committed.resolve();
      releaseOnFailure.resolve(false);
      await Promise.allSettled([card, history]);
      await status;
      spy.mockRestore();
    }
  });
});

it.each(["transaction", "commit"] as const)(
  "preserves authorization error identity and rolls back %s refusal",
  async (stage) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({}, {});
      await replaceSessionEntry(
        { sessionKey, agentId: "main" },
        { sessionId: "refusal-session", updatedAt: 1 },
      );
      await progressCardStore.put(sessionKey, { markdown: "Before" });
      const denied = new SessionMutationAuthorizationChangedError({
        code: "INVALID_REQUEST",
        message: "Card authority revoked",
      });
      let current = true;
      const spy = probe.admission(admission, (request, grant, admit) => {
        if (request.stage === stage) {
          current = false;
        }
        admit(request, grant);
      });
      try {
        await expect(
          progressCardStore.put(sessionKey, {
            markdown: "Refused",
            assertCurrent: () => {
              if (!current) {
                throw denied;
              }
            },
          }),
        ).rejects.toBe(denied);
      } finally {
        spy.mockRestore();
      }
      expect(current).toBe(false);
      expect(await progressCardStore.get(sessionKey)).toMatchObject({
        revision: 1,
        markdown: "Before",
      });
      expect(await progressCardStore.put(sessionKey, { markdown: "After" })).toMatchObject({
        card: { revision: 2 },
      });
    });
  },
);

it("preserves native decoding errors and never replays a lost committed reply", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({}, {});
    await replaceSessionEntry(
      { sessionKey, agentId: "main" },
      { sessionId: "uncertain-session", updatedAt: 1 },
    );
    await progressCardStore.put(sessionKey, { markdown: "Before" });
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    db.prepare("UPDATE session_progress_cards SET steps_json = '{' WHERE session_key = ?").run(
      sessionKey,
    );
    await expect(progressCardStore.put(sessionKey, { expectedRevision: 1 })).rejects.toBeInstanceOf(
      SyntaxError,
    );
    const unknown = new SqliteWorkerError("Synthetic lost commit reply", "outcome-unknown");
    const open = publications.openOpenClawAgentSqliteWorkerStore;
    let dispatches = 0;
    const spy = vi
      .spyOn(publications, "openOpenClawAgentSqliteWorkerStore")
      .mockImplementation(async (...args) => {
        const worker = await open(...args);
        return {
          ...worker,
          execute: async (...command) => {
            dispatches++;
            await worker.execute(...command);
            throw unknown;
          },
        };
      });
    try {
      await expect(progressCardStore.put(sessionKey, { markdown: "Committed once" })).rejects.toBe(
        unknown,
      );
    } finally {
      spy.mockRestore();
    }
    expect(dispatches).toBe(1);
    expect(readSessionProgressCard(db, sessionKey)).toMatchObject({
      revision: 2,
      markdown: "Committed once",
    });
  });
});
