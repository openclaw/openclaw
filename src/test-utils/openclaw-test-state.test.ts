import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import * as authDb from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import { runExclusiveSqliteSessionWrite } from "../config/sessions/session-accessor.sqlite-scope.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import * as reconcilePool from "../config/sessions/session-transcript-reconcile-pool.js";
import * as reconcileIndex from "../config/sessions/session-transcript-reconcile.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import { describeAdmittedDatabaseStores } from "../infra/database-engine/admitted-diagnostics.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import {
  createOpenClawTestState as createTestState,
  withOpenClawTestState as withTestState,
} from "../plugin-sdk/test-state.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as agentDb from "../state/openclaw-agent-db.js";
import * as stateCache from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureFullEnv, setTestEnvValue, withEnv, withEnvAsync } from "./env.js";
import * as sessionCleanup from "./session-state-cleanup.js";

const spyOnDrain = () => vi.spyOn(sessionCleanup, "cleanupSessionStateForTest");

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

const removeOptions = { recursive: true, force: true, maxRetries: 20, retryDelay: 25 };
const cleanups: (() => Promise<void>)[] = [];
let environment: ReturnType<typeof captureFullEnv>;
beforeEach(() => {
  environment = captureFullEnv();
});
afterEach(async () => {
  vi.restoreAllMocks();
  try {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  } finally {
    environment.restore();
  }
});
function ownDatabaseRoot(root: string, stateDir: string) {
  cleanups.push(async () => {
    await sessionCleanup.cleanupSessionStateForTest({ rootPath: root, stateDir });
    await fs.rm(root, removeOptions);
  });
}
async function createFixture(options: Parameters<typeof createTestState>[0]) {
  const state = await createTestState(options);
  ownDatabaseRoot(state.root, state.stateDir);
  return state;
}
const readEnv = (keys: string[], env = process.env) =>
  Object.fromEntries(keys.map((key) => [key, env[key]]));
function expectEnv(expected: NodeJS.ProcessEnv, env = process.env) {
  expect(readEnv(Object.keys(expected), env)).toEqual(expected);
}
function expectOpen(isOpen: boolean, ...databases: Pick<DatabaseSync, "isOpen">[]) {
  for (const database of databases) {
    expect(database).toMatchObject({ isOpen });
  }
}
it.each([
  ["realpath", "home", "default", true],
  ["environment", "home", "custom", true],
  ["realpath", "home", "default", false],
  ["home", "split", "default", false],
  ["config", "split", "default", false],
  ["environment", "home", "default", false],
  ["environment", "home", "custom", false],
] as const)(
  "rolls back %s in %s (%s, failed rollback=%s)",
  async (stage, layout, verifier, failedRollback) => {
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "state-rollback-")));
    const prefix = path.join(path.basename(parent), "fixture-");
    cleanups.push(() => fs.rm(parent, removeOptions));
    const previousHome = path.join(parent, "previous-home");
    const inherited = {
      HOME: previousHome,
      OPENCLAW_AGENT_DIR: path.join(parent, "previous-agent"),
      PI_CODING_AGENT_DIR: path.join(parent, "previous-legacy-agent"),
      OPENCLAW_ACQUISITION_EMPTY: "",
    };
    for (const [key, value] of Object.entries(inherited)) {
      setTestEnvValue(key, value);
    }
    Reflect.deleteProperty(process.env, "OPENCLAW_ACQUISITION_ABSENT");
    const previous = { ...process.env };
    const observation = createDeferredCore<typeof previous>();
    const fault = new Error(`failed ${stage} acquisition`);
    const rollbackFault = new Error("state acquisition rollback failed");
    const { mkdtemp, rm, mkdir, writeFile } = fs;
    const set = Reflect.set;
    let allocatedRoot: string | undefined;
    let writes = 0;
    vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
      const root = await mkdtemp(...args);
      if (args[0].endsWith(prefix)) {
        allocatedRoot = root;
      }
      return root;
    });
    const removal = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      if (failedRollback && stage === "realpath" && args[0] === allocatedRoot) {
        throw rollbackFault;
      }
      return rm(...args);
    });
    const drain = spyOnDrain();
    const injected =
      stage === "realpath"
        ? vi.spyOn(fs, "realpath").mockRejectedValueOnce(fault)
        : stage === "config"
          ? vi.spyOn(fs, "writeFile").mockImplementationOnce(async (...args) => {
              await writeFile(...args);
              throw fault;
            })
          : stage === "environment"
            ? vi.spyOn(Reflect, "set").mockImplementation((...args) => {
                const result = set(...args);
                if (args[0] === process.env && args[1] === "HOME") {
                  writes++;
                  if (!failedRollback || writes === 2) {
                    injected.mockRestore();
                  }
                  if (!failedRollback) {
                    queueMicrotask(() => observation.resolve({ ...process.env }));
                  }
                  throw writes === 1 ? fault : rollbackFault;
                }
                return result;
              })
            : vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
                const result = await mkdir(...args);
                if (path.basename(String(args[0])) === stage) {
                  throw fault;
                }
                return result;
              });
    const verifyCleanup =
      failedRollback || verifier === "custom"
        ? vi.fn((cleanup: () => Promise<void>) => cleanup())
        : undefined;
    await expect(
      createTestState({
        prefix,
        layout,
        scenario: "minimal",
        applyEnv: stage !== "config",
        verifyCleanup,
        env: { OPENCLAW_ACQUISITION_EMPTY: "changed", OPENCLAW_ACQUISITION_ABSENT: "added" },
      }),
    ).rejects.toBe(failedRollback ? rollbackFault : fault);
    expect(drain).not.toHaveBeenCalled();
    if (verifyCleanup) {
      expect(verifyCleanup).toHaveBeenCalledOnce();
    }
    if (failedRollback) {
      await expect(fs.stat(allocatedRoot!)).resolves.toBeDefined();
      if (stage === "environment") {
        expect(process.env.HOME).toBe(previousHome);
        expect(removal).not.toHaveBeenCalled();
      }
    } else {
      if (stage === "environment") {
        expect(await observation.promise).toEqual(previous);
      }
      expect(process.env).toEqual(previous);
      expect(await fs.readdir(parent)).toEqual([]);
    }
  },
);

it("joins callback descendants before beginning state release", async () => {
  const gate = createDeferredCore();
  const entered = createDeferredCore();
  let background: Promise<void> | undefined;
  let fixtureStateDir: string | undefined;
  let selectedStateDir: string | undefined;
  const observedCleanup = spyOnDrain();
  const operation = withTestState({ label: "callback-descendant" }, async (state) => {
    fixtureStateDir = state.stateDir;
    background = trackAsyncWork(async () => {
      entered.resolve();
      await gate.promise;
      selectedStateDir = process.env.OPENCLAW_STATE_DIR;
    });
  });
  try {
    await entered.promise;
    await nextTurn();
    expect.soft(observedCleanup).not.toHaveBeenCalled();
    expect.soft(process.env.OPENCLAW_STATE_DIR).toBe(fixtureStateDir);
  } finally {
    gate.resolve();
    await background;
    await operation;
    observedCleanup.mockRestore();
  }
  expect(selectedStateDir).toBe(fixtureStateDir);
});

it.each([
  ["cleanup", false],
  ["restoreEnv", false],
  ["cleanup", true],
  ["restoreEnv", true],
] as const)("joins %s callers (drain fails=%s)", async (method, fails) => {
  const state = await createFixture({ label: "concurrent-release" });
  const gate = createDeferredCore();
  const drain = spyOnDrain().mockReturnValue(gate.promise);
  const fault = new Error("synthetic drain failed");
  let settled = false;
  const releases = Promise.allSettled([state[method](), state[method]()]);
  void releases.then(() => {
    settled = true;
  });
  try {
    await nextTurn();
    expect.soft(settled).toBe(false);
    expect.soft(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
    expect.soft(drain).toHaveBeenCalledOnce();
  } finally {
    if (fails) {
      gate.reject(fault);
    } else {
      gate.resolve();
    }
    await releases;
    drain.mockRestore();
  }
  expect(await releases).toEqual(
    Array.from({ length: 2 }, () =>
      fails ? { status: "rejected", reason: fault } : { status: "fulfilled", value: undefined },
    ),
  );
  if (fails) {
    expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
    await expect(fs.stat(state.root)).resolves.toBeDefined();
  } else {
    await state.cleanup();
    expect(() => state.applyEnv()).toThrow("released OpenClaw test state");
  }
});

it("restores late env additions before the next fixture", async () => {
  const previous = {
    OPENCLAW_TEST_LATE_ABSENT: undefined,
    OPENCLAW_TEST_LATE_EMPTY: "",
    OPENCLAW_TEST_LATE_PRESENT: "original",
  };
  await withEnvAsync(previous, async () => {
    const state = await createFixture({ layout: "split", scenario: "minimal", applyEnv: false });
    expect(state.configPath).toBe(path.join(state.root, "config", "openclaw.json"));
    expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual({});
    const first = {
      OPENCLAW_TEST_LATE_ABSENT: "first",
      OPENCLAW_TEST_LATE_EMPTY: "first",
      OPENCLAW_TEST_LATE_PRESENT: undefined,
    };
    Object.assign(state.envVars, first);
    state.applyEnv();
    expectEnv(first);
    expectEnv({ HOME: state.home, OPENCLAW_STATE_DIR: state.stateDir });
    for (const key of Object.keys(previous)) {
      state.envVars[key] = "second";
    }
    state.applyEnv();
    for (const key of Object.keys(previous)) {
      expect(process.env[key]).toBe("second");
    }
    await state.cleanup();
    await state.cleanup();
    await withTestState({ label: "after-late-env" }, async (next) => {
      expectEnv(previous);
      expectEnv(previous, next.env);
    });
  });
});

it.each([
  [undefined, true, false],
  [undefined, false, false],
  ["main", true, false],
  ["main", false, true],
] as const)(
  "isolates agent selectors (agent=%s, apply=%s, override=%s)",
  async (agentEnv, applyEnv, override) => {
    const previous = {
      OPENCLAW_AGENT_DIR: "/tmp/outside-openclaw-agent",
      PI_CODING_AGENT_DIR: "/tmp/outside-legacy-agent",
    };
    const explicit = {
      OPENCLAW_AGENT_DIR: "/tmp/explicit-openclaw-agent",
      PI_CODING_AGENT_DIR: "/tmp/explicit-legacy-agent",
    };
    await withEnvAsync(previous, async () => {
      const state = await createFixture({
        layout: agentEnv === "main" ? "home" : "state-only",
        agentEnv,
        applyEnv,
        env: override ? explicit : undefined,
      });
      const selectors = override
        ? explicit
        : {
            OPENCLAW_AGENT_DIR: agentEnv === "main" ? state.agentDir() : undefined,
            PI_CODING_AGENT_DIR: undefined,
          };
      expectEnv(selectors, state.env);
      expectEnv(applyEnv ? selectors : previous);
      expect(state.agentDir()).toBe(path.join(state.stateDir, "agents", "main", "agent"));
      if (override) {
        state.applyEnv();
        expectEnv(explicit);
      }
      await state.cleanup();
      expectEnv(previous);
    });
  },
);

it("writes the stable-update scenario config", async () => {
  const state = await createFixture({ scenario: "update-stable" });
  expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual({
    update: { channel: "stable" },
    plugins: {},
  });
});

it.each(["state", "configured"])(
  "closes only fixture-owned %s databases before restoring env",
  async (location) => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const state = await createFixture({ layout: "state-only", label: "database-cleanup" });
    const sibling = `${state.root}-sibling`;
    ownDatabaseRoot(sibling, sibling);
    const openSpy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
    const open = (stateDir: string, configured?: string) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const authDir = path.join(configured ?? stateDir, "agents", "auth", "agent");
      // Auth's retained agent lease must release into this root's shared database.
      withEnv(env, () =>
        saveAuthProfileStore({ version: 1, profiles: {} }, authDir, {
          filterExternalAuthProfiles: false,
          syncExternalCli: false,
        }),
      );
      const shared = openOpenClawStateDatabase({ env });
      const agent = agentDb.openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: configured && path.join(configured, "openclaw-agent.sqlite"),
      });
      const authPath = authDb.resolveAuthProfileDatabasePath(authDir);
      // Observe the real pooled reader, not a second connection opened by the test.
      openSpy.mockClear();
      expect(loadPersistedAuthProfileStore(authDir)).not.toBeNull();
      const result = openSpy.mock.results.find(
        (_, index) =>
          openSpy.mock.calls[index]?.[1]?.readOnly &&
          path.resolve(openSpy.mock.calls[index]![0]) === path.resolve(authPath),
      );
      if (result?.type !== "return") {
        throw new Error("expected pooled auth reader");
      }
      const reader = result.value;
      const memory = memorySessionActorOwners.get({
        agentId: "main",
        path: path.join(authDir, "incognito-openclaw-agent.sqlite"),
      });
      return { shared, agent, reader, memory };
    };
    const fixture = open(
      state.stateDir,
      location === "configured" ? state.path("configured") : undefined,
    );
    const unrelated = open(sibling);
    const admitted = () =>
      describeAdmittedDatabaseStores({}).map(({ path: storePath }) => storePath);
    const expectOwner = (owner: typeof fixture, isOpen: boolean) => {
      expectOpen(isOpen, owner.reader, owner.shared.db, owner.agent.db);
      expect(memorySessionActorOwners.read(owner.memory)).toBe(isOpen ? owner.memory : undefined);
      expect(admitted().includes(owner.agent.path)).toBe(isOpen);
      if (isOpen) {
        expect(() => owner.memory.assertCurrent()).not.toThrow();
      } else {
        expect(() => owner.memory.assertCurrent()).toThrow("closed");
      }
    };
    const expectClosed = () => {
      expectOwner(fixture, false);
      expectOwner(unrelated, true);
    };
    const remove = fs.rm;
    vi.spyOn(fs, "rm").mockImplementation((...args) => {
      expectClosed();
      return remove(...args);
    });
    const restore = state.restoreEnv;
    state.restoreEnv = async () => {
      expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
      await restore();
      expectClosed();
    };
    await sessionCleanup.cleanupSessionStateForTest();
    expectOwner(fixture, true);
    expectOwner(unrelated, true);
    await state.cleanup();
    expect(process.env.OPENCLAW_STATE_DIR).toBe(previousStateDir);
    await expectPathMissing(state.root);
    expectOwner(unrelated, true);
    await sessionCleanup.cleanupSessionStateForTest({ stateDir: sibling });
    // Closing the sibling must not reopen the already-removed fixture database.
    await expectPathMissing(state.root);
  },
);

it.each(["state", "configured", "store", "sqlite"] as const)(
  "drains %s work before removing fixture databases",
  async (location) => {
    const state = await createFixture({ label: "deferred-reconcile" });
    const options = {
      agentId: "main",
      env: state.env,
      path:
        location === "configured" ? state.path("configured", "openclaw-agent.sqlite") : undefined,
    };
    let agent = location === "sqlite" ? undefined : agentDb.openOpenClawAgentDatabase(options);
    const shared = openOpenClawStateDatabase({ env: state.env });
    const resumeReconcile = createDeferredCore();
    const entered = createDeferredCore();
    const pause = async () => {
      entered.resolve();
      await resumeReconcile.promise;
    };
    const isWriter = location === "store" || location === "sqlite";
    const runOperation = reconcilePool.runSessionTranscriptReconcileOperation;
    const operationSpy = vi
      .spyOn(reconcilePool, "runSessionTranscriptReconcileOperation")
      .mockImplementationOnce((run, owner) =>
        runOperation(async (operation) => {
          await pause();
          return run(operation);
        }, owner),
      );
    let cleanup: Promise<void> | undefined;
    let reconcile: Promise<void> | undefined;
    try {
      if (isWriter) {
        const write = async () => {
          await pause();
          if (location === "sqlite") {
            agent = agentDb.openOpenClawAgentDatabase(options);
          }
        };
        reconcile =
          location === "store"
            ? runExclusiveSessionStoreWrite(state.path("sessions.json"), write)
            : runExclusiveSqliteSessionWrite(options, write, "session.transcript.batch");
      } else {
        reconcileIndex.startSessionTranscriptIndexReconcile(options);
        reconcile = reconcileIndex.waitForSessionTranscriptIndexReconcile(options);
      }
      await entered.promise;
      let settled = false;
      cleanup = (
        location === "store" ? sessionCleanup.cleanupSessionStateForTest() : state.cleanup()
      ).then(() => {
        settled = true;
      });

      // Empty drains settle before this real event-loop checkpoint. Old cleanup
      // reaches rm; repaired cleanup must keep the fixture alive for the owner.
      await nextTurn();
      expect(settled).toBe(false);
      await expect(fs.stat(state.root)).resolves.toBeDefined();
      expect(agent?.db.isOpen).toBe(location === "sqlite" ? undefined : true);
      expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
      resumeReconcile.resolve();
      await reconcile;
      await cleanup;
      if (location === "store") {
        await state.cleanup();
      }

      if (!agent) {
        throw new Error("writer did not open its database");
      }
      for (const target of [state.root, agent.path, shared.path]) {
        await expectPathMissing(target);
      }
      expect(agentDb.isOpenClawAgentDatabaseOpen(agent.path)).toBe(false);
      expectOpen(false, agent.db, shared.db);
    } finally {
      operationSpy.mockRestore();
      resumeReconcile.resolve();
      await reconcile;
      // A failing implementation can reach removal with a configured handle
      // still open. Release it after its reconcile joins, before joining rm.
      if (agent) {
        agentDb.closeOpenClawAgentDatabaseByPath(agent.path);
      }
      stateCache.closeOpenClawStateDatabaseByPath(shared.path);
      await cleanup;
    }
  },
);

it.each(["ordinary", "indeterminate", "caught indeterminate"] as const)(
  "preserves %s callback failures after closing fixture databases",
  async (failure) => {
    const source = "export const fixture = true;\n";
    const callbackError = Object.assign(
      new Error("fixture callback failed"),
      failure === "ordinary" ? {} : { processTreeState: "indeterminate" },
    );
    const selectorKeys = ["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"];
    const previous = selectorKeys.map((key) => process.env[key]);
    let root = "";
    let runtimePath = "";
    const databases: Pick<DatabaseSync, "isOpen">[] = [];

    await expect(
      withTestState({ label: "callback-failure" }, async (state) => {
        root = state.root;
        ownDatabaseRoot(root, state.stateDir);
        runtimePath = await state.writeText("runtime/entry.mjs", source);
        databases.push(
          openOpenClawStateDatabase({ env: state.env }).db,
          agentDb.openOpenClawAgentDatabase({ agentId: "main", env: state.env }).db,
        );
        if (failure === "caught indeterminate") {
          await trackAsyncWork(async () => {
            throw callbackError;
          }).catch(() => undefined);
          return;
        }
        throw callbackError;
      }),
    ).rejects.toBe(callbackError);

    expectOpen(false, ...databases);
    expect(selectorKeys.map((key) => process.env[key])).toEqual(previous);
    if (failure === "ordinary") {
      await expectPathMissing(root);
    } else {
      expect(await fs.readFile(runtimePath, "utf8")).toBe(source);
    }
  },
);

it("creates upgrade survivor fixture state", async () => {
  const state = await createFixture({ scenario: "upgrade-survivor" });
  expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toMatchObject({
    update: { channel: "stable" },
    plugins: { enabled: true, allow: ["discord", "telegram", "whatsapp", "memory"] },
  });
});

it("keeps external-service env scoped to the fixture", async () => {
  const previousPolicy = process.env.OPENCLAW_SERVICE_REPAIR_POLICY;

  await withTestState({ scenario: "external-service" }, async (state) => {
    expect(process.env.OPENCLAW_SERVICE_REPAIR_POLICY).toBe("external");
    expect(state.env.OPENCLAW_SERVICE_REPAIR_POLICY).toBe("external");
  });

  expect(process.env.OPENCLAW_SERVICE_REPAIR_POLICY).toBe(previousPolicy);
});
