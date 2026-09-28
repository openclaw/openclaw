import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import * as fixtureDiagnostics from "../../test/helpers/fixture-diagnostics.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as doctor from "../commands/doctor-config-preflight.js";
import * as workers from "../infra/sqlite-readonly-worker.js";
import * as agentDatabases from "../state/openclaw-agent-db.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../state/openclaw-state-db-cache.js";
import * as stateDatabase from "../state/openclaw-state-db.js";
import { createConfigIO } from "./io.js";
import { createStateStartupCorpusFixture } from "./state-startup-corpus.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const envKeys = [
  "HOME",
  "USERPROFILE",
  "OPENCLAW_TEST_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
];
const captureEnv = () => Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("joins an aborted Doctor phase and database cleanup before removing inputs or restoring env", async () => {
  const originalEnv = captureEnv();
  const fixture = createStateStartupCorpusFixture();
  const createScope = workers.createSqliteReadOnlyWorkerScope;
  const closeAgents = agentDatabases.closeOpenClawAgentDatabasesAsync;
  const homes: string[] = [];
  const events: string[] = [];
  const scopes = vi
    .spyOn(workers, "createSqliteReadOnlyWorkerScope")
    .mockImplementation((options) => {
      const scope = createScope(options);
      return {
        run: scope.run.bind(scope),
        close: async () => {
          expect(fs.existsSync(process.env.OPENCLAW_CONFIG_PATH!)).toBe(true);
          events.push("scope-close");
          await scope.close();
        },
      };
    });
  const closeState = vi.spyOn(stateDatabase, "closeOpenClawStateDatabaseAsync");
  const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});

  // Reuse the same fixture owner, as the registered corpus cases do. A completed
  // drain must not leave the next case under its predecessor's home or env.
  for (let iteration = 0; iteration < 2; iteration++) {
    const controller = new AbortController();
    const aborted = new Error("synthetic corpus cancellation");
    const doctorEntered = createDeferred();
    const releaseDoctor = createDeferred();
    const databaseEntered = createDeferred();
    const releaseDatabase = createDeferred();
    const stateEntered = createDeferred();
    const releaseState = createDeferred();
    let unregisterState: (() => void) | undefined;
    const preflight = vi.spyOn(doctor, "runDoctorConfigPreflight").mockImplementation(async () => {
      const snapshot = await createConfigIO({
        configPath: process.env.OPENCLAW_CONFIG_PATH,
        env: process.env,
        homedir: () => process.env.HOME!,
        observe: false,
      }).readConfigFileSnapshot();
      doctorEntered.resolve();
      await releaseDoctor.promise;
      return { snapshot, baseConfig: snapshot.sourceConfig };
    });
    const databases = vi
      .spyOn(agentDatabases, "closeOpenClawAgentDatabasesAsync")
      .mockImplementation(async (stateDir) => {
        databaseEntered.resolve();
        await releaseDatabase.promise;
        await closeAgents(stateDir);
        events.push("database-close");
        unregisterState = registerOpenClawStateDatabaseAsyncResource({
          async close() {
            stateEntered.resolve();
            await releaseState.promise;
            events.push("state-close");
          },
        });
      });
    const body = fixture.runCase("2026.9.2", "generic-github-token.json", controller.signal);
    const bodyResult = body.catch((error: unknown) => error);
    let teardown: Promise<void> | undefined;
    let restored = false;
    try {
      await Promise.race([
        doctorEntered.promise,
        body.then(() => {
          throw new Error("Corpus body finished before Doctor phase");
        }),
      ]);
      const home = process.env.HOME!;
      homes.push(home);
      expect(new Set(homes).size).toBe(homes.length);
      expect(scopes).toHaveBeenLastCalledWith({
        signal: controller.signal,
        deadlineOwnedByCaller: false,
      });
      const closedBefore = closeState.mock.calls.length;
      const reportsBefore = diagnostics.mock.calls.length;
      controller.abort(aborted);
      expect(diagnostics.mock.calls).toHaveLength(reportsBefore + 1);
      const report = String(diagnostics.mock.calls[reportsBefore]![0]);
      expect(JSON.parse(report.slice("[fixture-lifecycle] ".length))).toMatchObject({
        reason: "abort",
        stage: "doctor-repair",
      });
      teardown = fixture.cleanup().then(() => {
        restored = true;
      });
      void teardown.catch(() => {});
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(restored).toBe(false);
      expect(process.env.HOME).toBe(home);
      expect(fs.existsSync(process.env.OPENCLAW_CONFIG_PATH!)).toBe(true);
      expect(databases).not.toHaveBeenCalled();

      releaseDoctor.resolve();
      await Promise.race([
        databaseEntered.promise,
        body.then(() => {
          throw new Error("Corpus body finished before database cleanup");
        }),
      ]);
      expect(preflight).toHaveBeenCalledTimes(1);
      expect(restored).toBe(false);
      expect(closeState.mock.calls).toHaveLength(closedBefore);
      expect(events).toHaveLength(iteration * 3);
      expect(process.env.HOME).toBe(home);
      expect(fs.existsSync(path.join(home, ".openclaw", "openclaw.json"))).toBe(true);

      releaseDatabase.resolve();
      await Promise.race([
        stateEntered.promise,
        body.then(
          () => {
            throw new Error("Corpus body finished before shared-state cleanup");
          },
          (cause: unknown) => {
            throw new Error("Corpus body failed before shared-state cleanup", { cause });
          },
        ),
      ]);
      expect(restored).toBe(false);
      expect(closeState.mock.calls).toHaveLength(closedBefore + 1);
      expect(events.slice(iteration * 3)).toEqual(["database-close"]);
      expect(process.env.HOME).toBe(home);
      expect(fs.existsSync(path.join(home, ".openclaw", "openclaw.json"))).toBe(true);
      releaseState.resolve();
      expect(await bodyResult).toBe(aborted);
      await teardown;
      expect(events.slice(iteration * 3)).toEqual(["database-close", "state-close", "scope-close"]);
      expect(fs.existsSync(home)).toBe(false);
      expect(captureEnv()).toEqual(originalEnv);
      expect(preflight).toHaveBeenCalledTimes(1);
      expect(diagnostics.mock.calls).toHaveLength(reportsBefore + 1);
    } finally {
      controller.abort(aborted);
      releaseDoctor.resolve();
      releaseDatabase.resolve();
      releaseState.resolve();
      await Promise.allSettled([body, teardown]);
      unregisterState?.();
      await fixture.cleanup();
      preflight.mockRestore();
      databases.mockRestore();
    }
  }
});

it.skipIf(process.platform === "win32")(
  "drains shared-state resources before per-pass integrity and the next Doctor pass",
  async ({ signal }) => {
    const originalEnv = captureEnv();
    const fixture = createStateStartupCorpusFixture();
    const entered = createDeferred();
    const release = createDeferred();
    const onAbort = () => release.resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    const stages: string[] = [];
    const createDiagnostics = fixtureDiagnostics.createFixtureDiagnostics;
    vi.spyOn(fixtureDiagnostics, "createFixtureDiagnostics").mockImplementation((name) => {
      const diagnostics = createDiagnostics(name);
      if (name !== "state-startup-corpus") {
        return diagnostics;
      }
      return {
        ...diagnostics,
        stage(stage) {
          stages.push(stage);
          diagnostics.stage(stage);
        },
      };
    });
    const closeAgents = agentDatabases.closeOpenClawAgentDatabasesAsync;
    let unregister: (() => void) | undefined;
    vi.spyOn(agentDatabases, "closeOpenClawAgentDatabasesAsync").mockImplementation(
      async (stateDir) => {
        await closeAgents(stateDir);
        if (!unregister && stages.at(-1) === "database-close") {
          unregister = registerOpenClawStateDatabaseAsyncResource({
            async close() {
              entered.resolve();
              await release.promise;
            },
          });
        }
      },
    );
    const preflight = vi.spyOn(doctor, "runDoctorConfigPreflight");
    const body = fixture.runCase("2026.9.2", "empty-providers.json", signal);
    void body.catch(() => {});
    try {
      await Promise.race([
        entered.promise,
        body.then(
          () => {
            throw new Error("Corpus body finished before shared-state resource drain");
          },
          (cause: unknown) => {
            throw new Error("Corpus body failed before shared-state resource drain", { cause });
          },
        ),
      ]);
      const home = process.env.HOME!;
      expect(fs.existsSync(path.join(home, ".openclaw", "openclaw.json"))).toBe(true);
      expect(stages.filter((stage) => stage === "database-integrity")).toEqual([]);
      expect(stages.filter((stage) => stage === "doctor-repair")).toHaveLength(1);
      expect(preflight).toHaveBeenCalledTimes(1);
      release.resolve();
      await body;
      expect(stages.filter((stage) => stage === "database-integrity")).toHaveLength(2);
      expect(stages.filter((stage) => stage === "doctor-repair")).toHaveLength(2);
      expect(preflight).toHaveBeenCalledTimes(2);
      await fixture.cleanup();
      expect(fs.existsSync(home)).toBe(false);
      expect(captureEnv()).toEqual(originalEnv);
    } finally {
      signal.removeEventListener("abort", onAbort);
      release.resolve();
      await Promise.allSettled([body]);
      unregister?.();
      await fixture.cleanup();
    }
  },
  120_000,
);

it("retains fixture inputs and env when database or worker-scope cleanup cannot be verified", async () => {
  // Deliberately retained claims belong to this probe, not the surrounding runner.
  const owner = createVitestResourceOwner(tempDirs.make("corpus-lifetime-owner-"));
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    vi.stubEnv(key, owner.root);
  }
  const originalEnv = captureEnv();
  const fixture = createStateStartupCorpusFixture();
  const bodyFailure = new Error("synthetic Doctor failure");
  const databaseFailure = new Error("synthetic database close failure");
  const stateFailure = new Error("synthetic shared-state close failure");
  const scopeFailure = new Error("synthetic scope close failure");
  const closeAgents = agentDatabases.closeOpenClawAgentDatabasesAsync;
  const createScope = workers.createSqliteReadOnlyWorkerScope;
  const cleanupOrder: string[] = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(doctor, "runDoctorConfigPreflight").mockRejectedValue(bodyFailure);
  vi.spyOn(agentDatabases, "closeOpenClawAgentDatabasesAsync").mockImplementation(
    async (stateDir) => {
      await closeAgents(stateDir);
      cleanupOrder.push("database-close");
      throw databaseFailure;
    },
  );
  const closeShared = stateDatabase.closeOpenClawStateDatabaseAsync;
  const closeState = vi
    .spyOn(stateDatabase, "closeOpenClawStateDatabaseAsync")
    .mockImplementation(async () => {
      await closeShared();
      cleanupOrder.push("state-close");
      throw stateFailure;
    });
  vi.spyOn(workers, "createSqliteReadOnlyWorkerScope").mockImplementation((options) => {
    const scope = createScope(options);
    return {
      run: scope.run.bind(scope),
      close: async () => {
        await scope.close();
        cleanupOrder.push("scope-close");
        throw scopeFailure;
      },
    };
  });
  let home: string | undefined;
  try {
    await expect(
      fixture.runCase("2026.9.2", "generic-github-token.json", new AbortController().signal),
    ).rejects.toMatchObject({
      errors: [bodyFailure, databaseFailure, stateFailure, scopeFailure],
    });
    home = process.env.HOME!;
    expect(cleanupOrder).toEqual(["database-close", "state-close", "scope-close"]);
    expect(closeState).toHaveBeenCalled();
    const cleanup = fixture.cleanup();
    const failure = await cleanup.catch((error: unknown) => error);
    expect(failure).toMatchObject({ errors: [databaseFailure, stateFailure, scopeFailure] });
    expect(fixture.cleanup()).toBe(cleanup);
    await expect(fixture.cleanup()).rejects.toBe(failure);
    await expect(
      fixture.runCase("2026.9.2", "generic-github-token.json", new AbortController().signal),
    ).rejects.toBe(failure);
    expect(doctor.runDoctorConfigPreflight).toHaveBeenCalledTimes(1);
    expect(workers.createSqliteReadOnlyWorkerScope).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(home, ".openclaw", "openclaw.json"))).toBe(true);
    expect(process.env.HOME).toBe(home);
    expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
  } finally {
    // All real closes finished before the injected rejections; this probe has no
    // outstanding work. Dispose only its retained inputs and explicit env values.
    if (home) {
      fs.rmSync(home, { recursive: true, force: true });
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
