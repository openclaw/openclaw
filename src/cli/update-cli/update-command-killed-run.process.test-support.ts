import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { readConfigFileSnapshot } from "../../config/config.js";
import * as gatewayService from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import * as containerEnvironment from "../../infra/container-environment.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
} from "../../infra/package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "../../infra/package-update-activation-lifetime.test-support.js";
import { packageActivationRuntimeEntrypoint } from "../../infra/package-update-activation-runtime-assets.js";
import { assertNoPendingPackageActivation } from "../../infra/package-update-activation.js";
import {
  runSwitch,
  type KillSweepChildEnv,
} from "../../infra/package-update-kill-sweep.test-support.js";
import {
  createNpmTarget,
  writePackageRoot,
} from "../../infra/package-update-steps.test-support.js";
import * as runtimeWorker from "../../infra/runtime-worker-url.js";
import * as processOwner from "../../infra/state-lease-process-owner.js";
import * as updateCheck from "../../infra/update-check.js";
import * as updateGlobal from "../../infra/update-global.js";
import { getUpdateRun, listUpdateRuns } from "../../infra/update-run-ledger.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import { loadPluginCohortRecovery } from "../../infra/update-run-recovery-store.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import * as restartHealth from "../daemon-cli/restart-health.js";
import * as shared from "./shared.js";
import {
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutor,
} from "./update-command-executor.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins-internals.js";
import type { prepareUpdateCommand } from "./update-command-run.js";
import { updateCommand } from "./update-command.js";

// The next `openclaw update` after a real updater process was killed: each suite
// importing this runs the update from its command entry to admitted execution.
type Prepared = Awaited<ReturnType<typeof prepareUpdateCommand>>;
const mocks = vi.hoisted(() => ({ root: vi.fn(), proceed: vi.fn(), release: vi.fn() }));
vi.mock("./shared.js", async (original) => ({
  ...(await original<typeof import("./shared.js")>()),
  resolveUpdateRoot: mocks.root,
  tryWriteCompletionCache: async () => "skipped",
}));
// mock-isolation: past admission the update stages a package, runs Doctor and owns the service.
vi.mock("./update-command-initialization-run.js", () => ({
  initializeAndRunUpdate: mocks.proceed,
}));
// mock-isolation: a dry run takes this path, and must never run a real preview from here.
vi.mock("./update-command-admitted.js", () => ({ runAdmittedUpdate: mocks.proceed }));
// Package installs past recovery prepare a release; preparing one builds a real package.
vi.mock("../../update/cli.js", async (original) => ({
  ...(await original<typeof import("../../update/cli.js")>()),
  runReleaseUpdateCli: mocks.release,
}));
// Repair's finalization runs for real, as in the repair fixtures; only its Doctor
// children, plugin installs and Doctor's own service maintenance are stand-ins.
const finalization = vi.hoisted(() => ({
  doctor: vi.fn(),
  convergence: vi.fn(),
  plugins: vi.fn(),
}));
vi.mock("./update-command-fresh-doctor.js", async (original) => ({
  ...(await original<typeof import("./update-command-fresh-doctor.js")>()),
  runUpdateFinalizationDoctorInFreshProcess: finalization.doctor,
  completePostCorePluginUpdate: finalization.convergence,
}));
// mock-isolation: plugin convergence would install real plugins into the fixture.
vi.mock("./update-command-plugins.js", () => ({
  updatePluginsAfterCoreUpdate: finalization.plugins,
}));
// mock-isolation: Doctor's own service maintenance would stop and inspect host services.
vi.mock("../../commands/doctor-maintenance.js", () => ({
  beginDoctorMaintenance: async () => undefined,
}));
// mock-isolation: repair's failure triage would collect external diagnostics.
vi.mock("../../infra/update-triage.js", () => ({
  prepareUpdateFailureTriage: async () => async () => ({ status: "completed", hint: "" }),
}));
export { finalization, mocks };
const unchangedPlugins: PostCorePluginUpdateResult = {
  status: "ok",
  changed: false,
  sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
};

export const fixtures = createPackageActivationLifetimeFixture();
const child = fileURLToPath(
  runtimeWorker.resolveRuntimeWorkerUrl({
    ...packageActivationRuntimeEntrypoint,
    sourceWorkerName: "update-run-kill.process.test-support",
    distWorkerPath: "infra/update-run-kill.process.test-support.js",
  }),
);
export const candidate = "2026.12.1";
/** Each test's own fixture, reset before it runs. */
export const ctx = {} as {
  root: string;
  env: KillSweepChildEnv;
  configPath: string;
  stalled: Array<{ proc: ChildProcess; closed: Promise<unknown> }>;
  /** The `prepared` state each update reached admitted execution with. */
  admitted: Prepared[];
  /** Doctor runs, JSON documents and Gateway starts each update had seen at admitted execution. */
  observedAtAdmission: Array<{ doctor: number; json: number; started: number }>;
  service: ReturnType<typeof createMockGatewayService>;
};
beforeEach(() => {
  vi.clearAllMocks();
  ({ root: ctx.root, childGuardEnv: ctx.env } = fixtures.setup());
  const { root } = ctx;
  // A killed publication is resumed only by the build that sealed its helper.
  vi.mocked(runtimeWorker.resolveRuntimeWorkerUrl).mockRestore();
  // The dead updater and this process share one state directory inside the fixture,
  // at the account home's canonical path so the managed Gateway may be restored.
  const stateDir = path.join(root, ".openclaw");
  ctx.configPath = path.join(stateDir, "openclaw.json");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.writeFileSync(ctx.configPath, `${JSON.stringify({ plugins: { enabled: false } })}\n`);
  for (const [name, value] of Object.entries({
    HOME: root,
    OPENCLAW_HOME: undefined,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: ctx.configPath,
    OPENCLAW_PROFILE: undefined,
    // Read-only SQLite staging stays inside the fixture too.
    XDG_CACHE_HOME: path.join(root, "cache"),
    OPENCLAW_UPDATE_RUN_ID: undefined,
    OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
  })) {
    vi.stubEnv(name, value);
  }
  for (const output of ["error", "writeJson", "log"] as const) {
    vi.spyOn(defaultRuntime, output).mockImplementation(() => undefined);
  }
  finalization.doctor.mockResolvedValue(undefined);
  finalization.plugins.mockResolvedValue(unchangedPlugins);
  finalization.convergence.mockImplementation(async ({ pluginUpdate }) => ({
    pluginUpdate,
    configSnapshot: await readConfigFileSnapshot({ skipPluginValidation: true }),
  }));
  vi.spyOn(shared, "resolveGlobalManager").mockResolvedValue("npm");
  vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("package");
  ctx.service = createMockGatewayService();
  vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(ctx.service);
  ctx.stalled = [];
  ctx.admitted = [];
  ctx.observedAtAdmission = [];
  // Admitted execution starts with the admissions this update just passed.
  mocks.proceed.mockImplementation(
    async (_opts: unknown, prepared: Prepared, _state: unknown, _cwd: unknown, admission) => {
      await assertUpdateRecoveryAdmission({ env: admission as NodeJS.ProcessEnv });
      assertNoPendingPackageActivation(await mocks.root());
      ctx.admitted.push(prepared);
      ctx.observedAtAdmission.push({
        doctor: finalization.doctor.mock.calls.length,
        json: vi.mocked(defaultRuntime.writeJson).mock.calls.length,
        started: vi.mocked(ctx.service.start).mock.calls.length,
      });
    },
  );
});
afterEach(async () => {
  // A refused update sets the CLI's exit code; the forked worker would exit with it.
  process.exitCode = undefined;
  // The managed Gateway's account home, service state, health and host facts end with their test.
  for (const spied of [
    os.homedir,
    os.userInfo,
    gatewayService.readGatewayServiceState,
    restartHealth.waitForGatewayHealthyRestart,
    processOwner.captureNamespacedStateLeaseProcessOwner,
    containerEnvironment.isContainerEnvironment,
    os.uptime,
  ]) {
    if (vi.isMockFunction(spied)) {
      spied.mockRestore();
    }
  }
  // Only this test's own stalled updaters, by the handles that spawned them.
  for (const { proc, closed } of ctx.stalled) {
    proc.kill("SIGKILL");
    await closed;
  }
  closeOpenClawStateDatabaseForTest();
  await fixtures.cleanup();
});

export const config = () => JSON.parse(fs.readFileSync(ctx.configPath, "utf8"));
export const lease = (slot: string) =>
  withUpdateCommandExecutor(randomUUID(), async (executor) =>
    captureUpdateCommandExecutorAuthority(await executor.enter(slot)),
  );
export type Updater = {
  end?: "killed" | "stalled";
  /** The version the update was installing. */
  candidate?: string;
  installed?: "previous" | "candidate";
  trigger?: "cli" | "api";
  gateway?: "untouched" | "stopped" | "restarted";
  /** The install path the update ran from, when it links to the installation key. */
  root?: string;
  checkout?: {
    sha: string;
    buildId: string;
    marker?: "none" | { buildId?: string; previousBuildId?: string };
  };
};
/**
 * A real updater process that reserved its plugin cohort and changed config
 * under it, then was SIGKILLed (or, `stalled`, is still running).
 */
export async function updater(slot: string, options: Updater = {}) {
  const dead = { end: "killed", installed: "previous", trigger: "cli", gateway: "untouched" };
  const spec = { ...dead, candidate, ...options };
  const argv = [slot, JSON.stringify(await lease(slot)), JSON.stringify(spec)];
  const proc = spawn(
    process.execPath,
    [...runtimeWorker.resolveRuntimeWorkerArgv(pathToFileURL(child)), ...argv],
    { stdio: ["ignore", "pipe", "pipe"], env: ctx.env({ ...process.env }) },
  );
  let stderr = "";
  proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const closed = new Promise<NodeJS.Signals | null>((resolve) => {
    proc.once("close", (_code, signal) => resolve(signal));
  });
  // The child reports its run once the recovery is reserved, then dies or stalls.
  const reported = await new Promise<string>((resolve) => {
    let stdout = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes("\n")) {
        resolve(stdout);
      }
    });
    void closed.then(() => resolve(stdout));
  });
  if (spec.end === "stalled") {
    ctx.stalled.push({ proc, closed });
  } else {
    expect({ signal: await closed, stderr }).toMatchObject({ signal: "SIGKILL" });
  }
  expect(reported, stderr).not.toBe("");
  const runId = String(JSON.parse(reported).runId);
  // What every measured kill left: a running run, its reserved cohort, changed config.
  expect(getUpdateRun(runId)).toMatchObject({ status: "running", trigger: spec.trigger });
  expect(loadPluginCohortRecovery(runId)?.cohort).toMatchObject({
    disposition: "pending",
    publications: [expect.objectContaining({ kind: "config" })],
  });
  expect(config()).toHaveProperty("gateway.mode", "local");
  return { runId, slot, proc, closed };
}
export type Dead = Awaited<ReturnType<typeof updater>>;
export async function installation(name = "prefix") {
  const slot = path.join(ctx.root, name, "lib", "node_modules", "openclaw");
  await writePackageRoot(slot, "2026.11.3");
  return slot;
}
/**
 * A pnpm-style installation: the install path links to the package's own directory,
 * whose real path the update records as its installation key.
 */
export async function linkedInstallation(name = "prefix") {
  const slot = path.join(ctx.root, name, "lib", "node_modules", "openclaw");
  const previous = path.join(ctx.root, `${name}-packages`, "previous", "openclaw");
  await writePackageRoot(previous, "2026.11.3");
  fs.mkdirSync(path.dirname(slot), { recursive: true });
  fs.symlinkSync(previous, slot, "dir");
  return { slot, key: fs.realpathSync(previous) };
}
/**
 * What pnpm's activation does: the candidate gets its own directory, the previous one leaves.
 * `version` installs a later build instead, as `pnpm add -g` of a fixed build does.
 */
export async function replacePackageDirectory(
  { slot, key }: { slot: string; key: string },
  { keepPrevious = false, version = candidate } = {},
) {
  const next = path.join(path.dirname(path.dirname(key)), version, "openclaw");
  await writePackageRoot(next, version);
  fs.rmSync(slot);
  fs.symlinkSync(next, slot, "dir");
  if (!keepPrevious) {
    fs.rmSync(path.dirname(key), { recursive: true });
  }
  return fs.realpathSync(next);
}
export const git = (slot: string, ...args: string[]) =>
  execFileSync("git", ["-C", slot, "-c", "user.name=OpenClaw Test", "-c", "user.email=", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
/** The build identity and stamps a checkout's build writes, as the child's activation does. */
export function writeBuild(slot: string, commit: string, buildId: string) {
  for (const [file, value] of Object.entries({
    "build-info.json": { commit, buildId },
    ".buildstamp": { head: commit },
    ".runtime-postbuildstamp": { head: commit },
  })) {
    fs.writeFileSync(path.join(slot, "dist", file), JSON.stringify(value));
  }
}
/**
 * A real source checkout serving its built previous commit, with the candidate
 * commit beside it. The update this kills checks that candidate out with its build.
 */
function sourceCheckout(name = "checkout", candidateVersion = candidate) {
  // The real install-kind probe recognizes the checkout.
  if (vi.isMockFunction(updateCheck.resolveUpdateInstallKind)) {
    vi.mocked(updateCheck.resolveUpdateInstallKind).mockRestore();
  }
  // Host Git configuration cannot change what this checkout reports, here or in the child.
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  const slot = path.join(ctx.root, name);
  fs.mkdirSync(path.join(slot, "dist", "control-ui"), { recursive: true });
  fs.writeFileSync(path.join(slot, "dist", "entry.js"), "export {};\n");
  fs.writeFileSync(path.join(slot, "dist", "control-ui", "index.html"), "ready\n");
  git(slot, "init", "-q");
  // Like the repository's own ignore rules: builds and runtime staging stay untracked.
  fs.writeFileSync(path.join(slot, ".gitignore"), "dist\n*.tmp\n");
  const commit = (version: string, label = version) => {
    fs.writeFileSync(
      path.join(slot, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
    );
    git(slot, "add", "-A");
    git(slot, "commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", label);
    return git(slot, "rev-parse", "HEAD");
  };
  const previous = commit("2026.11.3");
  const sha = commit(candidateVersion, "candidate");
  git(slot, "reset", "-q", "--hard", previous);
  writeBuild(slot, previous, "build-previous");
  return { slot, previous, sha, buildId: "build-candidate" };
}
/**
 * A killed update that had checked out and installed its built candidate, then
 * reserved its cohort. `candidateVersion` and `buildId` name what that build reports.
 */
export async function killedCheckout(
  dead: Omit<Updater, "checkout"> = {},
  marker?: "none" | { buildId?: string; previousBuildId?: string },
  {
    name,
    candidateVersion,
    buildId,
  }: { name?: string; candidateVersion?: string; buildId?: string } = {},
) {
  const checkout = sourceCheckout(name, candidateVersion);
  const built = { sha: checkout.sha, buildId: buildId ?? checkout.buildId };
  const killed = await updater(checkout.slot, {
    ...dead,
    ...(candidateVersion ? { candidate: candidateVersion } : {}),
    checkout: { ...built, marker },
  });
  expect(git(checkout.slot, "rev-parse", "HEAD")).toBe(checkout.sha);
  return { ...checkout, ...built, ...killed };
}
/** What a refused update must leave of the checkout: its commit, tree and build. */
export const checkoutState = (slot: string) => ({
  head: git(slot, "rev-parse", "HEAD"),
  tree: git(slot, "status", "--porcelain", "--ignored"),
  build: fs.existsSync(path.join(slot, "dist", "build-info.json"))
    ? fs.readFileSync(path.join(slot, "dist", "build-info.json"), "utf8")
    : null,
});
/** A publication killed with its candidate waiting beside the untouched installed package. */
export async function killedPublication() {
  const { env } = ctx;
  const complete = await runSwitch(path.join(ctx.root, "complete"), "complete", "journal", { env });
  const labels = complete.events.flatMap((event) => event.label ?? []);
  const anchored = (name: string) => `lib/node_modules/.openclaw.package-activation/${name}`;
  const waiting = labels.indexOf(`rename ${anchored("candidate")} -> ${anchored("previous")}`);
  const cut = `boundary:${waiting + 1}`;
  const { slot } = await runSwitch(path.join(ctx.root, "killed"), cut, "journal", { env });
  const anchor = resolvePackageActivationAnchor(slot);
  expect(openPackageActivationJournal(anchor, { readOnly: true }).read().phase).toBe("publishing");
  return slot;
}
/** The next `openclaw update`, from its command entry to admitted execution. */
export function nextUpdate(slot: string, options: { dryRun?: true; restart?: true } = {}) {
  mocks.root.mockResolvedValue(slot);
  vi.spyOn(updateGlobal, "resolveGlobalInstallTarget").mockResolvedValue(
    createNpmTarget(path.dirname(slot)),
  );
  const { dryRun, restart = false } = options;
  return updateCommand({ json: true, yes: true, restart, ...(dryRun ? { dryRun } : {}) });
}
/** The repair-shaped runs finalization of a killed run writes, newest first. */
export const finalizationRuns = () =>
  listUpdateRuns({ limit: 100 }).filter((run) =>
    run.steps.some((step) => step.step === "finalize:repair-continuation"),
  );
/** The update stopped on the stage's failure, named repair, and nothing exited the process. */
export function expectFinishFailure(refused: unknown, runId: string, detail: string) {
  expect(String(refused)).toContain(
    `Error: Interrupted update ${runId} was settled, but finishing its installed version as openclaw update repair does failed: ${detail}`,
  );
  expect(String(refused)).toMatch(/ Run openclaw update repair, then retry openclaw update\.$/u);
  const causes: unknown[] = [];
  for (let cause: unknown = refused; cause instanceof Error; cause = cause.cause) {
    causes.push(cause);
  }
  expect(causes.some((cause) => cause instanceof ExitError)).toBe(false);
}
export const beginRollback = (killed: { runId: string }) =>
  writeConfigMachineState(`update.pluginCohort.${killed.runId}`, {
    ...loadPluginCohortRecovery(killed.runId)!.cohort,
    disposition: "rollback",
  });
/** What a refusal must leave as it was: the reserved recovery and the changed config. */
export const reserved = (runId: string) => ({
  pair: loadPluginCohortRecovery(runId),
  status: getUpdateRun(runId)?.status,
  config: fs.readFileSync(ctx.configPath, "utf8"),
});

/** One reason a dead run's recovery is not this update's to settle. */
export type RefusalCase = {
  name: string;
  refusal: RegExp;
  dead?: Updater;
  dryRun?: true;
  restart?: true;
  control?: (killed: Dead) => unknown;
};
/**
 * The update and its next admission both refuse, leaving recovery, run and config intact.
 */
export const stillRefuses = ({ refusal, dead, dryRun, restart, control }: RefusalCase) =>
  fixtures.lifetime.run(async () => {
    const killed = await updater(await installation(), dead);
    await control?.(killed);
    const before = reserved(killed.runId);

    const refused = nextUpdate(killed.slot, { dryRun, restart });
    await expect(refused).rejects.toThrow(refusal);
    // Every refusal names the agent route before the manual command.
    await expect(refused).rejects.toThrow(
      "Run openclaw triage for an agent that reads this update history and settles it. By hand: ",
    );
    await expect(nextUpdate(killed.slot, { dryRun, restart })).rejects.toThrow(
      /has unfinished recovery/u,
    );

    expect(mocks.proceed).not.toHaveBeenCalled();
    expect(reserved(killed.runId)).toEqual(before);
  });

export const repair = "openclaw update repair";
export const unleased = new RegExp(`no longer holds that update's lease.*Run ${repair}`, "u");
export const running = /still recorded as running.*Wait for it to finish/u;
/** A restart cleared the temporary directory: nothing shows the updater's children gone. */
export const loseStore = async () => {
  const { databasePath } = await lease(path.join(ctx.root, "unrelated"));
  fs.renameSync(databasePath, `${databasePath}.lost`);
};

export const laterBoot = "00000000-0000-4000-8000-00000000000b";
/** A process namespace as `captureNamespacedStateLeaseProcessOwner` encodes it. */
export const namespace = ({
  platform,
  boot = "00000000-0000-4000-8000-00000000000a",
  // Linux's initial PID namespace: the host itself, not a container.
  pid = "pid:[4026531836]",
  machine = "a".repeat(64) as string | null,
}: {
  platform: "linux" | "darwin";
  boot?: string;
  pid?: string;
  machine?: string | null;
}) => JSON.stringify([platform, boot, platform === "linux" ? pid : null, machine]);
export const linux = (boot?: string) => namespace({ platform: "linux", boot });
/**
 * A machine restart after the kill: the temporary lease store is gone, the run's
 * drivers name the boot they ran in (`drivers`, current first; `undefined` is a
 * driver recorded without one), this process reports `current` outside any
 * container unless `container`, and this boot started after the run's last write
 * unless `bootedBeforeLastWrite`.
 */
export const rebooted =
  (
    drivers: Array<string | null | undefined>,
    current: string,
    { origin = {}, bootedBeforeLastWrite = false, container = false } = {},
  ) =>
  async (killed: Dead) => {
    await loseStore();
    const { db } = openOpenClawStateDatabase();
    const select = db.prepare("SELECT origin_json FROM update_runs WHERE run_id = ?");
    const stored = JSON.parse(String(select.get(killed.runId)?.origin_json));
    const capture = processOwner.captureNamespacedStateLeaseProcessOwner;
    // The killed updater recorded the boot it ran in: this host's, this boot's. Only
    // Linux and macOS report one; elsewhere the injected boots below stand alone.
    if (process.platform === "linux" || process.platform === "darwin") {
      expect(stored.driver.namespace).toEqual(expect.any(String));
      expect(stored.driver.namespace).toBe(capture().namespace);
    }
    const [driver, ...previous] = drivers.map((boot, index) => ({
      // Earlier drivers are other dead processes of that boot on this host.
      ...(index ? { ...stored.driver, startIdentity: String(index) } : stored.driver),
      namespace: boot,
    }));
    const update = db.prepare("UPDATE update_runs SET origin_json = ? WHERE run_id = ?");
    const previousDrivers = previous.length ? previous : undefined;
    update.run(JSON.stringify({ ...stored, driver, previousDrivers, ...origin }), killed.runId);
    vi.spyOn(processOwner, "captureNamespacedStateLeaseProcessOwner").mockImplementation(() => ({
      ...capture(),
      namespace: current,
    }));
    // Whatever runs this suite, the update sees the host it is told it runs on.
    vi.spyOn(containerEnvironment, "isContainerEnvironment").mockReturnValue(container);
    if (!bootedBeforeLastWrite) {
      // This machine has just booted.
      vi.spyOn(os, "uptime").mockReturnValue(0);
    }
  };
