import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
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
import { captureEnv, captureFullEnv, setTestEnvValue, withEnv, withEnvAsync } from "./env.js";
import * as sessionCleanup from "./session-state-cleanup.js";

const spyOnDrain = () => vi.spyOn(sessionCleanup, "cleanupSessionStateForTest");

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

const removeOptions = { recursive: true, force: true, maxRetries: 20, retryDelay: 25 };
function makeAuthStore() {
  return {
    version: 1,
    profiles: { "openai:test": { type: "api_key" as const, provider: "openai", key: "sk-test" } },
  };
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
function saveAuthFixture(dir: string) {
  saveAuthProfileStore(makeAuthStore(), dir, {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
}

async function createRollbackFixture() {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "state-rollback-")));
  const owner = createVitestResourceOwner(parent);
  const lifetime = createFixtureLifetime(parent);
  return { parent, owner, lifetime, prefix: path.join(path.basename(parent), "fixture-") };
}

describe("openclaw test state", () => {
  it.each([
    ["realpath", "home", "default", true],
    ["environment", "home", "lifetime", true],
    ["realpath", "home", "default", false],
    ["home", "split", "default", false],
    ["config", "split", "default", false],
    ["environment", "home", "default", false],
    ["environment", "home", "lifetime", false],
  ] as const)(
    "rolls back %s in %s (%s, failed rollback=%s)",
    async (stage, layout, verifier, failedRollback) => {
      const { parent, prefix, owner, lifetime } = await createRollbackFixture();
      const environment = captureFullEnv();
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
      const keys = [
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "OPENCLAW_HOME",
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_CONFIG_PATH",
        "OPENCLAW_AGENT_DIR",
        "PI_CODING_AGENT_DIR",
        "OPENCLAW_ACQUISITION_EMPTY",
        "OPENCLAW_ACQUISITION_ABSENT",
      ];
      const previous = readEnv(keys);
      const observation = createDeferredCore<typeof previous>();
      const unrelated = openOpenClawStateDatabase({
        env: { OPENCLAW_STATE_DIR: path.join(parent, "unrelated") },
      });
      const fault = new Error(`failed ${stage} acquisition`);
      const rollbackFault = new Error("state acquisition rollback failed");
      const { mkdtemp, rm, mkdir, writeFile } = fs;
      const set = Reflect.set;
      let allocatedRoot: string | undefined;
      let writes = 0;
      const allocation = vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
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
                      queueMicrotask(() => observation.resolve(readEnv(keys)));
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
      const expectRestored = async () => {
        expectEnv(previous);
        expect((await fs.readdir(parent)).toSorted()).toEqual([
          ".vitest-resource-owner",
          "unrelated",
        ]);
        expect(unrelated.db.isOpen).toBe(true);
      };
      try {
        await expect(
          lifetime.run(() =>
            createTestState({
              prefix,
              layout,
              scenario: "minimal",
              applyEnv: stage !== "config",
              verifyCleanup:
                failedRollback || verifier === "lifetime" ? lifetime.verifyCleanup : undefined,
              env: { OPENCLAW_ACQUISITION_EMPTY: "changed", OPENCLAW_ACQUISITION_ABSENT: "added" },
            }),
          ),
        ).rejects.toBe(failedRollback ? rollbackFault : fault);
        expect(drain).not.toHaveBeenCalled();
        if (failedRollback) {
          if (stage === "environment") {
            expect(writes).toBe(2);
            expect(process.env.HOME).toBe(previousHome);
            expect(removal).not.toHaveBeenCalled();
            await expect(lifetime.cleanup()).rejects.toMatchObject({ errors: [rollbackFault] });
            expect(removal).not.toHaveBeenCalled();
          } else {
            await expect(lifetime.cleanup()).rejects.toThrow("Fixture cleanup unverified");
          }
          expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
          expect(allocatedRoot).toBeDefined();
          await expect(fs.stat(allocatedRoot!)).resolves.toBeDefined();
        } else {
          if (stage === "environment") {
            expect(await observation.promise).toEqual(previous);
          }
          await lifetime.cleanup();
          expect(() => owner.assertReleased()).not.toThrow();
          await expectRestored();
          injected.mockRestore();
          const recovered = await createTestState({
            prefix,
            layout: "split",
            scenario: "minimal",
            applyEnv: false,
          });
          try {
            expectEnv(previous);
            expect(recovered.configPath).toBe(path.join(recovered.root, "config", "openclaw.json"));
            expect(JSON.parse(await fs.readFile(recovered.configPath, "utf8"))).toEqual({});
            recovered.applyEnv();
            expectEnv({ HOME: recovered.home, OPENCLAW_STATE_DIR: recovered.stateDir });
          } finally {
            await recovered.cleanup();
          }
          await recovered.cleanup();
          await expectRestored();
        }
      } finally {
        for (const spy of [allocation, removal, drain, injected]) {
          spy.mockRestore();
        }
        environment.restore();
        try {
          await lifetime.cleanup().catch((error: unknown) => {
            if (!failedRollback) {
              throw error;
            }
          });
        } finally {
          stateCache.closeOpenClawStateDatabaseByPath(unrelated.path);
          await fs.rm(parent, { recursive: true, force: true });
        }
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

  it.each(["cleanup", "restoreEnv"] as const)(
    "joins concurrent %s callers before restoring selectors",
    async (method) => {
      const state = await createTestState({ label: "concurrent-release" });
      const gate = createDeferredCore();
      const drain = spyOnDrain().mockReturnValue(gate.promise);
      const settled: number[] = [];
      const releases = [0, 1].map((index) =>
        Promise.resolve(state[method]()).then(() => settled.push(index)),
      );
      try {
        await nextTurn();
        expect.soft(settled).toEqual([]);
        expect.soft(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
        expect.soft(drain).toHaveBeenCalledOnce();
      } finally {
        gate.resolve();
        await Promise.all(releases);
        drain.mockRestore();
        await state.cleanup();
      }
      expect(settled).toHaveLength(2);
      expect(() => state.applyEnv()).toThrow("released OpenClaw test state");
    },
  );

  it.each(["cleanup", "restoreEnv"] as const)(
    "retains selectors and files when %s cannot drain",
    async (method) => {
      const environment = captureFullEnv();
      const state = await createTestState({ label: "failed-release" });
      const fault = new Error("synthetic drain failed");
      const drain = spyOnDrain().mockRejectedValue(fault);
      try {
        const results = await Promise.allSettled([state[method](), state[method]()]);
        expect.soft(results).toEqual([
          { status: "rejected", reason: fault },
          { status: "rejected", reason: fault },
        ]);
        expect.soft(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
        await expect.soft(fs.stat(state.root)).resolves.toBeDefined();
      } finally {
        // The injected drain has settled and owns no real work. Dispose this
        // deliberately retained fixture without borrowing a failed release API.
        drain.mockRestore();
        environment.restore();
        await fs.rm(state.root, { recursive: true, force: true });
      }
    },
  );

  it("restores late env additions before the next fixture", async () => {
    const previous = {
      OPENCLAW_TEST_LATE_ABSENT: undefined,
      OPENCLAW_TEST_LATE_EMPTY: "",
      OPENCLAW_TEST_LATE_PRESENT: "original",
    };
    await withEnvAsync(previous, async () => {
      const state = await createTestState({ label: "late-env" });
      try {
        const first = {
          OPENCLAW_TEST_LATE_ABSENT: "first",
          OPENCLAW_TEST_LATE_EMPTY: "first",
          OPENCLAW_TEST_LATE_PRESENT: undefined,
        };
        Object.assign(state.envVars, first);
        state.applyEnv();
        expectEnv(first);
        for (const key of Object.keys(previous)) {
          state.envVars[key] = "second";
        }
        state.applyEnv();
        for (const key of Object.keys(previous)) {
          expect(process.env[key]).toBe("second");
        }
      } finally {
        await state.cleanup();
      }
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
      const previous = override
        ? { OPENCLAW_AGENT_DIR: undefined, PI_CODING_AGENT_DIR: "" }
        : {
            OPENCLAW_AGENT_DIR: "/tmp/outside-openclaw-agent",
            PI_CODING_AGENT_DIR: "/tmp/outside-legacy-agent",
          };
      const explicit = {
        OPENCLAW_AGENT_DIR: "/tmp/explicit-openclaw-agent",
        PI_CODING_AGENT_DIR: "/tmp/explicit-legacy-agent",
      };
      await withEnvAsync(previous, async () => {
        await withTestState(
          {
            layout: agentEnv === "main" ? "home" : "state-only",
            agentEnv,
            applyEnv,
            env: override ? explicit : undefined,
          },
          async (state) => {
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
          },
        );
        expectEnv(previous);
      });
    },
  );

  it("writes the stable-update scenario config", async () => {
    await withTestState({ scenario: "update-stable" }, async (state) => {
      expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual({
        update: { channel: "stable" },
        plugins: {},
      });
    });
  });

  it.each(["state", "configured"])(
    "closes only fixture-owned %s databases before restoring env",
    async (location) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      const state = await createTestState({ layout: "state-only", label: "database-cleanup" });
      const sibling = `${state.root}-sibling`;
      const openSpy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      const open = (stateDir: string, configured?: string) => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const authDir = path.join(configured ?? stateDir, "agents", "auth", "agent");
        // Auth's retained agent lease must release into this root's shared database.
        withEnv(env, () => saveAuthFixture(authDir));
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
      const expectCurrent = (owner: typeof fixture.memory) => {
        expect(memorySessionActorOwners.read(owner)).toBe(owner);
        expect(() => owner.assertCurrent()).not.toThrow();
      };
      const expectUnrelated = () => {
        expectOpen(true, unrelated.reader, unrelated.shared.db, unrelated.agent.db);
        expectCurrent(unrelated.memory);
        expect(admitted()).toContain(unrelated.agent.path);
      };
      const expectClosed = () => {
        expectOpen(false, fixture.reader, fixture.agent.db, fixture.shared.db);
        expect(
          stateCache.openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(
            fixture.shared.path,
          ),
        ).toBeUndefined();
        expect(memorySessionActorOwners.read(fixture.memory)).toBeUndefined();
        expect(() => fixture.memory.assertCurrent()).toThrow("closed");
        expect(admitted()).not.toContain(fixture.agent.path);
        expectUnrelated();
      };
      const remove = fs.rm;
      const removal = vi.spyOn(fs, "rm").mockImplementation((...args) => {
        expectClosed();
        return remove(...args);
      });
      const restore = state.restoreEnv;
      state.restoreEnv = async () => {
        expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
        await restore();
        expectClosed();
      };
      try {
        await sessionCleanup.cleanupSessionStateForTest();
        expectOpen(true, fixture.reader);
        expectCurrent(fixture.memory);
        expect(admitted()).toContain(fixture.agent.path);
        expectUnrelated();
        await state.cleanup();
        expect(process.env.OPENCLAW_STATE_DIR).toBe(previousStateDir);
        expect(removal).toHaveBeenCalledWith(state.root, removeOptions);
        await expectPathMissing(state.root);
        expectUnrelated();
        await sessionCleanup.cleanupSessionStateForTest({ stateDir: sibling });
        // Closing the sibling must not reopen the already-removed fixture database.
        await expectPathMissing(state.root);
      } finally {
        state.restoreEnv = restore;
        openSpy.mockRestore();
        removal.mockRestore();
        await restore();
        await sessionCleanup.cleanupSessionStateForTest({ stateDir: sibling });
        await fs.rm(state.root, removeOptions);
        await fs.rm(sibling, removeOptions);
      }
    },
  );

  it.each(["state", "configured", "store", "sqlite"] as const)(
    "drains %s work before removing fixture databases",
    async (location) => {
      const state = await createTestState({ label: "deferred-reconcile" });
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
      const isWriter = location === "store" || location === "sqlite";
      const runOperation = reconcilePool.runSessionTranscriptReconcileOperation;
      const operationSpy = vi
        .spyOn(reconcilePool, "runSessionTranscriptReconcileOperation")
        .mockImplementationOnce((run, owner) =>
          runOperation(async (operation) => {
            entered.resolve();
            await resumeReconcile.promise;
            return run(operation);
          }, owner),
        );
      const rmSpy = vi.spyOn(fs, "rm");
      const openSpy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      let cleanup: Promise<void> | undefined;
      let reconcile: Promise<void> | undefined;
      try {
        if (isWriter) {
          const write = async () => {
            entered.resolve();
            await resumeReconcile.promise;
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
          expect(reconcileIndex.isSessionTranscriptIndexReconcileRunning(options)).toBe(true);
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
        expect(rmSpy.mock.calls.some(([target]) => target === state.root)).toBe(false);
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
        if (!isWriter) {
          const agentPath = agent.path;
          expect(openSpy.mock.calls.filter(([pathname]) => pathname === agentPath)).toEqual([]);
        }
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
        await state.cleanup();
        openSpy.mockRestore();
        rmSpy.mockRestore();
        await fs.rm(state.root, { recursive: true, force: true });
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
      const environment = captureEnv(selectorKeys);
      const previous = selectorKeys.map((key) => process.env[key]);
      let root = "";
      let runtimePath = "";
      let shared: ReturnType<typeof openOpenClawStateDatabase> | undefined;
      let agent: ReturnType<typeof agentDb.openOpenClawAgentDatabase> | undefined;

      try {
        await expect(
          withTestState({ label: "callback-failure" }, async (state) => {
            root = state.root;
            runtimePath = await state.writeText("runtime/entry.mjs", source);
            shared = openOpenClawStateDatabase({ env: state.env });
            agent = agentDb.openOpenClawAgentDatabase({ agentId: "main", env: state.env });
            if (failure === "caught indeterminate") {
              await trackAsyncWork(async () => {
                throw callbackError;
              }).catch(() => undefined);
              return;
            }
            throw callbackError;
          }),
        ).rejects.toBe(callbackError);

        expect({ shared, agent }).toMatchObject({
          shared: { db: { isOpen: false } },
          agent: { db: { isOpen: false } },
        });
        expect(selectorKeys.map((key) => process.env[key])).toEqual(previous);
        if (failure === "ordinary") {
          await expectPathMissing(root);
        } else {
          expect(await fs.readFile(runtimePath, "utf8")).toBe(source);
        }
      } finally {
        environment.restore();
        if (agent) {
          agentDb.closeOpenClawAgentDatabaseByPath(agent.path);
        }
        if (shared) {
          stateCache.closeOpenClawStateDatabaseByPath(shared.path);
        }
        // This synthetic failure owns no native child; dispose only its retained test inputs.
        if (root) {
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    },
  );

  it("creates upgrade survivor fixture state", async () => {
    await withTestState({ scenario: "upgrade-survivor" }, async (state) => {
      expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toMatchObject({
        update: { channel: "stable" },
        plugins: { enabled: true, allow: ["discord", "telegram", "whatsapp", "memory"] },
      });
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
});
