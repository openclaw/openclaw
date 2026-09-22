import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import { assertNoOpenClawAgentDatabaseLeasesReadOnly } from "../../state/openclaw-agent-db-lease.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { hasOpenClawAgentCanonicalValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import * as archiveWorker from "./session-accessor.sqlite-archive.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import { hasPendingCanonicalSessionValidation } from "./session-canonical-validation.js";
import { runSessionStartupMigration } from "./startup-migration.js";

afterEach(() => vi.restoreAllMocks());

function seedFleet(env: NodeJS.ProcessEnv, invalidFirst = false) {
  const agentIds = Array.from({ length: 5 }, (_, index) => `fleet-${index}`);
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      defaults: { sessionStore: { agentId: agentIds[0] } },
      entries: Object.fromEntries(agentIds.map((agentId) => [agentId, {}])),
    },
  };
  for (const [index, agentId] of agentIds.entries()) {
    for (let session = 0; session < (index === 0 ? 129 : 1); session += 1) {
      ensureSessionEntrySync(
        { agentId, env, sessionKey: `agent:${agentId}:retained-${session}` },
        { sessionId: `${agentId}-retained-${session}`, updatedAt: 1 },
      );
    }
    if (index === 0 && invalidFirst) {
      openOpenClawAgentDatabase({ agentId, env })
        .db.prepare("UPDATE session_nodes SET parent_session_key = ?")
        .run(`agent:${agentId}:changed`);
    }
  }
  // A fresh Gateway cannot inherit the fixture writer's physical validation proof.
  closeOpenClawAgentDatabasesForTest(env.OPENCLAW_STATE_DIR);
  return { agentIds, cfg };
}

function gateFirstCertificationPerWorker() {
  type HeldRequest = { agentId: string; release: () => void };
  const workers: Array<{
    worker: Worker;
    agentId?: string;
    exited: Deferred;
  }> = [];
  const held: HeldRequest[] = [];
  let liveWorkers = 0;
  let peakWorkers = 0;
  let bypass = false;
  const createWorker = archiveWorker.createSqliteTranscriptArchiveWorker;
  vi.spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker").mockImplementation((data) => {
    const worker = createWorker(data);
    const observed: (typeof workers)[number] = { worker, exited: createDeferredCore() };
    workers.push(observed);
    peakWorkers = Math.max(peakWorkers, ++liveWorkers);
    worker.once("exit", () => {
      liveWorkers -= 1;
      observed.exited.resolve();
    });
    const postMessage = worker.postMessage.bind(worker);
    let gated = false;
    vi.spyOn(worker, "postMessage").mockImplementation((message: unknown, transferList) => {
      if (
        gated ||
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "canonical-validation"
      ) {
        postMessage(message, transferList);
        return;
      }
      if (
        !("databaseOptions" in message) ||
        typeof message.databaseOptions !== "object" ||
        message.databaseOptions === null ||
        !("agentId" in message.databaseOptions) ||
        typeof message.databaseOptions.agentId !== "string"
      ) {
        throw new Error("Canonical validation request omitted its agent owner");
      }
      gated = true;
      observed.agentId = message.databaseOptions.agentId;
      if (bypass) {
        postMessage(message, transferList);
        return;
      }
      const request: HeldRequest = {
        agentId: observed.agentId,
        release: () => {
          const index = held.indexOf(request);
          if (index !== -1) {
            held.splice(index, 1);
            postMessage(message, transferList);
          }
        },
      };
      held.push(request);
    });
    return worker;
  });
  return {
    held,
    workers,
    peakWorkers: () => peakWorkers,
    releaseAll: () => {
      bypass = true;
      while (held.length > 0) {
        held[0]!.release();
      }
    },
  };
}

it("certifies a migrated fleet two agents at a time and closes each worker before downstream maintenance", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { agentIds, cfg } = seedFleet(state.env);
    const gate = gateFirstCertificationPerWorker();
    const consumed: string[] = [];
    const maintenanceWaves = [createDeferredCore(), createDeferredCore()];
    const log = { info: vi.fn(), warn: vi.fn() };
    const startup = runSessionStartupMigration({
      cfg,
      env: state.env,
      log,
      deps: {
        migrateManagedWorktreeCanonicalWorkspaces: async ({ agentId, mode }) => {
          expect(mode).toBe("detect");
          const worker = gate.workers.find((entry) => entry.agentId === agentId)?.worker;
          expect(worker?.threadId).toBe(-1);
          const proof = withOpenClawAgentDatabaseReadOnly(
            (database) => ({
              ready: hasOpenClawAgentCanonicalValidation(database),
              pending: hasPendingCanonicalSessionValidation(database),
              rows: database.db.prepare("SELECT COUNT(*) AS count FROM session_nodes").get()?.count,
            }),
            { agentId, env: state.env },
          );
          expect(proof).toMatchObject({
            found: true,
            value: { ready: true, pending: false, rows: agentId === agentIds[0] ? 129 : 1 },
          });
          const index = consumed.push(agentId) - 1;
          const wave = maintenanceWaves[Math.floor(index / 2)];
          if (wave) {
            if (index % 2 === 1) {
              wave.resolve();
            }
            await wave.promise;
          }
          await yieldToEventLoop();
          return { found: 1, repaired: 0 };
        },
      },
    });
    void startup.catch(() => {});
    try {
      let admitted = 0;
      for (const [waveIndex, waveSize] of [2, 2, 1].entries()) {
        // The watchdog waits for an observable admission count; elapsed time is not the assertion.
        await vi.waitFor(() => expect(gate.held).toHaveLength(waveSize));
        admitted += waveSize;
        expect(gate.workers).toHaveLength(admitted);
        while (gate.held.length > 0) {
          gate.held[0]!.release();
        }
        const maintenanceWave = maintenanceWaves[waveIndex];
        if (maintenanceWave) {
          await Promise.race([maintenanceWave.promise, startup]);
        }
      }
      await startup;
      expect(gate.peakWorkers()).toBe(2);
      expect(new Set(gate.workers.map(({ agentId }) => agentId))).toEqual(new Set(agentIds));
      expect(consumed.toSorted()).toEqual(agentIds);
      expect(log.warn).toHaveBeenCalledExactlyOnceWith(
        "session: 5 managed-worktree session(s) need canonical workspace repair; run openclaw doctor --fix",
      );
      expect(gate.workers.every(({ worker }) => worker.threadId === -1)).toBe(true);
      expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).not.toThrow();
    } finally {
      for (const wave of maintenanceWaves) {
        wave.resolve();
      }
      gate.releaseAll();
      await startup.catch(() => {});
    }
  });
});

it("stops fleet admission on refusal and drains an already-started sibling before startup rejects", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { agentIds, cfg } = seedFleet(state.env, true);
    const gate = gateFirstCertificationPerWorker();
    const consumed: string[] = [];
    let settled = false;
    const startup = runSessionStartupMigration({
      cfg,
      env: state.env,
      log: { info: vi.fn(), warn: vi.fn() },
      deps: {
        migrateManagedWorktreeCanonicalWorkspaces: async ({ agentId, mode }) => {
          expect(mode).toBe("detect");
          consumed.push(agentId);
          return { found: 0, repaired: 0 };
        },
      },
    });
    const outcome = startup.then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await vi.waitFor(() => expect(gate.held).toHaveLength(2));
      const first = gate.held.find(({ agentId }) => agentId === agentIds[0]);
      const failedWorker = gate.workers.find(({ agentId }) => agentId === agentIds[0]);
      expect(first).toBeDefined();
      expect(failedWorker).toBeDefined();
      first!.release();
      await failedWorker!.exited.promise;
      await yieldToEventLoop();
      expect(settled).toBe(false);
      expect(gate.workers).toHaveLength(2);
      expect(gate.held.map(({ agentId }) => agentId)).toEqual([agentIds[1]]);
      expect(consumed).toEqual([]);

      gate.releaseAll();
      expect(await outcome).toEqual(
        expect.objectContaining({
          message: expect.stringContaining("invalid persisted session row"),
        }),
      );
      expect(gate.workers).toHaveLength(2);
      expect(consumed).toEqual([agentIds[1]]);
      expect(gate.workers.every(({ worker }) => worker.threadId === -1)).toBe(true);
      expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).not.toThrow();
    } finally {
      gate.releaseAll();
      await outcome;
    }
  });
});
