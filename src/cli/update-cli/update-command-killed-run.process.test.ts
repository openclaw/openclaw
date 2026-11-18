import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../../config/config.js";
import * as gatewayService from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
} from "../../infra/package-update-activation-journal.js";
import {
  createPackageActivationLifetimeFixture,
  mockInertSealedHelper,
} from "../../infra/package-update-activation-lifetime.test-support.js";
import { packageActivationRuntimeEntrypoint } from "../../infra/package-update-activation-runtime-assets.js";
import { assertNoPendingPackageActivation } from "../../infra/package-update-activation.js";
import {
  packageVersion,
  runSwitch,
  type KillSweepChildEnv,
} from "../../infra/package-update-kill-sweep.test-support.js";
import {
  createNpmTarget,
  writePackageRoot,
} from "../../infra/package-update-steps.test-support.js";
import { expectedPathExchangeRoute } from "../../infra/path-exchange.test-support.js";
import * as runtimeWorker from "../../infra/runtime-worker-url.js";
import * as processOwner from "../../infra/state-lease-process-owner.js";
import * as updateCheck from "../../infra/update-check.js";
import { DoctorMaintenanceRefusalError } from "../../infra/update-doctor-result.js";
import * as updateGlobal from "../../infra/update-global.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  listUpdateRuns,
  reconcileAbandonedUpdateRunsAsync,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import { loadPluginCohortRecovery } from "../../infra/update-run-recovery-store.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
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
import { createUpdateServiceStateReader } from "./update-command-service-state.test-support.js";
import { updateCommand } from "./update-command.js";
import { updateRepairCommand } from "./update-repair-command.js";

type Prepared = Awaited<ReturnType<typeof prepareUpdateCommand>>;
const mocks = vi.hoisted(() => ({ root: vi.fn(), proceed: vi.fn() }));
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
const unchangedPlugins: PostCorePluginUpdateResult = {
  status: "ok",
  changed: false,
  sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
};

const fixtures = createPackageActivationLifetimeFixture();
const child = fileURLToPath(
  runtimeWorker.resolveRuntimeWorkerUrl({
    ...packageActivationRuntimeEntrypoint,
    sourceWorkerName: "update-run-kill.process.test-support",
    distWorkerPath: "infra/update-run-kill.process.test-support.js",
  }),
);
const candidate = "2026.12.1";
let root: string;
let env: KillSweepChildEnv;
let configPath: string;
let stalled: Array<{ proc: ChildProcess; closed: Promise<unknown> }>;
/** The `prepared` state each update reached admitted execution with. */
let admitted: Prepared[];
/** Doctor runs, JSON documents and Gateway starts each update had seen at admitted execution. */
let observedAtAdmission: Array<{ doctor: number; json: number; started: number }>;
let service: ReturnType<typeof createMockGatewayService>;
beforeEach(() => {
  vi.clearAllMocks();
  ({ root, childGuardEnv: env } = fixtures.setup());
  // A killed publication is resumed only by the build that sealed its helper.
  vi.mocked(runtimeWorker.resolveRuntimeWorkerUrl).mockRestore();
  // The dead updater and this process share one state directory inside the fixture,
  // at the account home's canonical path so the managed Gateway may be restored.
  const stateDir = path.join(root, ".openclaw");
  configPath = path.join(stateDir, "openclaw.json");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.writeFileSync(configPath, `${JSON.stringify({ plugins: { enabled: false } })}\n`);
  for (const [name, value] of Object.entries({
    HOME: root,
    OPENCLAW_HOME: undefined,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
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
  service = createMockGatewayService();
  vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
  stalled = [];
  admitted = [];
  observedAtAdmission = [];
  // Admitted execution starts with the admissions this update just passed.
  mocks.proceed.mockImplementation(
    async (_opts: unknown, prepared: Prepared, _state: unknown, _cwd: unknown, admission) => {
      await assertUpdateRecoveryAdmission({ env: admission as NodeJS.ProcessEnv });
      assertNoPendingPackageActivation(await mocks.root());
      admitted.push(prepared);
      observedAtAdmission.push({
        doctor: finalization.doctor.mock.calls.length,
        json: vi.mocked(defaultRuntime.writeJson).mock.calls.length,
        started: vi.mocked(service.start).mock.calls.length,
      });
    },
  );
});
afterEach(async () => {
  // The managed Gateway's account home, service state and health end with their test.
  for (const spied of [
    os.homedir,
    os.userInfo,
    gatewayService.readGatewayServiceState,
    restartHealth.waitForGatewayHealthyRestart,
    processOwner.captureNamespacedStateLeaseProcessOwner,
  ]) {
    if (vi.isMockFunction(spied)) {
      spied.mockRestore();
    }
  }
  // Only this test's own stalled updaters, by the handles that spawned them.
  for (const { proc, closed } of stalled) {
    proc.kill("SIGKILL");
    await closed;
  }
  closeOpenClawStateDatabaseForTest();
  await fixtures.cleanup();
});

const config = () => JSON.parse(fs.readFileSync(configPath, "utf8"));
const lease = (slot: string) =>
  withUpdateCommandExecutor(randomUUID(), async (executor) =>
    captureUpdateCommandExecutorAuthority(await executor.enter(slot)),
  );
type Updater = {
  end?: "killed" | "stalled";
  installed?: "previous" | "candidate";
  trigger?: "cli" | "api";
  gateway?: "untouched" | "stopped" | "restarted";
};
/**
 * A real updater process that reserved its plugin cohort and changed config
 * under it, then was SIGKILLed (or, `stalled`, is still running).
 */
async function updater(slot: string, options: Updater = {}) {
  const dead = { end: "killed", installed: "previous", trigger: "cli", gateway: "untouched" };
  const spec = { ...dead, ...options, candidate };
  const argv = [slot, JSON.stringify(await lease(slot)), JSON.stringify(spec)];
  const proc = spawn(
    process.execPath,
    [...runtimeWorker.resolveRuntimeWorkerArgv(pathToFileURL(child)), ...argv],
    { stdio: ["ignore", "pipe", "pipe"], env: env({ ...process.env }) },
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
    stalled.push({ proc, closed });
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
async function installation(name = "prefix") {
  const slot = path.join(root, name, "lib", "node_modules", "openclaw");
  await writePackageRoot(slot, "2026.11.3");
  return slot;
}
/** A publication killed with its candidate waiting beside the untouched installed package. */
async function killedPublication() {
  const complete = await runSwitch(path.join(root, "complete"), "complete", "journal", { env });
  const labels = complete.events.flatMap((event) => event.label ?? []);
  const anchored = (name: string) => `lib/node_modules/.openclaw.package-activation/${name}`;
  const waiting = labels.indexOf(`rename ${anchored("candidate")} -> ${anchored("previous")}`);
  const cut = `boundary:${waiting + 1}`;
  const { slot } = await runSwitch(path.join(root, "killed"), cut, "journal", { env });
  const anchor = resolvePackageActivationAnchor(slot);
  expect(openPackageActivationJournal(anchor, { readOnly: true }).read().phase).toBe("publishing");
  return slot;
}
/** The next `openclaw update`, from its command entry to admitted execution. */
function nextUpdate(slot: string, options: { dryRun?: true; restart?: true } = {}) {
  mocks.root.mockResolvedValue(slot);
  vi.spyOn(updateGlobal, "resolveGlobalInstallTarget").mockResolvedValue(
    createNpmTarget(path.dirname(slot)),
  );
  const { dryRun, restart = false } = options;
  return updateCommand({ json: true, yes: true, restart, ...(dryRun ? { dryRun } : {}) });
}
/** The installation's managed Gateway: stopped, owned by `slot`, healthy once started. */
function managedGateway(slot: string) {
  // The fixture home is the account home: the default installation, whose service is managed.
  mockSystemAccountHome();
  const entry = path.join(slot, "openclaw.mjs");
  fs.writeFileSync(entry, "// fixture Gateway entrypoint\n");
  vi.mocked(service.readCommand).mockResolvedValue({
    programArguments: [process.execPath, entry, "gateway"],
    sourcePath: path.join(root, "gateway.service"),
  });
  vi.mocked(service.start).mockImplementation(async (args) => {
    await args.beforeMutation?.();
    args.assertCurrent?.();
  });
  vi.spyOn(gatewayService, "readGatewayServiceState").mockImplementation(
    createUpdateServiceStateReader({
      readCommand: service.readCommand,
      isLoaded: service.isLoaded,
      readRuntime: service.readRuntime,
      readCapability: async () => ({ kind: "writable" }),
      absentPort: () => 19789,
    }),
  );
  vi.spyOn(restartHealth, "waitForGatewayHealthyRestart").mockResolvedValue({
    outcome: "ready",
    runtime: { status: "running", pid: 4242 },
    portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    healthy: true,
    staleGatewayPids: [],
    gatewayVersion: packageVersion(slot),
  });
}
const recorded = (prepared: Prepared | undefined, name: string) =>
  prepared?.packageActivationSteps?.find((step) => step.name === name)?.warnings?.[0];
const settled = (prepared: Prepared | undefined) =>
  recorded(prepared, "interrupted-update-recovery");
/** The repair-shaped runs finalization of a killed run writes, newest first. */
const finalizationRuns = () =>
  listUpdateRuns({ limit: 100 }).filter((run) =>
    run.steps.some((step) => step.step === "finalize:repair-continuation"),
  );
/** A run row without its identities, clocks and process facts. */
const shape = (run: UpdateRunRecord | undefined) =>
  run && {
    trigger: run.trigger,
    phase: run.phase,
    status: run.status,
    reason: run.reason,
    target: run.target,
    after: run.after,
    origin: Object.keys(run.origin).toSorted(),
    verification: Object.keys(run.verification).toSorted(),
    serving: [run.verification.serviceRunning, run.verification.settled],
    steps: run.steps.map((step) => [step.step, step.status]),
  };
/** The update stopped on the stage's failure, named repair, and nothing exited the process. */
function expectFinishFailure(refused: unknown, runId: string, detail: string) {
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
const beginRollback = (killed: { runId: string }) =>
  writeConfigMachineState(`update.pluginCohort.${killed.runId}`, {
    ...loadPluginCohortRecovery(killed.runId)!.cohort,
    disposition: "rollback",
  });
/** What a refusal must leave as it was: the reserved recovery and the changed config. */
const reserved = (runId: string) => ({
  pair: loadPluginCohortRecovery(runId),
  status: getUpdateRun(runId)?.status,
  config: fs.readFileSync(configPath, "utf8"),
});

const laterBoot = "00000000-0000-4000-8000-00000000000b";
/** A process namespace as `captureNamespacedStateLeaseProcessOwner` encodes it. */
const namespace = ({
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
const linux = (boot?: string) => namespace({ platform: "linux", boot });

describe.skipIf(process.platform === "win32")("next update after a killed update run", () => {
  it("settles the dead run's plugin recovery itself and proceeds", () =>
    fixtures.lifetime.run(async () => {
      const killed = await updater(await installation());

      await nextUpdate(killed.slot);

      expect(mocks.proceed).toHaveBeenCalledOnce();
      expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
      // The dead update never installed its candidate, so its config change is undone.
      expect(config()).toEqual({ plugins: { enabled: false } });
      const note = settled(admitted[0]);
      expect(note).toMatch(
        new RegExp(`^Settled interrupted update ${killed.runId}.*rolled back, because`, "u"),
      );
      expect(defaultRuntime.error).toHaveBeenCalledWith(note);
      // The admitted update's own history reconciliation can now close the dead run.
      await reconcileAbandonedUpdateRunsAsync({});
      expect(getUpdateRun(killed.runId)).toMatchObject({ status: "failed", reason: "abandoned" });

      // A second update finds nothing left to settle or to refuse.
      await nextUpdate(killed.slot);
      expect(mocks.proceed).toHaveBeenCalledTimes(2);
      expect(admitted[1]?.packageActivationSteps).toBeUndefined();
    }));

  it("keeps the plugin changes of a dead run whose candidate was verified serving", () =>
    fixtures.lifetime.run(async () => {
      // Killed in post-update maintenance: the Gateway it stopped is running the candidate.
      const dead = { installed: "candidate", gateway: "restarted" } as const;
      const killed = await updater(await installation(), dead);

      await nextUpdate(killed.slot);

      expect(mocks.proceed).toHaveBeenCalledOnce();
      expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
      expect(config().gateway).toEqual({ mode: "local" });
      expect(settled(admitted[0])).toMatch(/kept, because its Gateway was verified/u);
    }));

  it.runIf(expectedPathExchangeRoute)(
    "settles a killed publication and then the same run's plugin recovery",
    () =>
      fixtures.lifetime.run(async () => {
        const killed = await updater(await killedPublication());

        await nextUpdate(killed.slot);

        expect(admitted[0]?.packageActivationSteps?.map((step) => step.name)).toEqual([
          "package-publication-recovery",
          "interrupted-update-recovery",
        ]);
        expect(packageVersion(killed.slot)).toBe("2026.11.3");
        expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
        expect(config()).toEqual({ plugins: { enabled: false } });
      }),
  );

  // Each control gives the same dead run one reason its recovery is not this update's to settle.
  type Dead = Awaited<ReturnType<typeof updater>>;
  const repair = "openclaw update repair";
  const unleased = new RegExp(`no longer holds that update's lease.*Run ${repair}`, "u");
  const running = /still recorded as running.*Wait for it to finish/u;
  /** A restart cleared the temporary directory: nothing shows the updater's children gone. */
  const loseStore = async () => {
    const { databasePath } = await lease(path.join(root, "unrelated"));
    fs.renameSync(databasePath, `${databasePath}.lost`);
  };
  /**
   * A machine restart after the kill: the temporary lease store is gone, the run's
   * drivers name the boot they ran in (`drivers`, current first; `undefined` is a
   * driver recorded without one), and this process reports `current`.
   */
  const rebooted =
    (drivers: Array<string | null | undefined>, current: string, origin: object = {}) =>
    async (killed: Dead) => {
      await loseStore();
      const { db } = openOpenClawStateDatabase();
      const select = db.prepare("SELECT origin_json FROM update_runs WHERE run_id = ?");
      const recorded = JSON.parse(String(select.get(killed.runId)?.origin_json));
      const capture = processOwner.captureNamespacedStateLeaseProcessOwner;
      // The killed updater recorded the boot it ran in: this host's, this boot's.
      expect(recorded.driver.namespace).toBe(capture().namespace);
      const [driver, ...previous] = drivers.map((namespace, index) => ({
        // Earlier drivers are other dead processes of that boot on this host.
        ...(index ? { ...recorded.driver, startIdentity: String(index) } : recorded.driver),
        namespace,
      }));
      const update = db.prepare("UPDATE update_runs SET origin_json = ? WHERE run_id = ?");
      const previousDrivers = previous.length ? previous : undefined;
      update.run(JSON.stringify({ ...recorded, driver, previousDrivers, ...origin }), killed.runId);
      vi.spyOn(processOwner, "captureNamespacedStateLeaseProcessOwner").mockImplementation(() => ({
        ...capture(),
        namespace: current,
      }));
    };
  it.each(["linux", "darwin"] as const)(
    "settles a run killed before a %s machine restarted, then proceeds",
    (platform) =>
      fixtures.lifetime.run(async () => {
        const killed = await updater(await installation());
        const before = namespace({ platform });
        await rebooted([before, before], namespace({ platform, boot: laterBoot }))(killed);

        await nextUpdate(killed.slot);

        expect(mocks.proceed).toHaveBeenCalledOnce();
        expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
        expect(config()).toEqual({ plugins: { enabled: false } });
        expect(settled(admitted[0])).toMatch(
          new RegExp(`^Settled interrupted update ${killed.runId}.*rolled back, because`, "u"),
        );
      }),
  );
  it.each<{
    name: string;
    refusal: RegExp;
    dead?: Updater;
    dryRun?: true;
    restart?: true;
    control?: (killed: Dead) => unknown;
  }>([
    { name: "the updater is still alive", refusal: running, dead: { end: "stalled" } },
    {
      name: "another update is running under a live process",
      refusal: running,
      control: () => createUpdateRun({ trigger: "cli", origin: { driver: readUpdateRunDriver() } }),
    },
    { name: "the update lease store was removed", refusal: unleased, control: loseStore },
    {
      // Another command has since created a new store at the same path.
      name: "the update lease store was replaced",
      refusal: unleased,
      control: () => loseStore().then(() => lease(path.join(root, "unrelated"))),
    },
    // After the lease store is lost, only a recorded earlier boot of this host shows the
    // updater's processes gone; each of these leaves that unproven.
    ...(
      [
        ["the lease store was lost within the same boot", [linux()], linux()],
        ["an older version recorded the run without its boot", [undefined], linux(laterBoot)],
        ["the run recorded that its boot was unknown", [null], linux(laterBoot)],
        ["one of the run's drivers recorded no boot", [linux(), undefined], linux(laterBoot)],
        [
          "the machine identity is unknown on both boots",
          [namespace({ platform: "linux", machine: null })],
          namespace({ platform: "linux", boot: laterBoot, machine: null }),
        ],
        [
          "the run was recorded on another machine",
          [namespace({ platform: "linux", machine: "b".repeat(64) })],
          linux(laterBoot),
        ],
        [
          // A container restart is not a host restart, and container identities can repeat.
          "this update runs in a Linux PID namespace other than the host's",
          [namespace({ platform: "linux", pid: "pid:[4026532001]" })],
          namespace({ platform: "linux", boot: laterBoot, pid: "pid:[4026532001]" }),
        ],
      ] as const
    ).map(([name, drivers, current]) => ({
      name,
      refusal: unleased,
      control: rebooted([...drivers], current),
    })),
    {
      // Abandonment already refuses it; the restart rule never reads its other drivers.
      name: "the run lost its updater's identity before a restart",
      refusal: running,
      control: async (killed: Dead) => {
        const step = { step: "driver:identity-unavailable", status: "completed" } as const;
        recordUpdateRunStep(killed.runId, { ...step, endedAtMs: Date.now() });
        await rebooted([linux()], linux(laterBoot))(killed);
      },
    },
    {
      name: "a managed helper had adopted the run before a restart",
      refusal: new RegExp(`not left by a killed openclaw update command.*${repair}`, "u"),
      control: (killed: Dead) => {
        const driver = { host: os.hostname(), pid: killed.proc.pid!, startIdentity: "1" };
        const managedHandoff = { parent: driver, helper: driver };
        return rebooted([linux()], linux(laterBoot), { managedHandoff })(killed);
      },
    },
    {
      // A recovery command claimed and released the installation: the lease that tied
      // this store to the dead updater is gone, as it is after a replacement.
      name: "another command already retired the dead updater's lease",
      refusal: unleased,
      control: (killed) => lease(killed.slot),
    },
    {
      // This process stands in for the Gateway's helper finishing the same run.
      name: "a managed helper has adopted the run",
      refusal: new RegExp(`not left by a killed openclaw update command.*${repair}`, "u"),
      control: (killed) =>
        adoptUpdateRun(killed.runId, { managedHandoffParent: readUpdateRunDriver() }),
    },
    {
      name: "the Gateway started the update and may still be finishing it",
      refusal: /not left by a killed openclaw update command.*Gateway is still finishing/u,
      dead: { trigger: "api" },
    },
    {
      // History cannot tell that update's stop from an operator's deliberate one.
      name: "the dead update had stopped the Gateway and this update will not restart it",
      refusal: new RegExp(
        `stopped the Gateway.*asked not to restart it\\. Run ${repair} to settle it and restart`,
        "u",
      ),
      dead: { gateway: "stopped", installed: "candidate" },
    },
    {
      name: "the dead update installed an unverified candidate but is still alive",
      refusal: running,
      dead: { installed: "candidate", end: "stalled" },
    },
    {
      name: "the dead update had begun rolling back and a managed helper has adopted it",
      refusal: new RegExp(`not left by a killed openclaw update command.*${repair}`, "u"),
      dead: { installed: "candidate", gateway: "restarted" },
      control: (killed) => {
        beginRollback(killed);
        adoptUpdateRun(killed.runId, { managedHandoffParent: readUpdateRunDriver() });
      },
    },
    {
      name: "the recorded settlement cannot be applied",
      refusal: new RegExp(
        `could not be settled \\(Plugin cohort commit does not match.*${repair}`,
        "u",
      ),
      control: (killed) =>
        writeConfigMachineState(`update.pluginCohort.${killed.runId}`, {
          ...loadPluginCohortRecovery(killed.runId)!.cohort,
          disposition: "commit",
        }),
    },
    {
      // A checkout can hold the new sources under the old version and build identity.
      name: "the installation is a source checkout",
      refusal: new RegExp(`left by an update of a source checkout.*Run ${repair}`, "u"),
      control: () => vi.mocked(updateCheck.resolveUpdateInstallKind).mockResolvedValue("git"),
    },
    {
      name: "the recovery belongs to another installation",
      refusal: /belongs to the installation at .*from that installation/u,
      control: async (killed) => {
        killed.slot = await installation("other");
      },
    },
    {
      name: "the update is a dry run",
      refusal: /A dry run changes nothing\. Run openclaw update to settle it/u,
      dryRun: true,
    },
    {
      // Repair would restart the Gateway an earlier update stopped; this update finishes one run.
      name: "an unverified candidate is installed and an earlier update left the Gateway stopped",
      refusal: new RegExp(`Other update history also needs repair \\(.+\\)\\. Run ${repair}`, "u"),
      dead: { installed: "candidate" },
      control: () => {
        const earlier = createUpdateRun({ trigger: "cli" });
        const stop = { step: "service-stop", status: "completed", endedAtMs: Date.now() } as const;
        recordUpdateRunStep(earlier.runId, stop);
        finishUpdateRun(earlier.runId, { status: "failed", reason: "update-failed" });
      },
    },
    {
      name: "the Gateway is stopped and another interrupted update is unacknowledged",
      refusal: new RegExp(`Other update history also needs repair \\(.+\\)\\. Run ${repair}`, "u"),
      dead: { installed: "candidate", gateway: "stopped" },
      restart: true,
      control: () => {
        const earlier = createUpdateRun({ trigger: "cli" });
        finishUpdateRun(earlier.runId, { status: "failed", reason: "abandoned" });
      },
    },
  ])("still refuses when $name", ({ refusal, dead, dryRun, restart, control }) =>
    fixtures.lifetime.run(async () => {
      const killed = await updater(await installation(), dead);
      await control?.(killed);
      const before = reserved(killed.runId);

      await expect(nextUpdate(killed.slot, { dryRun, restart })).rejects.toThrow(refusal);
      await expect(nextUpdate(killed.slot, { dryRun, restart })).rejects.toThrow(
        /has unfinished recovery/u,
      );

      expect(mocks.proceed).not.toHaveBeenCalled();
      expect(reserved(killed.runId)).toEqual(before);
      if (dead?.end === "stalled") {
        // The same recovery settles once that updater has been killed.
        killed.proc.kill("SIGKILL");
        await killed.closed;
        await nextUpdate(killed.slot);
        expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
      }
    }),
  );

  // Repair finishes these installed versions; an update that found its core current would not.
  const unfinished: Array<{ name: string; dead: Updater; rollback?: true; restart?: true }> = [
    { name: "replaced the installed version unconfirmed", dead: { installed: "candidate" } },
    {
      // The cohort owner finishes a rollback that restored anything, even over a verified candidate.
      name: "had begun rolling back on the version it installed",
      dead: { installed: "candidate", gateway: "restarted" },
      rollback: true,
    },
    {
      name: "left the Gateway stopped",
      dead: { installed: "candidate", gateway: "stopped" },
      restart: true,
    },
  ];
  async function unfinishedUpdate(state: (typeof unfinished)[number], name?: string) {
    const killed = await updater(await installation(name), state.dead);
    if (state.rollback) {
      beginRollback(killed);
    }
    if (state.dead.gateway === "stopped") {
      managedGateway(killed.slot);
    }
    return killed;
  }
  const finish = (killed: Dead, state: (typeof unfinished)[number]) =>
    nextUpdate(killed.slot, state.restart ? { restart: true } : {});

  it.each(unfinished)("finishes a dead update that $name as repair does, then proceeds", (state) =>
    fixtures.lifetime.run(async () => {
      const killed = await unfinishedUpdate(state);

      await finish(killed, state);

      expect(mocks.proceed).toHaveBeenCalledOnce();
      // The installed version's Doctor ran and its Gateway started before this update went on,
      // and nothing printed a result document on the way: the update's own stays the only one.
      const started = state.dead.gateway === "stopped" ? 1 : 0;
      expect(observedAtAdmission).toEqual([{ doctor: 1, json: 0, started }]);
      expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
      expect(packageVersion(killed.slot)).toBe(candidate);
      // Repair keeps the change of a rollback that began over the verified candidate.
      expect(config().gateway).toEqual(state.rollback ? { mode: "local" } : undefined);
      expect(config().plugins).toEqual({ enabled: false });
      const [stage, ...others] = finalizationRuns();
      expect(others).toEqual([]);
      expect(stage).toMatchObject({ trigger: "cli", status: "succeeded" });
      expect(admitted[0]?.packageActivationSteps?.map((step) => step.name)).toEqual([
        "interrupted-update-recovery",
        "interrupted-update-finalization",
      ]);
      expect(recorded(admitted[0], "interrupted-update-finalization")).toBe(
        `Finished interrupted update ${killed.runId} as ${repair} does (Doctor, plugin convergence and Gateway restoration); recorded as update run ${stage?.runId} (ok).`,
      );
      expect(getUpdateRun(killed.runId)).toMatchObject({ status: "failed", reason: "abandoned" });
      expect(getUpdateRun(killed.runId)?.steps).toContainEqual(
        expect.objectContaining({ step: "reconcile:acknowledged", status: "completed" }),
      );
    }),
  );

  it.each(unfinished)("records what repair records when the dead update $name", (state) =>
    fixtures.lifetime.run(async () => {
      const finished = await unfinishedUpdate(state);
      await finish(finished, state);
      const [stage] = finalizationRuns();
      // Each killed updater's own config write stamps `meta`; compare what settlement decides.
      const settledConfig = () => ({ plugins: config().plugins, gateway: config().gateway });
      const configAfterUpdate = settledConfig();
      const repaired = await unfinishedUpdate(state, "repaired");
      mocks.root.mockResolvedValue(repaired.slot);

      await updateRepairCommand({ json: true, yes: true });

      const [repairRun] = finalizationRuns();
      expect(repairRun?.runId).not.toBe(stage?.runId);
      expect(shape(stage)).toEqual(shape(repairRun));
      expect(settledConfig()).toEqual(configAfterUpdate);
      expect(shape(getUpdateRun(finished.runId))).toEqual(shape(getUpdateRun(repaired.runId)));
      // Repair reports its own result; the update's stage reported none.
      expect(defaultRuntime.writeJson).toHaveBeenCalledOnce();
    }),
  );

  it.each([
    {
      name: "Doctor fails on the installed version",
      error: new Error("synthetic Doctor failure"),
      detail: "synthetic Doctor failure",
      stage: { status: "failed" },
    },
    {
      // Repair exits 2 here; the stage hands the same outcome to this update as a refusal.
      name: "Doctor maintenance must wait",
      error: new DoctorMaintenanceRefusalError("synthetic maintenance deferral", {
        kind: "deferred",
        reason: "coordinator-contention",
      }),
      detail: "Doctor maintenance remains pending. Stop the Gateway",
      stage: { status: "skipped", reason: "doctor-maintenance-pending" },
    },
  ])("stops and names repair when finishing fails: $name", ({ error, detail, stage }) =>
    fixtures.lifetime.run(async () => {
      const killed = await unfinishedUpdate(unfinished[0]!);
      finalization.doctor.mockRejectedValue(error);

      const refused = await nextUpdate(killed.slot).catch((cause: unknown) => cause);

      expectFinishFailure(refused, killed.runId, detail);
      expect(mocks.proceed).not.toHaveBeenCalled();
      expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
      // Left as repair leaves it: the plugin recovery settled and its own run not successful.
      expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
      expect(finalizationRuns()).toEqual([expect.objectContaining(stage)]);
      expect(listUpdateRuns({ limit: 100 }).filter((run) => run.status === "succeeded")).toEqual(
        [],
      );
    }),
  );

  it("stops and names repair when repair's finish leaves that Gateway stopped", () =>
    fixtures.lifetime.run(async () => {
      // No managed service this update may restore: repair warns, the Gateway stays stopped.
      const killed = await updater(await installation(), unfinished[2]!.dead);

      const refused = await nextUpdate(killed.slot, { restart: true }).catch(
        (cause: unknown) => cause,
      );

      const [stage] = finalizationRuns();
      expect(stage).toMatchObject({ status: "succeeded" });
      expectFinishFailure(
        refused,
        killed.runId,
        `the Gateway that update stopped is still not running (update run ${stage?.runId}, warning).`,
      );
      expect(mocks.proceed).not.toHaveBeenCalled();
      expect(service.start).not.toHaveBeenCalled();
      expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
    }));

  it("refuses while another updater holds the installation", () =>
    fixtures.lifetime.run(async () => {
      const killed = await updater(await installation());
      const before = reserved(killed.runId);
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        await executor.enter(killed.slot);
        // The holder's claim retired the dead updater's lease: the proof is gone.
        await expect(nextUpdate(killed.slot)).rejects.toThrow(unleased);
      });
      expect(mocks.proceed).not.toHaveBeenCalled();
      expect(reserved(killed.runId)).toEqual(before);
    }));

  it("leaves recovery that repair cannot settle to the unchanged refusal", () =>
    fixtures.lifetime.run(async () => {
      // A second reserved recovery without a plugin cohort: repair settles neither.
      const killed = await updater(await installation());
      const core = { root: killed.slot, nodePath: process.execPath, buildId: null };
      const other = createRetainedUpdateRecovery({
        runId: randomUUID(),
        from: { ...core, version: "2026.11.2" },
        to: { ...core, version: "2026.11.3" },
      });
      const before = reserved(killed.runId);

      await expect(nextUpdate(killed.slot)).rejects.toThrow(
        /has unfinished recovery; reconcile it before starting another update\.$/u,
      );

      expect(mocks.proceed).not.toHaveBeenCalled();
      expect(reserved(killed.runId)).toEqual(before);
      expect(loadUpdateRecovery(other.runId)).toEqual(other);
    }));

  // The package refusals come first and are unchanged; nothing is settled on the way to them.
  it.runIf(expectedPathExchangeRoute).each<{
    name: string;
    refusal: RegExp;
    control: (slot: string) => unknown;
  }>([
    {
      name: "a rollback in progress",
      refusal: /Package restoration is unfinished/u,
      control: (slot) =>
        withUpdateCommandExecutor(randomUUID(), async (executor) => {
          const fence = await executor.enter(slot);
          const writer = openPackageActivationJournal(resolvePackageActivationAnchor(slot));
          writer.transition(writer.read(), "rollback-in-progress", null, fence.assertCurrent);
        }),
    },
    {
      name: "a publication journal from another build",
      refusal: /Package publication is incomplete; its original continuation cannot run/u,
      control: () => mockInertSealedHelper(root),
    },
  ])(
    "with $name: the package refusal stands and the recovery stays reserved",
    ({ refusal, control }) =>
      fixtures.lifetime.run(async () => {
        const killed = await updater(await killedPublication());
        await control(killed.slot);
        const before = reserved(killed.runId);

        // The command reports this refusal itself, then exits.
        await expect(nextUpdate(killed.slot)).rejects.toThrow("exit 1");

        const outputs = (["error", "writeJson", "log"] as const).flatMap(
          (output) => vi.mocked(defaultRuntime[output]).mock.calls,
        );
        expect(JSON.stringify(outputs)).toMatch(refusal);
        expect(mocks.proceed).not.toHaveBeenCalled();
        expect(reserved(killed.runId)).toEqual(before);
        expect(packageVersion(killed.slot)).toBe("2026.11.3");
      }),
  );
});
