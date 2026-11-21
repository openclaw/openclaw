import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
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
function pnpmSwitch(
  candidate: "registry" | "tarball" | "pnpm11-group" = "registry",
  activeEntries: 0 | 1 | 2 = 1,
) {
  const base = tempDirs.make("openclaw-shipped-restart-");
  const storeEntry = (home: string, version: string, hash: string) =>
    path.join(home, "store/v11/links/@/openclaw", version, hash, "node_modules/openclaw");
  const home = path.join(fs.realpathSync(base), "pnpm-home");
  const previous = writePackage(storeEntry(home, "2026.11.5", "a1"), "2026.11.5");
  const project = path.join(home, "global", "v11", "708-1a1f51a997e-d997f18d74ab61bc");
  // A tarball install stays in the project's own virtual store, as in the test cells;
  // pnpm 11.28 keeps a registry install's `.pnpm` directly under the group directory.
  const group = ".pnpm/openclaw@2026.11.6_@opentelemetry+api@1.10.0";
  const candidates = {
    registry: storeEntry(home, "2026.11.6", "b2"),
    tarball: path.join(project, "node_modules/.pnpm/openclaw@file+x.tgz/node_modules/openclaw"),
    "pnpm11-group": path.join(project, group, "node_modules/openclaw"),
  };
  const current = writePackage(candidates[candidate], "2026.11.6");
  fs.mkdirSync(path.join(project, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), '{"dependencies":{"openclaw":"2026.11.6"}}');
  fs.symlinkSync(current, path.join(project, "node_modules", "openclaw"), "dir");
  // pnpm marks the active global project with a hash link; tests vary how many resolve here.
  for (const link of ["9440847f", "9440847e"].slice(0, activeEntries)) {
    fs.symlinkSync(project, path.join(home, "global", "v11", link), "dir");
  }
  const activeEntry = path.join(home, "global", "v11", "9440847f", "node_modules", "openclaw");
  const foreign = writePackage(storeEntry(path.join(base, "o"), "2026.11.5", "c3"), "2026.11.5");
  const npm = writePackage(path.join(base, "npm", "lib", "node_modules", "openclaw"), "2026.11.6");
  // pnpm can prune the previous generation; the unit still names its path.
  const pruned = storeEntry(home, "2026.11.4", "d4");
  const env = { OPENCLAW_STATE_DIR: path.join(base, "state") };
  // The lexical global entry the shipped driver runs the Doctor from.
  const entry = path.join(project, "node_modules", "openclaw");
  const paths = { previous, current, entry, activeEntry, foreign, npm, pruned };
  return { base, ...paths, env, options: { env } };
}

type Fixture = ReturnType<typeof pnpmSwitch>;
const { driver: liveDriver, dead: deadDriver } = deadDriverFixture();

function startShippedRun(
  fixture: Fixture,
  origin: Parameters<typeof ledger.createUpdateRun>[0]["origin"] = { driver: deadDriver },
  tag?: string,
) {
  const input = { trigger: "cli" as const, origin, before: { version: "2026.11.5" } };
  const target = tag ? { target: { tag } } : {};
  return ledger.createUpdateRun({ ...input, ...target }, fixture.options).runId;
}

/** An npm-packed tarball: its manifest at `package/package.json`. */
function packTarball(fixture: Fixture, version: string) {
  const source = path.join(fixture.base, `pack-${version}`);
  writePackage(path.join(source, "package"), version);
  const tarball = path.join(fixture.base, `openclaw-${version}.tgz`);
  execFileSync("tar", ["-czf", tarball, "-C", source, "package"]);
  return tarball;
}

const AT_RISK = { serviceRestartSafe: false, reason: "state-migration-started" } as const;

function failRevalidation(fixture: Fixture, runId: string, dataAtRisk = false) {
  const reason = "service-revalidation-failed";
  ledger.finishUpdateRun(runId, { status: "failed", reason }, fixture.options);
  if (dataAtRisk) {
    ledger.recordUpdateRunVerification(runId, { recovery: AT_RISK }, fixture.options);
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

  // Shipped drivers spawn `node <entry> doctor`, and the entry can respawn itself, so the
  // driver is the grandparent here; a live child of the test is no ancestor at all.
  const grandparent = () =>
    Number(execFileSync("ps", ["-o", "ppid=", "-p", String(process.ppid)], { encoding: "utf8" }));
  const liveChild = async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e3)"]);
    onTestFinished(() => void child.kill("SIGKILL"));
    await once(child, "spawn");
    return child.pid!;
  };

  it.each([
    { name: "the shipped pnpm switch", notice: FINISHER_NOTICE },
    { name: "a pruned previous entry", servicePath: "pruned" as const, notice: FINISHER_NOTICE },
    // The package-step Doctor has no run id; its driver is found as an ancestor alone.
    { name: "a tarball candidate", candidate: "tarball", ancestor: true, notice: FINISHER_NOTICE },
    {
      name: "a pnpm 11.28 group",
      candidate: "pnpm11-group",
      ancestor: true,
      notice: FINISHER_NOTICE,
    },
    { name: "a waiter that could not start", spawn: "failed", notice: MANUAL_RECOVERY_NOTICE },
    { name: "a waiter already running", spawn: "duplicate" },
    { name: "two active entries", activeEntries: 2, gate: false, notice: MANUAL_RECOVERY_NOTICE },
    { name: "no active entry", activeEntries: 0, gate: false, notice: MANUAL_RECOVERY_NOTICE },
    { name: "a live driver that is not an ancestor", unrelated: true, gate: false },
    { name: "an npm install", root: "npm" as const, gate: false },
    { name: "a service outside pnpm", servicePath: "/opt/openclaw", gate: false },
    { name: "a service of another pnpm home", servicePath: "foreign" as const, gate: false },
    { name: "an unwritable definition", writable: false, gate: false },
    { name: "a Doctor the updater lets repair services", repair: "1", gate: false, quiet: true },
  ] as const)("for $name", async (variant) => {
    const fixture = pnpmSwitch(
      "candidate" in variant ? variant.candidate : "registry",
      "activeEntries" in variant ? variant.activeEntries : 1,
    );
    const noRunId = "ancestor" in variant || "unrelated" in variant;
    const pid = "ancestor" in variant ? grandparent() : noRunId ? await liveChild() : undefined;
    const runId = startShippedRun(fixture, {
      driver: pid ? readUpdateRunDriver(pid)! : liveDriver,
    });
    const servicePath =
      variant.servicePath === "foreign" || variant.servicePath === "pruned"
        ? fixture[variant.servicePath]
        : (variant.servicePath ?? fixture.previous);
    const service = { owned: true, writable: variant.writable ?? true, running: false };
    const spawned: string[] = [];
    const logged: string[] = [];
    const diagnosed: string[] = [];
    const { OPENCLAW_UPDATE_RUN_ID: _runId, ...withoutRunId } = doctorEnv(fixture, runId);
    await maybeLeaveShippedRestartFinisher({
      root: variant.root === "npm" ? fixture.npm : fixture.entry,
      env: {
        ...(noRunId ? withoutRunId : doctorEnv(fixture, runId)),
        ...(variant.repair
          ? { OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: variant.repair }
          : {}),
      },
      log: (message) => logged.push(message),
      diagnose: (message) => diagnosed.push(message),
      inspectService: async () => ({ ...service, packageRoot: servicePath }),
      spawnFinisher: async (_root, id) => (spawned.push(id) && variant.spawn) || "ready",
    });
    expect(spawned).toEqual(variant.gate === false ? [] : [runId]);
    expect(logged).toEqual(variant.notice ? [variant.notice] : []);
    // Whether or not a waiter is left, the line carries the verified manual pair, never
    // `gateway restart` alone.
    for (const line of logged) {
      expect(line).toContain(
        "run `openclaw gateway install --force` and then `openclaw gateway restart`.",
      );
    }
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
    const entries: string[] = [];
    const deps: FinisherDeps = {
      env: fixture.env,
      inspectService: async () => ({ ...service }),
      runUpdate: async (entry, args) => {
        entries.push(entry);
        updates.push(args.join(" "));
      },
      withServiceLock: (operation) => operation(),
      lockDir: path.join(fixture.base, "locks"),
      now: () => 0,
      sleep: async () => {},
      trace: () => {},
      ...overrides,
    };
    return { deps, service, updates, entries };
  }
  const finish = (fixture: Fixture, runId: string, deps: FinisherDeps) =>
    runShippedRestartFinisher({ runId, root: fixture.current, deps });
  // The waiter never writes a run: whatever it decides, the record is the updater's own.
  const unchanged = (fixture: Fixture, runId: string) => {
    const before = ledger.getUpdateRun(runId, fixture.options);
    return () => expect(ledger.getUpdateRun(runId, fixture.options)).toEqual(before);
  };

  it.each([
    { name: "no recorded target", target: "", reused: false },
    { name: "a tarball of the installed version", target: "tarball:2026.11.6", reused: true },
    { name: "an exact installed version spec", target: "openclaw@2026.11.6", reused: true },
    { name: "a dist-tag", target: "latest", reused: false },
    { name: "a tarball of another version", target: "tarball:2026.11.7", reused: false },
  ])("hands off once the run ends, pinned to the installed version: $name", async (variant) => {
    const fixture = pnpmSwitch();
    const target = variant.target.startsWith("tarball:")
      ? packTarball(fixture, variant.target.slice("tarball:".length))
      : variant.target;
    const runId = startShippedRun(fixture, { driver: deadDriver }, target || undefined);
    const { deps, updates, entries } = harness(fixture, {
      sleep: async () => {
        expect(updates).toEqual([]);
        failRevalidation(fixture, runId);
      },
    });

    await expect(finish(fixture, runId, deps)).resolves.toBe("handed-off");
    expect(updates).toEqual([`update --tag ${variant.reused ? target : "2026.11.6"} --yes --json`]);
    // The lexical active global entry, never the running package's real store path.
    expect(entries).toEqual([fixture.activeEntry]);
  });

  // A process that never exits stands in for a zombie driver or an unreadable identity.
  it.each([
    // 2026.11.4, 2026.11.5 and 2026.11.6 CLI runs all record `readUpdateRunDriver()`:
    // `{ host, pid, startIdentity }`, with no previous drivers or handoff helper.
    { name: "the CLI driver 2026.11.4-2026.11.6 record", origin: { driver: liveDriver } },
    { name: "a previous driver", origin: { driver: deadDriver, previousDrivers: [liveDriver] } },
    {
      name: "a handoff helper",
      origin: { driver: deadDriver, managedHandoff: { parent: deadDriver, helper: liveDriver } },
    },
  ])(
    "waits on a live-looking $name for the grace period after the refused restart, then hands off",
    async ({ origin }) => {
      const fixture = pnpmSwitch();
      const runId = startShippedRun(fixture, origin);
      failRevalidation(fixture, runId);
      const finishedAtMs = ledger.getUpdateRun(runId, fixture.options)!.finishedAtMs!;
      let clock = finishedAtMs;
      const traces: string[] = [];
      const { deps, updates } = harness(fixture, {
        now: () => clock,
        sleep: async () => {
          // Nothing acts while the driver may still restore, triage or exit.
          expect(updates).toEqual([]);
          clock += 60_000;
        },
        trace: (message) => traces.push(message),
      });

      await expect(finish(fixture, runId, deps)).resolves.toBe("handed-off");
      expect(clock - finishedAtMs).toBe(5 * 60_000);
      const pid = `PID ${liveDriver.pid} on ${liveDriver.host} (alive)`;
      expect(traces.join("\n")).toContain(
        `run ${runId}: waiting: run failed; ${pid}\nrun ${runId}: treating ${pid} as exited: the run ended service-revalidation-failed more than 300 s ago\nrun ${runId}: handing off: `,
      );
    },
  );

  it("never acts while the run is still running, and its deadline writes nothing", async () => {
    const fixture = pnpmSwitch();
    const runId = startShippedRun(fixture, { driver: liveDriver });
    const settled = unchanged(fixture, runId);
    let clock = 0;
    const traces: string[] = [];
    const { deps, updates } = harness(fixture, {
      now: () => (clock += 30 * 60_000),
      trace: (message) => traces.push(message),
    });

    await expect(finish(fixture, runId, deps)).resolves.toBe("timed-out");
    expect(updates).toEqual([]);
    expect(traces.at(-1)).toMatch(/: gave up after 60 min; waiting: run running; PID \d+/u);
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
    const traces: string[] = [];
    const { deps, service, updates } = harness(fixture, {
      trace: (message) => traces.push(message),
    });
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
    // Each decision leaves its reason in the durable trace.
    const decision = result === "yielded" ? "yielded" : "not needed";
    expect(traces).toEqual([expect.stringContaining(`run ${runId}: ${decision}: `)]);
    settled();
  });

  it("runs once per update run", async () => {
    const fixture = pnpmSwitch();
    const runId = startShippedRun(fixture);
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const { deps } = harness(fixture, {
      sleep: async () => {
        await released;
        failRevalidation(fixture, runId);
      },
    });
    const ready: boolean[] = [];
    const onReady = (value: boolean) => ready.push(value);
    const start = () => runShippedRestartFinisher({ runId, root: fixture.current, deps, onReady });
    const first = start();
    await expect.poll(() => ready).toEqual([true]);

    await expect(start()).resolves.toBe("duplicate");
    expect(ready).toEqual([true, false]);
    release();
    await expect(first).resolves.toBe("handed-off");
  });
});
