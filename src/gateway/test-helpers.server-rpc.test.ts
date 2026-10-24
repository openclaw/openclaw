import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listAgentIds } from "../agents/agent-scope.js";
import { type AgentsConfig, getRuntimeConfig as getMockedRuntimeConfig } from "../config/config.js";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
  recordSessionParticipant,
  updateSessionEntry,
} from "../config/sessions/session-accessor.js";
import { listSessionsNeedingTranscriptIndexReconcile } from "../config/sessions/session-transcript-index.js";
import {
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
} from "../config/sessions/session-transcript-reconcile.js";
import * as historyWorkers from "../config/sessions/session-transcript-worker-runtime.js";
import { getGatewayContextResolver } from "../plugins/runtime/gateway-context-binding.js";
import {
  getActiveGatewayRootWorkCount,
  retainGatewayRootWorkAdmissionContinuationScope,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { beginSessionEffect } from "../sessions/session-controller.lifecycle.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import * as agentDatabaseLifecycle from "../state/openclaw-agent-db-lifecycle.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { listOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.test-support.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../state/openclaw-agent-write-admission-state.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { getGatewayRecoveryRuntime } from "./server-recovery-runtime-context.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { releaseSessionTestDirectories } from "./session-test-directories.test-support.js";
import { createGatewayConfigOverrides } from "./test-helpers.config-runtime.js";
import {
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";
import {
  releaseGatewaySessionStoreFixture,
  settleGatewaySessionStoreFixture,
} from "./test/server-sessions-resources.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let ws: WebSocket;
installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});
const listAgents = () =>
  rpcReq<{ agents: Array<{ id: string; name?: string }> }>(ws, "agents.list", {});

function storeFixture(name: string, dir = tempDirs.make(`openclaw-gw-${name}-`)) {
  const storePath = path.join(dir, "openclaw-agent.sqlite");
  testState.sessionStorePath = storePath;
  return {
    dir,
    storePath,
    scope: { agentId: "main", sessionKey: "agent:main:main", storePath },
    seed: (updatedAt = 1, label?: string) =>
      writeSessionStore({ entries: { main: { sessionId: name, updatedAt, label } } }),
  };
}
function expectStoreClosed(storePath: string) {
  expect(listOpenClawAgentDatabasesForTest().some((db) => db.path === storePath)).toBe(false);
}
function expectSelectedStore(storePath: string) {
  const selectedStorePath = getMockedRuntimeConfig().session?.store;
  expect([testState.sessionStorePath, selectedStorePath]).toEqual([storePath, storePath]);
  return selectedStorePath;
}
// These fixtures explicitly own directory disposal after their admitted writers settle.
async function ownedDirectory(name: string) {
  // openclaw-temp-dir: allow verifies explicit store teardown while a writer owns the directory
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-gw-${name}-`)));
}

async function retainGatewayEvent() {
  const root = tryBeginGatewayRootWorkAdmission("test:transcript-event");
  assert(root, "expected gateway root admission");
  try {
    const continuation = await root.run(async () =>
      retainGatewayRootWorkAdmissionContinuationScope(),
    );
    assert(continuation, "expected retained gateway event");
    return continuation;
  } finally {
    root.release();
  }
}

describe("Gateway RPC fixture session writes", () => {
  test("joins the suite projection before revoking a released store's history reader", async () => {
    const { dir, storePath, seed } = storeFixture("projection-release");
    await seed();
    expect((await rpcReq(ws, "chat.history", { sessionKey: "main" })).ok).toBe(true);
    const runtime = getGatewayRecoveryRuntime();
    const projection = getSessionRowProjection(runtime && getGatewayContextResolver(runtime)?.());
    assert(projection, "Suite Gateway projection is missing");
    await projection.ensureMaterialized();
    const entered = createDeferred();
    const release = createDeferred();
    const boundary = createDeferred();
    const runRead = historyWorkers.withSessionHistoryWorkerDatabases;
    let held = false;
    const reads = vi
      .spyOn(historyWorkers, "withSessionHistoryWorkerDatabases")
      .mockImplementation((targets, consume, lane) =>
        runRead(
          targets,
          async (owners) => {
            const result = await consume(owners);
            if (!held && targets.some((target) => target.path === storePath)) {
              held = true;
              entered.resolve();
              await release.promise;
            }
            return result;
          },
          lane,
        ),
      );
    sessionChanges.emit({ all: true, scope: { storePath }, factsInvalidated: true });
    const preparing = projection.ensureMaterialized();
    void preparing.catch(() => {});
    const ensure = projection.ensureMaterialized;
    const join = vi.spyOn(projection, "ensureMaterialized").mockImplementation(() => {
      boundary.resolve();
      return ensure();
    });
    const close = agentDatabaseLifecycle.closeOpenClawAgentDatabasesAsync;
    const closing = vi
      .spyOn(agentDatabaseLifecycle, "closeOpenClawAgentDatabasesAsync")
      .mockImplementation((root) => {
        if (root === dir) {
          boundary.resolve();
        }
        return close(root);
      });
    let releasing: Promise<void> | undefined;
    try {
      await Promise.race([
        entered.promise,
        preparing.then(() => {
          throw new Error("Projection completed without retaining the fixture history read");
        }),
      ]);
      releasing = releaseGatewaySessionStoreFixture(dir);
      void releasing.catch(() => {});
      await boundary.promise;
      release.resolve();
      await expect(preparing).resolves.toBeUndefined();
      await releasing;
      expectStoreClosed(storePath);
    } finally {
      release.resolve();
      await Promise.allSettled([preparing, releasing]);
      reads.mockRestore();
      join.mockRestore();
      closing.mockRestore();
    }
  });

  test.each(["session", "gateway event"] as const)(
    "%s release joins admitted continuations before deselecting their store",
    async (owner) => {
      const { dir, storePath, scope, seed } = storeFixture(
        "admitted-write",
        await ownedDirectory("admitted-writes"),
      );
      await seed();
      const admission =
        owner === "session"
          ? await beginSessionEffect({
              scope: storePath,
              identities: [scope.sessionKey, "admitted-write"],
              assertAllowed: () => {},
            })
          : await retainGatewayEvent();
      // Resolve the canonical path now to hold the selector across a real event-loop turn.
      const realpath = vi.spyOn(fs, "realpath").mockResolvedValueOnce(dir);
      const releasing = releaseSessionTestDirectories([dir]);
      realpath.mockRestore();
      try {
        await yieldToEventLoop();
        const selectedStorePath = expectSelectedStore(storePath);
        await admission.run(() =>
          updateSessionEntry({ ...scope, storePath: selectedStorePath }, () => ({
            label: "late continuation",
          })),
        );
        expect(loadSessionEntry(scope)?.label).toBe("late continuation");
      } finally {
        admission.release();
        await releasing;
        await fs.rm(dir, { recursive: true, force: true });
      }
      expectStoreClosed(storePath);
    },
  );

  test("fixture release joins queued participant persistence before deselecting its store", async () => {
    const { dir, storePath, scope, seed } = storeFixture("participant-join");
    await seed();
    const release = createDeferred();
    const holding = runOpenClawAgentWriteAdmission(
      { agentId: "main", path: storePath },
      () => release.promise,
    );
    const recorded = recordSessionParticipant(scope, {
      identity: { type: "profile", id: "queued-viewer" },
      promptedAt: 1,
    });
    // Observe failures before disposal can revoke the queued operation.
    const outcome = Promise.allSettled([recorded]);
    const releasing = releaseGatewaySessionStoreFixture(dir);
    void releasing.catch(() => {});
    try {
      await yieldToEventLoop();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expectSelectedStore(storePath);
      release.resolve();
      await releasing;
      expect(await outcome).toEqual([{ status: "fulfilled", value: "inserted" }]);
      expect(testState.sessionStorePath).toBeUndefined();
      expectStoreClosed(storePath);
    } finally {
      release.resolve();
      await Promise.allSettled([holding, recorded, releasing]);
    }
  });

  test.each(["rpcReq", "fixture release", "fixture reseed"])(
    "%s preserves queued session writes",
    async (request) => {
      const { dir, storePath, scope, seed } = storeFixture(
        "rpc-writes",
        await ownedDirectory("rpc-writes"),
      );
      const planning = createDeferred();
      const release = createDeferred();
      const writes: Promise<unknown>[] = [];
      let drains: Promise<void>[] = [];
      let reseeding: Promise<void> | undefined;
      try {
        await seed();
        expect((await rpcReq(ws, "sessions.subscribe", {})).ok).toBe(true);
        const first = updateSessionEntry(scope, async () => {
          planning.resolve();
          await release.promise;
          return { label: "first" };
        });
        writes.push(first);
        await planning.promise;
        const second = updateSessionEntry(scope, () => ({ label: "second" }));
        writes.push(second);
        // Observe rejection immediately; retain drains even if the faulty helper drops their map.
        const outcomes = Promise.allSettled(writes);
        drains = [...SQLITE_SESSION_WRITER_QUEUES.values()].flatMap((queue) =>
          queue.drainPromise ? [queue.drainPromise] : [],
        );
        if (request === "rpcReq") {
          expect((await rpcReq(ws, "sessions.subscribe", {})).ok).toBe(true);
        } else if (request === "fixture reseed") {
          reseeding = seed(2, "reseeded");
          void reseeding.catch(() => {});
        } else {
          const releasedDir = path.join(dir, "released");
          const options = {
            agentId: "main",
            path: path.join(releasedDir, "case-0", "openclaw-agent.sqlite"),
          };
          await persistSessionTranscriptTurn(
            {
              agentId: options.agentId,
              sessionId: "fixture-reconcile",
              sessionKey: "agent:main:fixture-reconcile",
              storePath: options.path,
            },
            {
              messages: [
                { eventId: "seed", message: { role: "user", content: "fixture projection" } },
              ],
              touchSessionEntry: false,
            },
          );
          await waitForSessionTranscriptIndexReconcile(options);
          await settleGatewaySessionStoreFixture(releasedDir);
          const database = openOpenClawAgentDatabase(options);
          database.db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
          expect(await closeOpenClawAgentDatabaseByPathAsync(database.path)).toBe(true);

          // Schedule after closing the handle: disposal must join work that has not reopened it yet.
          startSessionTranscriptIndexReconcile(options);
          try {
            await releaseGatewaySessionStoreFixture(releasedDir);
            expect(
              withOpenClawAgentDatabaseReadOnly(
                ({ db }) => listSessionsNeedingTranscriptIndexReconcile(db),
                options,
              ),
            ).toEqual({ found: true, value: [] });
            expectStoreClosed(options.path);
            expect(testState.sessionStorePath).toBe(storePath);
          } finally {
            // Keep a failed release assertion from racing the outer directory removal.
            await waitForSessionTranscriptIndexReconcile(options);
          }
        }
        release.resolve();
        expect(await outcomes).toEqual([
          { status: "fulfilled", value: expect.objectContaining({ label: "first" }) },
          { status: "fulfilled", value: expect.objectContaining({ label: "second" }) },
        ]);
        if (reseeding) {
          await reseeding;
        }
        expect(loadSessionEntry(scope)?.label).toBe(reseeding ? "reseeded" : "second");
      } finally {
        release.resolve();
        await Promise.allSettled([...writes, ...drains, reseeding]);
        // This custom store lives outside the Gateway HOME and owns its own disposal.
        await releaseGatewaySessionStoreFixture(dir);
        await fs.rm(dir, { recursive: true, force: true });
      }
      expectStoreClosed(storePath);
    },
  );
});

describe("Gateway fixture config publication", () => {
  test.each(["reply preparation", "RPC session update"] as const)(
    "%s shares the current fixture with real IO across awaited work",
    async (boundary) => {
      const actual = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
      const { getRuntimeConfig } = await import("../config/io.js");
      for (const agentId of ["worker", "reviewer", undefined]) {
        testState.agentsConfig = agentId
          ? { ownership: "explicit", entries: { main: {}, [agentId]: {} } }
          : undefined;
        testState.sessionConfig =
          boundary === "RPC session update" ? { mainKey: agentId ?? "main" } : undefined;
        const admission =
          boundary === "reply preparation"
            ? prepareGatewayReplyRuntimeForTest({ force: true })
            : listAgents();
        // Real maintenance/finalizer callbacks can read config while admission
        // yields for imports or model preparation, before the RPC is sent.
        const duringAdmission = actual.getRuntimeConfig();
        await admission;
        const expectedAgents = agentId ? ["main", agentId] : ["main"];
        expect(listAgentIds(duringAdmission)).toEqual(expectedAgents);
        if (boundary === "RPC session update") {
          expect(duringAdmission.session?.mainKey).toBe(agentId ?? "main");
        }
        expect(listAgentIds(actual.getRuntimeConfig())).toEqual(expectedAgents);
        expect(getRuntimeConfig()).toEqual(actual.getRuntimeConfig());
        const response = await listAgents();
        expect(response.ok, JSON.stringify(response)).toBe(true);
        expect(response.payload?.agents.map((agent) => agent.id)).toEqual(expectedAgents);
      }
    },
  );

  test("publishes agent-only edits and removals without overwriting authored config", async () => {
    const actual = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
    const { writeConfigFile } = createGatewayConfigOverrides(actual);
    const configPath = process.env.OPENCLAW_CONFIG_PATH!;
    const store = path.join(path.dirname(configPath), "agents", "{agentId}", "sessions.json");
    const authoredConfig = {
      agents: {
        ownership: "explicit",
        entries: { main: { name: "Authored main" } },
        defaults: { userTimezone: "UTC", timeoutSeconds: 90 },
      } satisfies AgentsConfig,
      session: { store },
    };
    await writeConfigFile(authoredConfig);
    const workspace = path.join(path.dirname(configPath), "fixture-workspace");
    const secondary = { name: "Fixture secondary", workspace };
    // Publication must not inject main, even after deletion leaves a sole fixture agent.
    const entries: NonNullable<AgentsConfig["entries"]> = { primary: { workspace }, secondary };
    testState.agentsConfig = { ownership: "explicit", entries };
    testState.agentConfig = { timeoutSeconds: 45 };

    const expectPublished = async (
      expectedEntries: NonNullable<AgentsConfig["entries"]>,
      timeoutSeconds: number,
    ) => {
      const request = listAgents();
      try {
        const realConfig = actual.getRuntimeConfig();
        expect(realConfig.agents?.entries).toEqual(expectedEntries);
        expect(realConfig.agents?.defaults).toMatchObject({ userTimezone: "UTC", timeoutSeconds });
        expect(realConfig.session?.store).toBe(store);
        expect(getMockedRuntimeConfig()).toEqual(realConfig);
        const response = await request;
        expect(response.ok, JSON.stringify(response)).toBe(true);
        expect(response.payload?.agents.map(({ id, name }) => ({ id, name }))).toEqual(
          Object.entries(expectedEntries).map(([id, { name }]) => ({ id, name })),
        );
        expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual(authoredConfig);
      } finally {
        await request;
      }
    };

    await expectPublished(
      { primary: { workspace }, secondary: { name: "Fixture secondary", workspace } },
      45,
    );
    // Entries can alias the published snapshot; the copied default must also refresh.
    secondary.name = "Updated fixture";
    testState.agentConfig.timeoutSeconds = 60;
    await expectPublished(
      { primary: { workspace }, secondary: { name: "Updated fixture", workspace } },
      60,
    );
    delete entries.secondary;
    delete testState.agentConfig.timeoutSeconds;
    await expectPublished({ primary: { workspace } }, 90);
    testState.agentsConfig = undefined;
    testState.agentConfig = undefined;
    await expectPublished({ main: { name: "Authored main" } }, 90);

    authoredConfig.agents.entries.main.name = "Updated file intent";
    await fs.writeFile(configPath, JSON.stringify(authoredConfig));
    testState.agentConfig = { timeoutSeconds: 30 };
    await expectPublished({ main: { name: "Updated file intent" } }, 30);
  });
});
