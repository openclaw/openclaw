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
import * as reconcilePool from "../config/sessions/session-transcript-reconcile-pool.js";
import * as reconcileIndex from "../config/sessions/session-transcript-reconcile.js";
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
import { captureEnv, captureFullEnv, setTestEnvValue, withEnvAsync } from "./env.js";
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

  it("writes scenario configs and auth profile stores", async () => {
    await withTestState({ scenario: "update-stable" }, async (state) => {
      expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual({
        update: { channel: "stable" },
        plugins: {},
      });
      const profilePath = await state.writeAuthProfiles(makeAuthStore());
      expect(profilePath).toBe(path.join(state.agentDir(), "openclaw-agent.sqlite"));
      expect(loadPersistedAuthProfileStore(state.agentDir())).toMatchObject({
        version: 1,
        profiles: { "openai:test": { provider: "openai" } },
      });
    });
  });

  it.each(["state", "configured"])(
    "closes only fixture-owned %s databases before restoring env",
    async (location) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      const unrelatedRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-test-state-unrelated-"),
      );
      const unrelatedEnv = {
        ...process.env,
        OPENCLAW_STATE_DIR: path.join(unrelatedRoot, "state"),
      };
      const state = await createTestState({ layout: "state-only", label: "database-cleanup" });
      const fixtureAuthDir =
        location === "configured" ? state.path("configured-auth") : state.agentDir("auth-reader");
      const fixtureAuthPath = authDb.resolveAuthProfileDatabasePath(fixtureAuthDir);
      saveAuthFixture(fixtureAuthDir);
      const unrelatedAgentDir = path.join(unrelatedRoot, "state", "agents", "outside", "agent");
      saveAuthFixture(unrelatedAgentDir);
      const fixtureShared = openOpenClawStateDatabase({ env: state.env });
      const fixtureAgent = agentDb.openOpenClawAgentDatabase({
        agentId: "worker",
        env: state.env,
        path:
          location === "configured" ? state.path("configured", "openclaw-agent.sqlite") : undefined,
      });
      const unrelatedShared = openOpenClawStateDatabase({ env: unrelatedEnv });
      const unrelatedAgent = agentDb.openOpenClawAgentDatabase({
        agentId: "outside",
        env: unrelatedEnv,
      });
      const openSpy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      const loadReader = (dir: string, expectedPath: string) => {
        expect(loadPersistedAuthProfileStore(dir)).not.toBeNull();
        const result = openSpy.mock.results.find((_, index) => {
          const call = openSpy.mock.calls[index];
          return (
            call?.[1]?.readOnly === true && path.resolve(call[0]) === path.resolve(expectedPath)
          );
        });
        if (result?.type !== "return") {
          throw new Error("expected pooled auth reader");
        }
        return result.value;
      };
      const fixtureAuthReader = loadReader(fixtureAuthDir, fixtureAuthPath);
      const unrelatedAuthReader = loadReader(unrelatedAgentDir, unrelatedAgent.path);
      expectOpen(true, fixtureAuthReader, unrelatedAuthReader);
      const expectFixtureClosed = () => {
        expectOpen(false, fixtureAuthReader, fixtureAgent.db);
        expect(
          stateCache.openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(
            fixtureShared.path,
          ),
        ).toBeUndefined();
      };
      const expectUnrelatedOpen = () =>
        expectOpen(true, unrelatedAuthReader, unrelatedShared.db, unrelatedAgent.db);
      const restoreEnv = state.restoreEnv;
      const originalRm = fs.rm;
      const rmSpy = vi.spyOn(fs, "rm").mockImplementation((...args) => {
        expectFixtureClosed();
        expectOpen(true, unrelatedAuthReader);
        return originalRm(...args);
      });
      state.restoreEnv = async () => {
        expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
        await restoreEnv();
        expectFixtureClosed();
        expectOpen(false, fixtureShared.db);
        expectUnrelatedOpen();
      };

      try {
        await state.cleanup();

        expect(process.env.OPENCLAW_STATE_DIR).toBe(previousStateDir);
        expect(rmSpy).toHaveBeenCalledWith(state.root, removeOptions);
        await expectPathMissing(state.root);
        expectUnrelatedOpen();
      } finally {
        state.restoreEnv = restoreEnv;
        await restoreEnv();
        for (const databasePath of [fixtureAuthPath, unrelatedAgent.path]) {
          authDb.closeAuthProfileReadPool({ kind: "database", databasePath });
        }
        for (const databasePath of [fixtureAuthPath, fixtureAgent.path, unrelatedAgent.path]) {
          agentDb.closeOpenClawAgentDatabaseByPath(databasePath);
        }
        for (const database of [fixtureShared, unrelatedShared]) {
          stateCache.closeOpenClawStateDatabaseByPath(database.path);
        }
        openSpy.mockRestore();
        rmSpy.mockRestore();
        await fs.rm(state.root, removeOptions);
        await fs.rm(unrelatedRoot, removeOptions);
      }
    },
  );

  it.each(["state", "configured"])(
    "does not recreate %s fixture databases from a deferred transcript reconcile",
    async (location) => {
      const state = await createTestState({ label: "deferred-reconcile" });
      const options = {
        agentId: "main",
        env: state.env,
        path:
          location === "configured" ? state.path("configured", "openclaw-agent.sqlite") : undefined,
      };
      const agent = agentDb.openOpenClawAgentDatabase(options);
      const shared = openOpenClawStateDatabase({ env: state.env });
      const resumeReconcile = createDeferredCore();
      const runOperation = reconcilePool.runSessionTranscriptReconcileOperation;
      const operationSpy = vi
        .spyOn(reconcilePool, "runSessionTranscriptReconcileOperation")
        .mockImplementationOnce((run, owner) =>
          runOperation(async (operation) => {
            await resumeReconcile.promise;
            return run(operation);
          }, owner),
        );
      const rmSpy = vi.spyOn(fs, "rm");
      const openSpy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      let cleanup: Promise<void> | undefined;
      let reconcile: Promise<void> | undefined;
      try {
        reconcileIndex.startSessionTranscriptIndexReconcile(options);
        reconcile = reconcileIndex.waitForSessionTranscriptIndexReconcile(options);
        expect(reconcileIndex.isSessionTranscriptIndexReconcileRunning(options)).toBe(true);
        cleanup = state.cleanup();

        // Empty drains settle before this real event-loop checkpoint. Old cleanup
        // reaches rm; repaired cleanup must keep the fixture alive for the owner.
        await nextTurn();
        expect(rmSpy.mock.calls.some(([target]) => target === state.root)).toBe(false);
        expect(agent.db.isOpen).toBe(true);
        expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
        resumeReconcile.resolve();
        await reconcile;
        await cleanup;

        for (const target of [state.root, agent.path, shared.path]) {
          await expectPathMissing(target);
        }
        expect(agentDb.isOpenClawAgentDatabaseOpen(agent.path)).toBe(false);
        expectOpen(false, agent.db, shared.db);
        expect(openSpy.mock.calls.filter(([pathname]) => pathname === agent.path)).toEqual([]);
      } finally {
        operationSpy.mockRestore();
        resumeReconcile.resolve();
        await reconcile;
        // A failing implementation can reach removal with a configured handle
        // still open. Release it after its reconcile joins, before joining rm.
        agentDb.closeOpenClawAgentDatabaseByPath(agent.path);
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
      const config = JSON.parse(await fs.readFile(state.configPath, "utf8"));
      expect(config.update?.channel).toBe("stable");
      expect(config.plugins?.enabled).toBe(true);
      expect(config.plugins?.allow).toStrictEqual(["discord", "telegram", "whatsapp", "memory"]);
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
