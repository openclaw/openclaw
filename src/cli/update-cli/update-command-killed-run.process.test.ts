import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as gatewayService from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
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
import * as updateCheck from "../../infra/update-check.js";
import * as updateGlobal from "../../infra/update-global.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  getUpdateRun,
  reconcileAbandonedUpdateRunsAsync,
} from "../../infra/update-run-ledger.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import { loadPluginCohortRecovery } from "../../infra/update-run-recovery-store.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import { defaultRuntime } from "../../runtime.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as shared from "./shared.js";
import {
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutor,
} from "./update-command-executor.js";
import type { prepareUpdateCommand } from "./update-command-run.js";
import { updateCommand } from "./update-command.js";

type Prepared = Awaited<ReturnType<typeof prepareUpdateCommand>>;
const mocks = vi.hoisted(() => ({ root: vi.fn(), proceed: vi.fn() }));
vi.mock("./shared.js", async (original) => ({
  ...(await original<typeof import("./shared.js")>()),
  resolveUpdateRoot: mocks.root,
}));
// mock-isolation: past admission the update stages a package, runs Doctor and owns the service.
vi.mock("./update-command-initialization-run.js", () => ({
  initializeAndRunUpdate: mocks.proceed,
}));
// mock-isolation: a dry run takes this path, and must never run a real preview from here.
vi.mock("./update-command-admitted.js", () => ({ runAdmittedUpdate: mocks.proceed }));

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
beforeEach(() => {
  vi.clearAllMocks();
  ({ root, childGuardEnv: env } = fixtures.setup());
  // A killed publication is resumed only by the build that sealed its helper.
  vi.mocked(runtimeWorker.resolveRuntimeWorkerUrl).mockRestore();
  // The dead updater and this process share one state directory inside the fixture.
  const stateDir = path.join(root, "state");
  configPath = path.join(stateDir, "openclaw.json");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.writeFileSync(configPath, `${JSON.stringify({ plugins: { enabled: false } })}\n`);
  for (const [name, value] of Object.entries({
    HOME: root,
    OPENCLAW_HOME: undefined,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_UPDATE_RUN_ID: undefined,
    OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
  })) {
    vi.stubEnv(name, value);
  }
  for (const output of ["error", "writeJson", "log"] as const) {
    vi.spyOn(defaultRuntime, output).mockImplementation(() => undefined);
  }
  vi.spyOn(shared, "resolveGlobalManager").mockResolvedValue("npm");
  vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("package");
  vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(createMockGatewayService());
  stalled = [];
  admitted = [];
  // Admitted execution starts with the admissions this update just passed.
  mocks.proceed.mockImplementation(
    async (_opts: unknown, prepared: Prepared, _state: unknown, _cwd: unknown, admission) => {
      await assertUpdateRecoveryAdmission({ env: admission as NodeJS.ProcessEnv });
      assertNoPendingPackageActivation(await mocks.root());
      admitted.push(prepared);
    },
  );
});
afterEach(async () => {
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
function nextUpdate(slot: string, dryRun?: true) {
  mocks.root.mockResolvedValue(slot);
  vi.spyOn(updateGlobal, "resolveGlobalInstallTarget").mockResolvedValue(
    createNpmTarget(path.dirname(slot)),
  );
  return updateCommand({ json: true, yes: true, restart: false, ...(dryRun ? { dryRun } : {}) });
}
const settled = (prepared: Prepared | undefined) =>
  prepared?.packageActivationSteps?.find((step) => step.name === "interrupted-update-recovery")
    ?.warnings?.[0];
/** What a refusal must leave as it was: the reserved recovery and the changed config. */
const reserved = (runId: string) => ({
  pair: loadPluginCohortRecovery(runId),
  status: getUpdateRun(runId)?.status,
  config: fs.readFileSync(configPath, "utf8"),
});

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
  it.each<{
    name: string;
    refusal: RegExp;
    dead?: Updater;
    dryRun?: true;
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
      // An update that is already current would not start that Gateway again.
      name: "the dead update had stopped the Gateway",
      refusal: new RegExp(`stopped the Gateway.*Run ${repair} to settle it and restart`, "u"),
      dead: { gateway: "stopped", installed: "candidate" },
    },
    {
      // Repair also runs the installed candidate's Doctor; an already-current update would not.
      name: "the dead update installed a candidate that nothing verified",
      refusal: new RegExp(`replaced OpenClaw 2026.11.3 and did not verify.*Run ${repair}`, "u"),
      dead: { installed: "candidate" },
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
  ])("still refuses when $name", ({ refusal, dead, dryRun, control }) =>
    fixtures.lifetime.run(async () => {
      const killed = await updater(await installation(), dead);
      await control?.(killed);
      const before = reserved(killed.runId);

      await expect(nextUpdate(killed.slot, dryRun)).rejects.toThrow(refusal);
      await expect(nextUpdate(killed.slot, dryRun)).rejects.toThrow(/has unfinished recovery/u);

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

  it("refuses while another updater holds the installation", () =>
    fixtures.lifetime.run(async () => {
      const killed = await updater(await installation());
      const before = reserved(killed.runId);
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        await executor.enter(killed.slot);
        await expect(nextUpdate(killed.slot)).rejects.toThrow(/has unfinished recovery/u);
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
