import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import { deadDriverFixture } from "../../infra/update-run-fixture.test-support.js";
import * as ledger from "../../infra/update-run-ledger.js";
import * as state from "../../state/openclaw-state-db.js";
import {
  FINISHER_NOTICE,
  MANUAL_RECOVERY_NOTICE,
  maybeLeaveShippedRestartFinisher,
  runShippedRestartFinisher,
  type FinisherDeps,
} from "./update-shipped-restart-finisher.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await state.closeOpenClawStateDatabaseAsync();
  state.closeOpenClawStateDatabaseForTest();
});

function writePackage(root: string, version: string) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw", version }));
  return fs.realpathSync(root);
}

/** A pnpm 11 global install whose entry pnpm repointed from 2026.11.5 to 2026.11.6. */
function pnpmSwitch(candidate: "registry" | "tarball" | "pnpm11-group" = "registry") {
  const base = tempDirs.make("openclaw-shipped-restart-");
  const storeEntry = (home: string, version: string, hash: string) =>
    path.join(
      home,
      "store",
      "v11",
      "links",
      "@",
      "openclaw",
      version,
      hash,
      "node_modules",
      "openclaw",
    );
  const home = path.join(fs.realpathSync(base), "pnpm-home");
  const previous = writePackage(storeEntry(home, "2026.11.5", "a1"), "2026.11.5");
  const project = path.join(home, "global", "v11", "708-1a1f51a997e-d997f18d74ab61bc");
  // A tarball install stays in the project's own virtual store, as in the test cells;
  // pnpm 11.28 keeps a registry install's `.pnpm` directly under the group directory.
  const current = writePackage(
    candidate === "registry"
      ? storeEntry(home, "2026.11.6", "b2")
      : candidate === "tarball"
        ? path.join(project, "node_modules/.pnpm/openclaw@file+openclaw.tgz/node_modules/openclaw")
        : path.join(
            project,
            ".pnpm/openclaw@2026.11.6_@opentelemetry+api@1.10.0/node_modules/openclaw",
          ),
    "2026.11.6",
  );
  fs.mkdirSync(path.join(project, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), '{"dependencies":{"openclaw":"2026.11.6"}}');
  fs.symlinkSync(current, path.join(project, "node_modules", "openclaw"), "dir");
  fs.symlinkSync(project, path.join(home, "global", "v11", "9440847f"), "dir");
  const foreign = writePackage(
    storeEntry(path.join(base, "other-home"), "2026.11.5", "c3"),
    "2026.11.5",
  );
  const npm = writePackage(path.join(base, "npm", "lib", "node_modules", "openclaw"), "2026.11.6");
  // pnpm can prune the previous generation; the unit still names its path.
  const pruned = storeEntry(home, "2026.11.4", "d4");
  const env = { OPENCLAW_STATE_DIR: path.join(base, "state") };
  // The lexical global entry the shipped driver runs the Doctor from.
  const entry = path.join(project, "node_modules", "openclaw");
  return { base, previous, current, entry, foreign, npm, pruned, env, options: { env } };
}

type Fixture = ReturnType<typeof pnpmSwitch>;
const { driver: liveDriver, dead: deadDriver } = deadDriverFixture();

function startShippedRun(
  fixture: Fixture,
  origin: Parameters<typeof ledger.createUpdateRun>[0]["origin"] = { driver: deadDriver },
  tag?: string,
) {
  return ledger.createUpdateRun(
    {
      trigger: "cli",
      origin,
      before: { version: "2026.11.5" },
      ...(tag ? { target: { tag } } : {}),
    },
    fixture.options,
  ).runId;
}

/** An npm-packed tarball: its manifest at `package/package.json`. */
function packTarball(fixture: Fixture, version: string) {
  const source = path.join(fixture.base, `pack-${version}`);
  writePackage(path.join(source, "package"), version);
  const tarball = path.join(fixture.base, `openclaw-${version}.tgz`);
  execFileSync("tar", ["-czf", tarball, "-C", source, "package"]);
  return tarball;
}

function failRevalidation(fixture: Fixture, runId: string, dataAtRisk = false) {
  ledger.finishUpdateRun(
    runId,
    { status: "failed", reason: "service-revalidation-failed" },
    fixture.options,
  );
  if (dataAtRisk) {
    ledger.recordUpdateRunVerification(
      runId,
      {
        recovery: {
          serviceRestartSafe: false,
          dataAtRisk: "state-migrated-no-rollback",
          reason: "state-migration-started",
        },
      },
      fixture.options,
    );
  }
}

describe("Doctor gate for a shipped updater's refused pnpm restart", () => {
  const doctorEnv = (fixture: Fixture, runId: string) => ({
    ...fixture.env,
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
    OPENCLAW_UPDATE_RUN_ID: runId,
  });

  // A live process that is not this Doctor's ancestor: the test's own child.
  let unrelated: ChildProcess | undefined;
  afterEach(() => {
    unrelated?.kill("SIGKILL");
    unrelated = undefined;
  });
  const driverFor = async (kind: "self" | "grandparent" | "unrelated") => {
    if (kind === "self") {
      return liveDriver;
    }
    if (kind === "grandparent") {
      // Shipped drivers spawn `node <entry> doctor`, and the entry can respawn itself.
      const pid = Number(
        execFileSync("ps", ["-o", "ppid=", "-p", String(process.ppid)], { encoding: "utf8" }),
      );
      return readUpdateRunDriver(pid)!;
    }
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    unrelated = child;
    await new Promise((resolve) => {
      child.once("spawn", resolve);
    });
    return readUpdateRunDriver(child.pid)!;
  };

  it.each([
    { name: "the shipped pnpm switch", notice: FINISHER_NOTICE },
    {
      name: "the package-step Doctor, found by its driver ancestor alone",
      runIdEnv: false,
      driver: "grandparent",
      notice: FINISHER_NOTICE,
    },
    { name: "a pruned previous entry", servicePath: "pruned" as const, notice: FINISHER_NOTICE },
    {
      name: "a tarball candidate in the project's own store, without a run id",
      candidate: "tarball",
      runIdEnv: false,
      driver: "grandparent",
      notice: FINISHER_NOTICE,
    },
    {
      name: "a pnpm 11.28 registry candidate under its group's own .pnpm, without a run id",
      candidate: "pnpm11-group",
      runIdEnv: false,
      driver: "grandparent",
      notice: FINISHER_NOTICE,
    },
    { name: "a waiter that could not start", spawn: "failed", notice: MANUAL_RECOVERY_NOTICE },
    { name: "a waiter already running", spawn: "duplicate" },
    {
      name: "a live driver that is not an ancestor",
      runIdEnv: false,
      driver: "unrelated",
      gate: false,
    },
    { name: "an npm install", root: "npm" as const, gate: false },
    { name: "a service outside pnpm", servicePath: "/opt/openclaw", gate: false },
    { name: "a service of another pnpm home", servicePath: "foreign" as const, gate: false },
    { name: "an unwritable definition", writable: false, gate: false },
    { name: "a Doctor the updater lets repair services", repair: "1", gate: false, quiet: true },
  ] as const)("for $name", async (variant) => {
    const fixture = pnpmSwitch("candidate" in variant ? variant.candidate : "registry");
    const runId = startShippedRun(fixture, {
      driver: await driverFor(("driver" in variant ? variant.driver : undefined) ?? "self"),
    });
    const servicePath =
      variant.servicePath === "foreign" || variant.servicePath === "pruned"
        ? fixture[variant.servicePath]
        : (variant.servicePath ?? fixture.previous);
    const spawned: string[] = [];
    const logged: string[] = [];
    const diagnosed: string[] = [];
    const { OPENCLAW_UPDATE_RUN_ID: _runId, ...withoutRunId } = doctorEnv(fixture, runId);
    await maybeLeaveShippedRestartFinisher({
      root: variant.root === "npm" ? fixture.npm : fixture.entry,
      env: {
        ...("runIdEnv" in variant ? withoutRunId : doctorEnv(fixture, runId)),
        ...(variant.repair
          ? { OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: variant.repair }
          : {}),
      },
      log: (message) => logged.push(message),
      diagnose: (message) => diagnosed.push(message),
      inspectService: async () => ({
        packageRoot: servicePath,
        owned: true,
        writable: variant.writable ?? true,
        running: false,
      }),
      spawnFinisher: async (_root, id) => {
        spawned.push(id);
        return variant.spawn ?? "ready";
      },
    });
    expect(spawned).toEqual(variant.gate === false ? [] : [runId]);
    expect(logged).toEqual(variant.notice ? [variant.notice] : []);
    // A rejection past the cheap updater-flag checks names its check on the diagnostic channel.
    expect(diagnosed).toEqual(
      variant.gate === false && !("quiet" in variant)
        ? [expect.stringMatching(/^Gateway restart handoff: skipped: .+\.$/u)]
        : [],
    );
  });
});

describe("shipped-updater Gateway restart waiter", () => {
  function harness(fixture: Fixture, overrides: Partial<FinisherDeps> = {}) {
    const service = { packageRoot: fixture.previous, owned: true, writable: true, running: false };
    const updates: string[] = [];
    const deps: FinisherDeps = {
      env: fixture.env,
      inspectService: async () => ({ ...service }),
      runUpdate: async (args) => {
        updates.push(args.join(" "));
      },
      withServiceLock: (operation) => operation(),
      lockDir: path.join(fixture.base, "locks"),
      now: () => 0,
      sleep: async () => {},
      ...overrides,
    };
    return { deps, service, updates };
  }
  const finish = (fixture: Fixture, runId: string, deps: FinisherDeps) =>
    runShippedRestartFinisher({ runId, root: fixture.current, deps });
  // The waiter never writes a run: whatever it decides, the record is the updater's own.
  const unchanged = (fixture: Fixture, runId: string) => {
    const before = ledger.getUpdateRun(runId, fixture.options);
    return () => expect(ledger.getUpdateRun(runId, fixture.options)).toEqual(before);
  };

  it("waits for the updater, then hands the restart to an update pinned to the installed version", async () => {
    const fixture = pnpmSwitch();
    const runId = startShippedRun(fixture);
    const { deps, updates } = harness(fixture, {
      sleep: async () => {
        expect(updates).toEqual([]);
        failRevalidation(fixture, runId);
      },
    });

    await expect(finish(fixture, runId, deps)).resolves.toBe("handed-off");
    expect(updates).toEqual(["update --tag 2026.11.6 --yes --json"]);
  });

  it.each([
    { name: "a tarball of the installed version", target: "tarball:2026.11.6", reused: true },
    { name: "an exact installed version spec", target: "openclaw@2026.11.6", reused: true },
    { name: "a dist-tag", target: "latest", reused: false },
    { name: "a tarball of another version", target: "tarball:2026.11.7", reused: false },
  ])(
    "repeats the recorded target only when it pins the installed version: $name",
    async (variant) => {
      const fixture = pnpmSwitch();
      const target = variant.target.startsWith("tarball:")
        ? packTarball(fixture, variant.target.slice("tarball:".length))
        : variant.target;
      const runId = startShippedRun(fixture, { driver: deadDriver }, target);
      failRevalidation(fixture, runId);
      const { deps, updates } = harness(fixture);

      await expect(finish(fixture, runId, deps)).resolves.toBe("handed-off");
      expect(updates).toEqual([
        `update --tag ${variant.reused ? target : "2026.11.6"} --yes --json`,
      ]);
    },
  );

  it.each([
    { name: "a previous driver", origin: { driver: deadDriver, previousDrivers: [liveDriver] } },
    {
      name: "a handoff helper",
      origin: { driver: deadDriver, managedHandoff: { parent: deadDriver, helper: liveDriver } },
    },
  ])("never acts while $name is alive, and its deadline writes nothing", async ({ origin }) => {
    const fixture = pnpmSwitch();
    const runId = startShippedRun(fixture, origin);
    failRevalidation(fixture, runId);
    const settled = unchanged(fixture, runId);
    let clock = 0;
    const { deps, updates } = harness(fixture, { now: () => (clock += 30 * 60_000) });

    await expect(finish(fixture, runId, deps)).resolves.toBe("timed-out");
    expect(updates).toEqual([]);
    settled();
  });

  it.each([
    { name: "a restart the updater finished itself", outcome: "succeeded", result: "not-needed" },
    { name: "a data-at-risk mark", outcome: "at-risk", result: "not-needed" },
    { name: "an update started while it waited", outcome: "newer", result: "yielded" },
    { name: "a service the lock holder started", outcome: "running", result: "yielded" },
    { name: "a service lock it cannot take", outcome: "lock", result: "yielded" },
  ])("leaves $name alone and writes nothing", async ({ outcome, result }) => {
    const fixture = pnpmSwitch();
    const runId = startShippedRun(fixture);
    if (outcome === "succeeded") {
      ledger.finishUpdateRun(runId, { status: "succeeded" }, fixture.options);
    } else {
      failRevalidation(fixture, runId, outcome === "at-risk");
    }
    if (outcome === "newer") {
      ledger.createUpdateRun({ trigger: "cli" }, fixture.options);
    }
    const settled = unchanged(fixture, runId);
    const { deps, service, updates } = harness(fixture);
    deps.withServiceLock = async (operation) => {
      if (outcome === "lock") {
        throw new Error("Native service operation ownership has closed.");
      }
      // A user's restart, or a handoff helper restoring the old definition, holds the lock.
      service.running = outcome === "running";
      return await operation();
    };

    await expect(finish(fixture, runId, deps)).resolves.toBe(result);
    expect(updates).toEqual([]);
    settled();
  });

  it("runs once per update run", async () => {
    const fixture = pnpmSwitch();
    const runId = startShippedRun(fixture);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps } = harness(fixture, {
      sleep: async () => {
        await released;
        failRevalidation(fixture, runId);
      },
    });
    const ready: boolean[] = [];
    const start = () =>
      runShippedRestartFinisher({
        runId,
        root: fixture.current,
        deps,
        onReady: (value) => ready.push(value),
      });
    const first = start();
    await expect.poll(() => ready).toEqual([true]);

    await expect(start()).resolves.toBe("duplicate");
    expect(ready).toEqual([true, false]);
    release();
    await expect(first).resolves.toBe("handed-off");
  });
});
