import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { deadDriverFixture } from "../../infra/update-run-fixture.test-support.js";
import * as ledger from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import * as state from "../../state/openclaw-state-db.js";
import {
  FINISHER_NOTICE,
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
function pnpmSwitch() {
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
  const home = path.join(base, "pnpm-home");
  const previous = writePackage(storeEntry(home, "2026.11.5", "a1"), "2026.11.5");
  const current = writePackage(storeEntry(home, "2026.11.6", "b2"), "2026.11.6");
  const project = path.join(home, "global", "v11", "project");
  fs.mkdirSync(path.join(project, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), '{"dependencies":{"openclaw":"2026.11.6"}}');
  fs.symlinkSync(current, path.join(project, "node_modules", "openclaw"), "dir");
  fs.symlinkSync(project, path.join(home, "global", "v11", "hash-openclaw"), "dir");
  const foreign = writePackage(
    storeEntry(path.join(base, "other-home"), "2026.11.5", "c3"),
    "2026.11.5",
  );
  const npm = writePackage(path.join(base, "npm", "lib", "node_modules", "openclaw"), "2026.11.6");
  const env = { OPENCLAW_STATE_DIR: path.join(base, "state") };
  return { base, previous, current, foreign, npm, env, options: { env } };
}

type Fixture = ReturnType<typeof pnpmSwitch>;

function startShippedRun(fixture: Fixture, driver = deadDriverFixture().dead) {
  return ledger.createUpdateRun(
    { trigger: "cli", origin: { driver }, before: { version: "2026.11.5" } },
    fixture.options,
  ).runId;
}

function failRevalidation(fixture: Fixture, runId: string) {
  ledger.finishUpdateRun(
    runId,
    { status: "failed", reason: "service-revalidation-failed" },
    fixture.options,
  );
}

describe("Doctor gate for a shipped updater's refused pnpm restart", () => {
  const doctorEnv = (fixture: Fixture, runId: string) => ({
    ...fixture.env,
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
    OPENCLAW_UPDATE_RUN_ID: runId,
  });

  it.each([
    { name: "the shipped pnpm switch", left: true },
    { name: "a spawn that found its finisher already running", left: false, spawned: false },
    { name: "an npm install", left: false, root: "npm" as const },
    { name: "a service outside pnpm", left: false, servicePath: "/opt/openclaw" },
    { name: "a service of another pnpm home", left: false, servicePath: "foreign" as const },
    { name: "an unwritable definition", left: false, writable: false },
    { name: "a Doctor the updater lets repair services", left: false, repair: "1" },
  ])("leaves the finisher and its notice only for $name", async (variant) => {
    const fixture = pnpmSwitch();
    // The Doctor's own process stands in for the live shipped driver.
    const runId = startShippedRun(fixture, deadDriverFixture().driver);
    const servicePath =
      variant.servicePath === "foreign"
        ? fixture.foreign
        : (variant.servicePath ?? fixture.previous);
    const spawned: string[] = [];
    const logged: string[] = [];
    await maybeLeaveShippedRestartFinisher({
      root:
        variant.root === "npm"
          ? fixture.npm
          : path.join(fixture.base, "pnpm-home/global/v11/project/node_modules/openclaw"),
      env: {
        ...doctorEnv(fixture, runId),
        ...(variant.repair
          ? { OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: variant.repair }
          : {}),
      },
      log: (message) => logged.push(message),
      inspectService: async () => ({
        packageRoot: servicePath,
        owned: true,
        writable: variant.writable ?? true,
        running: false,
      }),
      spawnFinisher: async (_root, id) => {
        spawned.push(id);
        return variant.spawned ?? true;
      },
    });
    const gateHeld = variant.left || variant.spawned === false;
    expect(spawned).toEqual(gateHeld ? [runId] : []);
    expect(logged).toEqual(variant.left ? [FINISHER_NOTICE] : []);
  });
});

describe("shipped-updater Gateway restart finisher", () => {
  function harness(fixture: Fixture, overrides: Partial<FinisherDeps> = {}) {
    const service = { packageRoot: fixture.previous, owned: true, writable: true, running: false };
    const commands: string[] = [];
    let serving: { version?: string; ready: boolean } | undefined;
    const deps: FinisherDeps = {
      env: fixture.env,
      inspectService: async () => ({ ...service }),
      probeGateway: async () => serving,
      runCli: async (args) => {
        commands.push(args.join(" "));
        // The ordinary owners refresh the unit to the active package and start it.
        service.packageRoot = fixture.current;
        if (args[1] === "start") {
          serving = { version: "2026.11.6", ready: true };
        }
        return { code: 0, output: "" };
      },
      withServiceLock: (operation) => operation(),
      lockDir: path.join(fixture.base, "locks"),
      now: () => 0,
      sleep: async () => {},
      ...overrides,
    };
    return { deps, service, commands };
  }
  const finish = (fixture: Fixture, runId: string, deps: FinisherDeps) =>
    runShippedRestartFinisher({ runId, root: fixture.current, deps });
  const reportWarnings = (fixture: Fixture, runId: string) =>
    renderUpdateRunReport(ledger.getUpdateRun(runId, fixture.options)!).lines.filter((line) =>
      line.includes("Gateway restart"),
    );

  it("waits for the updater to exit, then refreshes and starts the Gateway and records it", async () => {
    const fixture = pnpmSwitch();
    const runId = startShippedRun(fixture);
    let waits = 0;
    const { deps, commands } = harness(fixture, {
      sleep: async () => {
        waits += 1;
        expect(commands).toEqual([]);
        failRevalidation(fixture, runId);
      },
    });

    await expect(finish(fixture, runId, deps)).resolves.toBe("restarted");

    expect(waits).toBe(1);
    expect(commands).toEqual(["gateway install --force --json", "gateway start --json"]);
    const run = ledger.getUpdateRun(runId, fixture.options)!;
    expect(run.status).toBe("failed");
    expect(run.verification).toMatchObject({
      runningVersion: "2026.11.6",
      versionMatch: true,
      settled: true,
    });
    expect(reportWarnings(fixture, runId)).toEqual([
      "Warning: The installed updater refused the Gateway restart; after it exited, the service definition was refreshed and OpenClaw 2026.11.6 is serving.",
    ]);
  });

  it("does nothing when the updater finished its own restart", async () => {
    const fixture = pnpmSwitch();
    const runId = startShippedRun(fixture);
    ledger.finishUpdateRun(runId, { status: "succeeded" }, fixture.options);
    const { deps, commands } = harness(fixture);

    await expect(finish(fixture, runId, deps)).resolves.toBe("not-needed");
    expect(commands).toEqual([]);
    expect(reportWarnings(fixture, runId)).toEqual([]);
  });

  it("yields to an update started while it waited", async () => {
    const fixture = pnpmSwitch();
    const runId = startShippedRun(fixture);
    const { deps, commands } = harness(fixture, {
      sleep: async () => {
        failRevalidation(fixture, runId);
        ledger.createUpdateRun({ trigger: "cli" }, fixture.options);
      },
    });

    await expect(finish(fixture, runId, deps)).resolves.toBe("yielded");
    expect(commands).toEqual([]);
    expect(reportWarnings(fixture, runId)).toEqual([]);
  });

  it("rechecks under the service lock and yields to the holder's restart", async () => {
    const fixture = pnpmSwitch();
    const runId = startShippedRun(fixture);
    failRevalidation(fixture, runId);
    const { deps, commands, service } = harness(fixture);
    deps.withServiceLock = async (operation) => {
      // A user's `openclaw gateway restart` held the lock and left the service running.
      service.running = true;
      return await operation();
    };

    await expect(finish(fixture, runId, deps)).resolves.toBe("yielded");
    expect(commands).toEqual([]);
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
    const first = runShippedRestartFinisher({
      runId,
      root: fixture.current,
      deps,
      onReady: (value) => ready.push(value),
    });
    await expect.poll(() => ready).toEqual([true]);

    await expect(
      runShippedRestartFinisher({
        runId,
        root: fixture.current,
        deps,
        onReady: (value) => ready.push(value),
      }),
    ).resolves.toBe("duplicate");
    expect(ready).toEqual([true, false]);
    release();
    await expect(first).resolves.toBe("restarted");
  });

  it.each([
    {
      name: "a failed service refresh",
      runCli: async () => ({ code: 1, output: "Gateway install blocked: permission denied" }),
      reason:
        "`openclaw gateway install --force` exited 1: Gateway install blocked: permission denied",
    },
    {
      name: "an updater that never exits",
      now: (() => {
        let clock = 0;
        return () => (clock += 30 * 60_000);
      })(),
      reason: "the installed updater was still running after 60 minutes",
    },
  ])("leaves the recovery command after $name", async ({ name, reason, ...overrides }) => {
    const fixture = pnpmSwitch();
    const runId = startShippedRun(fixture);
    if (name === "a failed service refresh") {
      failRevalidation(fixture, runId);
    }
    const { deps } = harness(fixture, overrides);

    await expect(finish(fixture, runId, deps)).resolves.toBe("gave-up");
    const warnings = reportWarnings(fixture, runId);
    expect(warnings).toEqual([
      `Warning: Automatic Gateway restart after the installed updater exited stopped: ${reason}. The Gateway is still stopped; run \`openclaw gateway install --force\`, then \`openclaw gateway restart\`, or ask this instance's agent with \`openclaw triage\`.`,
    ]);
  });
});
