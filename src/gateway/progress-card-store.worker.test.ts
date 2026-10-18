import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import * as gateway from "../agents/tools/in-process-gateway.js";
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
const mainTarget = { agentId: "main" };
const put = progressCardStore.put.bind(progressCardStore, sessionKey);
const get = progressCardStore.get.bind(progressCardStore, sessionKey);
afterEach(() => vi.restoreAllMocks());

function interceptWorker(intercept: <T>(execute: () => Promise<T>) => Promise<T>) {
  const open = publications.openOpenClawAgentSqliteWorkerStore;
  return vi
    .spyOn(publications, "openOpenClawAgentSqliteWorkerStore")
    .mockImplementation(async (...args) => {
      const worker = await open(...args);
      const execute = worker.execute.bind(worker);
      worker.execute = (...command) => intercept(() => execute(...command));
      return worker;
    });
}

function withCardSession(custom: boolean, run: (cfg: OpenClawConfig) => Promise<void>) {
  return withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = custom
      ? { session: { store: path.join(state.stateDir, "cards.sqlite") } }
      : {};
    setRuntimeConfigSnapshot(cfg, cfg);
    await replaceSessionEntry(
      { sessionKey, agentId: "main", storePath: cfg.session?.store },
      { sessionId: "card-session", updatedAt: 1 },
    );
    await run(cfg);
  });
}

it.each([false, true])(
  "persists tool and conditional RPC clears without caller SQL (custom=%s)",
  async (custom) => {
    await withCardSession(custom, async (cfg) => {
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
      vi.spyOn(gateway, "callInProcessGatewayTool").mockImplementation(
        async <T>(_method: string, params: Record<string, unknown>) => (await invoke(params)) as T,
      );
      const tool = createProgressCardTool({ agentSessionKey: sessionKey });
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

it("keeps queued inputs, FIFO revisions, and the captured store through a config change", async () => {
  await withCardSession(false, async (cfg) => {
    const release = createDeferredCore();
    const holding = runOpenClawAgentWriteAdmission(mainTarget, () => release.promise);
    const steps = [{ step: "Captured", status: "pending" as const }];
    const first = put({ steps });
    const second = put({ markdown: "Second" });
    steps[0]!.step = "Changed after acceptance";
    release.resolve();
    try {
      expect(await first).toMatchObject({ card: { revision: 1, steps: [{ step: "Captured" }] } });
      expect(await second).toMatchObject({ card: { revision: 2, markdown: "Second" } });
    } finally {
      await Promise.allSettled([first, second, holding]);
    }
    const changed = put({ markdown: "Captured store" });
    const next = { session: { store: "/synthetic/changed/cards.sqlite" } };
    setRuntimeConfigSnapshot(next, next);
    expect(await changed).toMatchObject({ card: { revision: 3, markdown: "Captured store" } });
    setRuntimeConfigSnapshot(cfg, cfg);
    expect(await get()).toMatchObject({ revision: 3, markdown: "Captured store" });
  });
});

it("settles card discovery cleanup while history waits for the same database writer", async ({
  signal,
}) => {
  await withCardSession(false, async () => {
    const committed = createDeferredCore();
    const statusRequested = createDeferredCore();
    const releaseOnFailure = createDeferredCore<boolean>();
    let status: Promise<boolean> | undefined;
    // Start outside the card's write admission so the host publication must queue behind it.
    const history = (async () => {
      await committed.promise;
      return withSessionHistoryWorkerDatabase(mainTarget, (owner) =>
        owner.searchTranscripts({ agentId: "main", query: "concurrent" }, () => {
          status = readSessionTranscriptIndexStatus(mainTarget, owner.assertCurrent);
          statusRequested.resolve();
          // Test cancellation releases the reader before joining the actual admitted write.
          return Promise.race([status, releaseOnFailure.promise]);
        }),
      );
    })();
    const spy = interceptWorker(async (execute) => {
      const receipt = await execute();
      committed.resolve();
      await awaitGateBeforeSettlement(
        statusRequested.promise,
        history,
        "history finished before requesting its writer-backed status",
      );
      return receipt;
    });
    const card = put({ markdown: "Concurrent history" });
    try {
      const [saved, searched] = await withinTest(Promise.all([card, history]), signal);
      expect(saved).toMatchObject({ card: { revision: 1, markdown: "Concurrent history" } });
      expect(searched.hits).toEqual([]);
      expect(await status).toBe(false);
      expect(await get()).toMatchObject({ revision: 1 });
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
    await withCardSession(false, async () => {
      await put({ markdown: "Before" });
      const denied = new SessionMutationAuthorizationChangedError({
        code: "INVALID_REQUEST",
        message: "Card authority revoked",
      });
      let current = true;
      {
        using _ = probe.admission(admission, (request, grant, admit) => {
          if (request.stage === stage) {
            current = false;
          }
          admit(request, grant);
        });
        await expect(
          put({
            markdown: "Refused",
            assertCurrent: () => {
              if (!current) {
                throw denied;
              }
            },
          }),
        ).rejects.toBe(denied);
      }
      expect(current).toBe(false);
      expect(await get()).toMatchObject({ revision: 1, markdown: "Before" });
      expect(await put({ markdown: "After" })).toMatchObject({ card: { revision: 2 } });
    });
  },
);

it("never replays a lost committed reply", async () => {
  await withCardSession(false, async () => {
    await put({ markdown: "Before" });
    const db = openOpenClawAgentDatabase(mainTarget).db;
    const unknown = new SqliteWorkerError("Synthetic lost commit reply", "outcome-unknown");
    let dispatches = 0;
    {
      using _ = interceptWorker(async (execute) => {
        dispatches++;
        await execute();
        throw unknown;
      });
      await expect(put({ markdown: "Committed once" })).rejects.toBe(unknown);
    }
    expect(dispatches).toBe(1);
    expect(readSessionProgressCard(db, sessionKey)).toMatchObject({
      revision: 2,
      markdown: "Committed once",
    });
  });
});
