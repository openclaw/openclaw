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
import { formatGatewayServiceInstallationDrift } from "../daemon-cli/shared.js";
import {
  readRefusedRestartRecovery,
  resolveRefusedRestartRecovery,
  resolveShippedRestartNotice,
} from "./update-refused-restart-recovery.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await state.closeOpenClawStateDatabaseAsync();
  state.closeOpenClawStateDatabaseForTest();
});

// The verified pair, pinned literally: `gateway restart` alone fails in this state.
const NOTICE =
  "If this updater leaves the Gateway stopped, run `openclaw gateway install --force` and then `openclaw gateway restart`.";
const RECOVERY = "Run `openclaw gateway install --force`, then `openclaw gateway restart`.";
const TRIAGE =
  "Run `openclaw triage` on this machine to open a coding agent that can diagnose and repair the installation.";

function writePackage(root: string, version: string) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw", version }));
  return fs.realpathSync(root);
}

/** A pnpm 11+ global install whose entry pnpm repointed from 2026.11.5 to 2026.11.6. */
function pnpmSwitch(candidate: "registry" | "tarball" | "pnpm11-group" = "registry") {
  const base = tempDirs.make("openclaw-refused-restart-");
  const storeEntry = (home: string, version: string, hash: string) =>
    path.join(home, "store/v11/links/@/openclaw", version, hash, "node_modules/openclaw");
  const home = path.join(fs.realpathSync(base), "pnpm-home");
  const project = path.join(home, "global", "v11", "708-1a1f51a997e-d997f18d74ab61bc");
  // A tarball install stays in the project's own virtual store, as in the test cells;
  // pnpm 11.28 keeps a registry install's `.pnpm` directly under the group directory.
  const candidates = {
    registry: storeEntry(home, "2026.11.6", "b2"),
    tarball: path.join(project, "node_modules/.pnpm/openclaw@file+x.tgz/node_modules/openclaw"),
    "pnpm11-group": path.join(
      project,
      ".pnpm/openclaw@2026.11.6_@opentelemetry+api@1.10.0/node_modules/openclaw",
    ),
  };
  const current = writePackage(candidates[candidate], "2026.11.6");
  fs.mkdirSync(path.join(project, "node_modules"), { recursive: true });
  // The lexical global entry the shipped driver runs the Doctor from.
  const entry = path.join(project, "node_modules", "openclaw");
  fs.symlinkSync(current, entry, "dir");
  const paths = {
    previous: writePackage(storeEntry(home, "2026.11.5", "a1"), "2026.11.5"),
    current,
    // Another pnpm home's 2026.11.5, and pnpm's pruned previous generation (path only).
    foreign: writePackage(storeEntry(path.join(base, "o"), "2026.11.5", "c3"), "2026.11.5"),
    pruned: storeEntry(home, "2026.11.4", "d4"),
    npm: writePackage(path.join(base, "npm", "lib", "node_modules", "openclaw"), "2026.11.6"),
  };
  const env = { OPENCLAW_STATE_DIR: path.join(base, "state") };
  // Another global project in the same home that still runs the previous version.
  const keepPreviousActive = () => {
    const other = path.join(home, "global", "v11", "9a0-other-project");
    fs.mkdirSync(path.join(other, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(other, "package.json"), '{"dependencies":{"openclaw":"2026.11.5"}}');
    fs.symlinkSync(paths.previous, path.join(other, "node_modules", "openclaw"), "dir");
    fs.symlinkSync(other, path.join(home, "global", "v11", "5e7c0d1a"), "dir");
  };
  return { entry, paths, env, keepPreviousActive };
}

type Fixture = ReturnType<typeof pnpmSwitch>;
type ServiceVariant = {
  service?: string;
  owned?: boolean;
  writable?: boolean;
  running?: boolean;
  otherProject?: boolean;
};

/** The live service read, as the injected seam sees it: the unit's package and its verdict. */
function serviceReader(fixture: Fixture, variant: ServiceVariant) {
  const service = variant.service ?? "previous";
  const named: Record<string, string> = fixture.paths;
  const packageRoot = named[service] ?? service;
  return async () => ({
    packageRoot,
    owned: variant.owned ?? true,
    writable: variant.writable ?? true,
    running: variant.running ?? false,
  });
}

const { driver: liveDriver } = deadDriverFixture();

// The recovery is verified on macOS and Linux only; on Windows every reader stays silent.
describe.skipIf(process.platform === "win32")("refused pnpm Gateway restart recovery", () => {
  // Shipped drivers spawn `node <entry> doctor`, and the entry can respawn itself, so the
  // driver is the grandparent here; a live child of the test is no ancestor at all.
  const grandparent = () =>
    Number(execFileSync("ps", ["-o", "ppid=", "-p", String(process.ppid)], { encoding: "utf8" }));
  const liveChild = async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e3)"]);
    onTestFinished(async () => {
      child.kill("SIGKILL");
      await once(child, "exit");
    });
    await once(child, "spawn");
    return child.pid!;
  };

  it.each([
    { name: "the shipped pnpm switch", notice: true },
    // Without a manifest nothing proves what the pruned entry was.
    { name: "a pruned previous entry", service: "pruned" },
    // The package-step Doctor has no run id; its driver is found as an ancestor alone.
    { name: "a tarball candidate", candidate: "tarball" as const, ancestor: true, notice: true },
    {
      name: "a pnpm 11.28 group",
      candidate: "pnpm11-group" as const,
      ancestor: true,
      notice: true,
    },
    { name: "a live driver that is not an ancestor", unrelated: true },
    { name: "a dead driver", dead: true },
    { name: "an npm install", root: "npm" },
    { name: "a service outside pnpm", service: "/opt/openclaw" },
    { name: "a service of another pnpm home", service: "foreign" },
    { name: "a service already on this package", service: "current" },
    { name: "a service this installation does not own", owned: false },
    { name: "a version another pnpm project still uses", otherProject: true },
    { name: "an unwritable definition", writable: false },
    { name: "a Doctor the updater lets repair services", repair: "1" },
  ])("Doctor names the recovery during the update only for $name", async (variant) => {
    const fixture = pnpmSwitch(variant.candidate);
    if (variant.otherProject) {
      fixture.keepPreviousActive();
    }
    const noRunId = variant.ancestor || variant.unrelated;
    const pid = variant.ancestor ? grandparent() : noRunId ? await liveChild() : undefined;
    const driver = pid ? readUpdateRunDriver(pid)! : liveDriver;
    const { runId } = ledger.createUpdateRun(
      {
        trigger: "cli",
        origin: { driver: variant.dead ? deadDriverFixture().dead : driver },
        before: { version: "2026.11.5" },
      },
      { env: fixture.env },
    );
    const diagnosed: string[] = [];
    const notice = await resolveShippedRestartNotice({
      root: variant.root === "npm" ? fixture.paths.npm : fixture.entry,
      env: {
        ...fixture.env,
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: variant.repair ?? "0",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
        ...(noRunId ? {} : { OPENCLAW_UPDATE_RUN_ID: runId }),
      },
      diagnose: (message) => diagnosed.push(message),
      inspectService: serviceReader(fixture, variant),
    });
    expect(notice).toBe(variant.notice ? NOTICE : undefined);
    expect(diagnosed).toEqual([]);
  });

  it("Doctor stays silent and reports why when the service cannot be read", async () => {
    const fixture = pnpmSwitch();
    const { runId } = ledger.createUpdateRun(
      { trigger: "cli", origin: { driver: liveDriver }, before: { version: "2026.11.5" } },
      { env: fixture.env },
    );
    const diagnosed: string[] = [];
    const notice = await resolveShippedRestartNotice({
      root: fixture.entry,
      env: {
        ...fixture.env,
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
        OPENCLAW_UPDATE_RUN_ID: runId,
      },
      diagnose: (message) => diagnosed.push(message),
      inspectService: async () => {
        throw new Error("systemctl is unavailable");
      },
    });
    expect(notice).toBeUndefined();
    expect(diagnosed).toEqual(["Gateway restart recovery note skipped: systemctl is unavailable."]);
  });

  /** A real ledger row shaped like the shipped 2026.11.5 run after its refused restart. */
  function refusedRun(fixture: Fixture, reason: string, from = "2026.11.5") {
    const options = { env: fixture.env };
    const { runId } = ledger.createUpdateRun(
      { trigger: "cli", before: { version: from } },
      options,
    );
    ledger.finishUpdateRun(
      runId,
      { status: "failed", reason, after: { version: "2026.11.6" }, nextAction: TRIAGE },
      options,
    );
    return ledger.getUpdateRun(runId, options)!;
  }

  it.each([
    { name: "a service still on the previous package", recovery: true },
    { name: "a pruned previous entry", service: "pruned" },
    { name: "a run that switched other versions", from: "2026.11.4" },
    { name: "another failure", reason: "doctor-failed" },
    { name: "a service already on this package", service: "current" },
    { name: "a service of another pnpm home", service: "foreign" },
    { name: "a service this installation does not own", owned: false },
    { name: "a version another pnpm project still uses", otherProject: true },
    // Someone brought the previous Gateway back; it needs no reinstall.
    { name: "a service running again", running: true },
    { name: "an npm install", root: "npm" },
  ])("update status and gateway status name the recovery only for $name", async (variant) => {
    const fixture = pnpmSwitch();
    if (variant.otherProject) {
      fixture.keepPreviousActive();
    }
    const run = refusedRun(fixture, variant.reason ?? "service-revalidation-failed", variant.from);
    const params = {
      activeRoot: variant.root === "npm" ? fixture.paths.npm : fixture.entry,
      env: fixture.env,
      inspectService: serviceReader(fixture, variant),
    };

    const recovery = await resolveRefusedRestartRecovery({ run, ...params });

    expect(recovery).toBe(variant.recovery ? RECOVERY : undefined);
    // `openclaw gateway status --deep` reads the latest run from the same ledger.
    expect(await readRefusedRestartRecovery({ ...params, stateEnv: fixture.env })).toBe(recovery);
  });

  it("names the commands for the profile the reader runs under", async () => {
    const fixture = pnpmSwitch();
    const run = refusedRun(fixture, "service-revalidation-failed");
    const recovery = await resolveRefusedRestartRecovery({
      run,
      activeRoot: fixture.entry,
      env: { ...fixture.env, OPENCLAW_PROFILE: "work" },
      inspectService: serviceReader(fixture, {}),
    });
    expect(recovery).toBe(
      "Run `openclaw --profile work gateway install --force`, then `openclaw --profile work gateway restart`.",
    );
  });

  it("gateway status replaces the generic drift advice only when a verified step is known", () => {
    const drift = {
      serviceRoot: "/pnpm-home/store/v11/links/@/openclaw/2026.11.5/a1/node_modules/openclaw",
      serviceVersion: "2026.11.5",
      activeRoot: "/pnpm-home/global/v11/708/node_modules/openclaw",
      activeVersion: "2026.11.6",
    };
    const facts = `CLI 2026.11.6 at ${drift.activeRoot} differs from the Gateway service's 2026.11.5 at ${drift.serviceRoot}.`;
    expect(formatGatewayServiceInstallationDrift(drift, {}, { nextStep: RECOVERY })).toBe(
      `${facts} ${RECOVERY}`,
    );
    const generic = formatGatewayServiceInstallationDrift(drift, {});
    expect(generic.startsWith(`${facts} Run \`openclaw update\` or use the CLI from `)).toBe(true);
    expect(generic).not.toContain(RECOVERY);
  });
});
