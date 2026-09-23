import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import * as testPromises from "../../test/helpers/promise.js";
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
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { getGatewayContextResolver } from "../plugins/runtime/gateway-context-binding.js";
import {
  getActiveGatewayRootWorkCount,
  retainGatewayRootWorkAdmissionContinuationScope,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import * as agentDatabaseLifecycle from "../state/openclaw-agent-db-lifecycle.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { listOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.test-support.js";
import {
  runOpenClawAgentWriteAdmission,
  SQLITE_SESSION_WRITER_QUEUES,
} from "../state/openclaw-agent-write-admission.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  registerOpenClawStateDatabaseAsyncResource,
} from "../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  isOpenClawStateDatabaseOpen,
} from "../state/openclaw-state-db.js";
import { getGatewayRecoveryRuntime } from "./server-recovery-runtime-context.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import {
  releaseSessionTestDirectories,
  removeSessionTestDirectories,
} from "./session-test-directories.test-support.js";
import { createGatewayConfigOverrides } from "./test-helpers.config-runtime.js";
import {
  installGatewayTestHooks,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";
import { releaseGatewaySessionStoreFixture } from "./test/server-sessions-resources.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let ws: WebSocket;
installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});

async function retainGatewayEvent() {
  const root = tryBeginGatewayRootWorkAdmission("test:transcript-event");
  if (!root) {
    throw new Error("expected gateway root admission");
  }
  try {
    const continuation = await root.run(async () =>
      retainGatewayRootWorkAdmissionContinuationScope(),
    );
    if (!continuation) {
      throw new Error("expected retained gateway event");
    }
    return continuation;
  } finally {
    root.release();
  }
}

describe("Gateway RPC fixture session writes", () => {
  test("joins the suite projection before revoking a released store's history reader", async () => {
    const dir = tempDirs.make("openclaw-gw-projection-release-");
    const storePath = path.join(dir, "openclaw-agent.sqlite");
    testState.sessionStorePath = storePath;
    await writeSessionStore({
      entries: { main: { sessionId: "projection-release", updatedAt: 1 } },
    });
    expect((await rpcReq(ws, "chat.history", { sessionKey: "main" })).ok).toBe(true);
    const runtime = getGatewayRecoveryRuntime();
    const projection = getSessionRowProjection(runtime && getGatewayContextResolver(runtime)?.());
    if (!projection) {
      throw new Error("Suite Gateway projection is missing");
    }
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
      releasing = releaseGatewaySessionStoreFixture(dir, { settleSuiteProjection: true });
      void releasing.catch(() => {});
      await boundary.promise;
      release.resolve();
      await expect(preparing).resolves.toBeUndefined();
      await releasing;
      expect(
        listOpenClawAgentDatabasesForTest().some((database) => database.path === storePath),
      ).toBe(false);
    } finally {
      release.resolve();
      await Promise.allSettled([preparing, releasing]);
      reads.mockRestore();
      join.mockRestore();
      closing.mockRestore();
    }
  });

  test.each(["complete", "timeout"] as const)(
    "joins client identity database closure before removal (%s)",
    async (outcome) => {
      const dir = tempDirs.make("openclaw-gw-identity-close-");
      const sibling = path.join(tempDirs.make("openclaw-gw-identity-sibling-"), "device.sqlite");
      const identityPath = path.join(dir, "copilot-device.json");
      const identities = [identityPath, path.join(dir, "unpaired-copilot-device.json")];
      for (const pathname of [...identities, sibling]) {
        loadOrCreateDeviceIdentity({ path: pathname });
      }
      const admission = captureOpenClawStateDatabaseReadAdmission(identityPath);
      const closing = createDeferred();
      const release = createDeferred();
      const unregister = registerOpenClawStateDatabaseAsyncResource({
        async close(identity) {
          if (identity?.key === admission.identity.key) {
            closing.resolve();
            await release.promise;
          }
        },
      });
      const withTestTimeout = testPromises.withTestTimeout;
      const deadline =
        outcome === "timeout"
          ? vi
              .spyOn(testPromises, "withTestTimeout")
              .mockImplementation((promise, _ms, message) => withTestTimeout(promise, 0, message))
          : undefined;
      const removing = removeSessionTestDirectories([dir]);
      void removing.catch(() => {});
      try {
        expect(
          await Promise.race([
            closing.promise.then(() => "closing"),
            removing.then(() => "removed"),
          ]),
        ).toBe("closing");
        expect(isOpenClawStateDatabaseOpen(identityPath)).toBe(true);
        await expect(fs.access(dir)).resolves.toBeUndefined();
        if (outcome === "timeout") {
          await expect(removing).rejects.toThrow(
            `Timed out closing shared-state fixture database ${JSON.stringify(identityPath)}`,
          );
          await expect(fs.access(dir)).resolves.toBeUndefined();
        } else {
          release.resolve();
          await removing;
          expect(identities.map((pathname) => isOpenClawStateDatabaseOpen(pathname))).toEqual([
            false,
            false,
          ]);
          await expect(fs.access(dir)).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(isOpenClawStateDatabaseOpen(sibling)).toBe(true);
      } finally {
        deadline?.mockRestore();
        release.resolve();
        await removing.catch(() => {});
        unregister();
        for (const pathname of [...identities, sibling]) {
          await closeOpenClawStateDatabaseByPathAsync(pathname);
        }
      }
    },
  );

  test.each(["session", "gateway event"] as const)(
    "%s release joins admitted continuations before deselecting their store",
    async (owner) => {
      // openclaw-temp-dir: allow verifies explicit store teardown while a writer owns the directory
      const dir = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-admitted-writes-")),
      );
      const storePath = path.join(dir, "openclaw-agent.sqlite");
      testState.sessionStorePath = storePath;
      const scope = { agentId: "main", sessionKey: "agent:main:main", storePath };
      await writeSessionStore({ entries: { main: { sessionId: "admitted-write", updatedAt: 1 } } });
      const admission =
        owner === "session"
          ? await beginSessionWorkAdmission({
              scope: storePath,
              identities: [scope.sessionKey, "admitted-write"],
              assertAllowed: () => {},
            })
          : await retainGatewayEvent();
      // Resolve this fixture's canonical path before the continuation runs, so the
      // release must retain its selector across a real event-loop turn.
      const realpath = vi.spyOn(fs, "realpath").mockResolvedValueOnce(dir);
      const releasing = releaseSessionTestDirectories([dir]);
      realpath.mockRestore();
      try {
        await yieldToEventLoop();
        expect(testState.sessionStorePath).toBe(storePath);
        const selectedStorePath = getMockedRuntimeConfig().session?.store;
        expect(selectedStorePath).toBe(storePath);
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
      expect(
        listOpenClawAgentDatabasesForTest().some((database) => database.path === storePath),
      ).toBe(false);
    },
  );

  test("fixture release joins queued participant persistence before deselecting its store", async () => {
    const dir = tempDirs.make("openclaw-gw-participant-join-");
    const storePath = path.join(dir, "openclaw-agent.sqlite");
    testState.sessionStorePath = storePath;
    const scope = { agentId: "main", sessionKey: "agent:main:main", storePath };
    await writeSessionStore({ entries: { main: { sessionId: "participant-join", updatedAt: 1 } } });
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
    const releasing = releaseGatewaySessionStoreFixture(dir, { settleSuiteProjection: true });
    void releasing.catch(() => {});
    try {
      await yieldToEventLoop();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(testState.sessionStorePath).toBe(storePath);
      expect(getMockedRuntimeConfig().session?.store).toBe(storePath);
      release.resolve();
      await releasing;
      expect(await outcome).toEqual([{ status: "fulfilled", value: "inserted" }]);
      expect(testState.sessionStorePath).toBeUndefined();
      expect(
        listOpenClawAgentDatabasesForTest().some((database) => database.path === storePath),
      ).toBe(false);
    } finally {
      release.resolve();
      await Promise.allSettled([holding, recorded, releasing]);
    }
  });

  test.each(["raw WebSocket", "rpcReq", "fixture release"])(
    "%s preserves queued session writes",
    async (request) => {
      const dir = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-rpc-writes-")),
      );
      const storePath = path.join(dir, "openclaw-agent.sqlite");
      testState.sessionStorePath = storePath;
      const scope = { agentId: "main", sessionKey: "agent:main:main", storePath };
      const planning = createDeferred();
      const release = createDeferred();
      const writes: Promise<unknown>[] = [];
      let drains: Promise<void>[] = [];
      try {
        await writeSessionStore({ entries: { main: { sessionId: "rpc-writes", updatedAt: 1 } } });
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
        } else if (request === "raw WebSocket") {
          const id = "queued-writes-control";
          const response = onceMessage(ws, (event) => event.type === "res" && event.id === id);
          ws.send(JSON.stringify({ type: "req", id, method: "sessions.subscribe", params: {} }));
          expect((await response).ok).toBe(true);
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
          const database = openOpenClawAgentDatabase(options);
          database.db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
          expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);

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
            expect(
              listOpenClawAgentDatabasesForTest().some((entry) => entry.path === options.path),
            ).toBe(false);
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
        expect(loadSessionEntry(scope)?.label).toBe("second");
      } finally {
        release.resolve();
        await Promise.allSettled([...writes, ...drains]);
        // This custom store lives outside the Gateway HOME and owns its own disposal.
        await releaseGatewaySessionStoreFixture(dir);
        await fs.rm(dir, { recursive: true, force: true });
      }
      expect(
        listOpenClawAgentDatabasesForTest().some((database) => database.path === storePath),
      ).toBe(false);
    },
  );
});

describe("Gateway fixture config publication", () => {
  test.each(["RPC admission", "reply preparation", "RPC session update"] as const)(
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
            : rpcReq(ws, "agents.list", {});
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
        const response = await rpcReq<{ agents: Array<{ id: string }> }>(ws, "agents.list", {});
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
      const request = rpcReq<{ agents: Array<{ id: string; name?: string }> }>(
        ws,
        "agents.list",
        {},
      );
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
