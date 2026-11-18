// A current core that still owes plugin convergence retries it once through a same-version campaign.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeUpdateFixtureDatabases,
  resetUpdateFixtureModules,
} from "./update-fixture.test-support.js";
import { idleActiveWorkInspectors } from "./update-startup-suite.test-support.js";

let { createGatewaySchedulerClock, createTestGatewayScheduler } =
  await import("../test-utils/gateway-scheduler-clock.js");
let { createOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
let { writeConfigMachineState } = await import("../state/config-machine-state-write.js");
let { resolveOpenClawPackageRoot } = await import("./openclaw-root.js");
let { createGatewayUpdateLifecycle } = await import("./update-check-lifecycle.js");
let { checkUpdateStatus, resolveNpmChannelTag } = await import("./update-check.js");
let ledger = await import("./update-run-ledger.js");
let autoRun = await import("./update-startup-auto-run.js");
let { runGatewayUpdateCheck } = await import("./update-startup.js");
let { getUpdateAvailable, getUpdateSchedule } = await import("./update-status-state.js");

async function importUpdateFixtureModules() {
  ({ createGatewaySchedulerClock, createTestGatewayScheduler } =
    await import("../test-utils/gateway-scheduler-clock.js"));
  ({ createOpenClawTestState } = await import("../test-utils/openclaw-test-state.js"));
  ({ writeConfigMachineState } = await import("../state/config-machine-state-write.js"));
  ({ resolveOpenClawPackageRoot } = await import("./openclaw-root.js"));
  ({ createGatewayUpdateLifecycle } = await import("./update-check-lifecycle.js"));
  ({ checkUpdateStatus, resolveNpmChannelTag } = await import("./update-check.js"));
  ledger = await import("./update-run-ledger.js");
  autoRun = await import("./update-startup-auto-run.js");
  ({ runGatewayUpdateCheck } = await import("./update-startup.js"));
  ({ getUpdateAvailable, getUpdateSchedule } = await import("./update-status-state.js"));
}

const { checkTelemetryUpdateMock, detectRespawnSupervisorMock, versionMock } = await vi.hoisted(
  () => import("./update-startup.test-support.js"),
);

const HOUR_MS = 60 * 60_000;
// The ledger worker stamps campaign runs with real time; fixture runs use it too to keep order.
const realDateNow = Date.now.bind(Date);
const stable: OpenClawConfig = { update: { channel: "stable", auto: { enabled: true } } };

let state: OpenClawTestState;
let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
let lifecycle: ReturnType<typeof createGatewayUpdateLifecycle>;
let runAuto: ReturnType<typeof vi.fn<typeof autoRun.runAutoUpdateCommand>>;

beforeEach(async () => {
  await resetUpdateFixtureModules();
  await importUpdateFixtureModules();
  state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "update-owed-retry-",
    env: {
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_NO_AUTO_UPDATE: undefined,
      OPENCLAW_SUPERVISOR_MODE: undefined,
      NODE_ENV: "production",
      VITEST: undefined,
    },
  });
  versionMock.value = "2.0.0";
  vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
  clock = createGatewaySchedulerClock(Date.now());
  vi.spyOn(Date, "now").mockImplementation(clock.clock.now);
  scheduler = createTestGatewayScheduler(clock.clock);
  lifecycle = createGatewayUpdateLifecycle(scheduler);
  vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
  vi.mocked(checkUpdateStatus).mockResolvedValue({
    root: "/opt/openclaw",
    installKind: "package",
    packageManager: "npm",
  });
  registry("latest", "2.0.0");
  detectRespawnSupervisorMock.mockReset().mockReturnValue("systemd");
  runAuto = vi.fn<typeof autoRun.runAutoUpdateCommand>(async () => ({ status: "handoff" }));
  vi.spyOn(autoRun, "runAutoUpdateCommand").mockImplementation((params, log) =>
    runAuto(params, log),
  );
});

afterEach(async () => {
  lifecycle.campaign?.clear();
  await lifecycle.stop();
  await scheduler.stop();
  await closeUpdateFixtureDatabases();
  vi.restoreAllMocks();
  await state.cleanup();
});

function registry(tag: string, version: string) {
  vi.mocked(resolveNpmChannelTag).mockResolvedValue({ tag, version });
  checkTelemetryUpdateMock.mockResolvedValue({ version });
}

function check(cfg: OpenClawConfig = stable) {
  return runGatewayUpdateCheck({
    getConfig: () => cfg,
    log: { info: vi.fn() },
    isNixMode: false,
    allowInTests: true,
    activeWorkInspectors: idleActiveWorkInspectors(),
  });
}

/** An hourly Gateway check, then the campaign's idle countdown. */
async function hourlyCheck(cfg: OpenClawConfig = stable) {
  await check(cfg);
  await clock.advanceBy(60_000);
}

/** A kept update that left plugin convergence owed, as the updater records it. */
function owedUpdate(
  options: {
    trigger?: "campaign" | "cli";
    before?: string;
    installed?: string;
    step?: "plugin-convergence" | "post-plugin-doctor";
  } = {},
) {
  const installed = options.installed ?? "2.0.0";
  vi.mocked(Date.now).mockImplementationOnce(realDateNow);
  const { runId } = ledger.createUpdateRun({
    trigger: options.trigger ?? "campaign",
    target: { channel: "stable", kind: "package", version: installed },
    before: { version: options.before ?? "1.0.0" },
  });
  ledger.recordUpdateRunOwedStep(
    runId,
    options.step ?? "plugin-convergence",
    "npm registry unavailable",
  );
  ledger.finishUpdateRun(runId, { status: "succeeded", after: { version: installed } });
  clock.setTime(Date.now() + 2 * HOUR_MS);
  return runId;
}

const owed = () => ledger.readOwedUpdateSteps().map(({ id, runId }) => ({ id, runId }));

/**
 * What the handed-off `openclaw update` leaves in history: the already-current update retries
 * the owed step, which settles it, owes it again on this run, or fails the run outright. The
 * update-run watcher then releases the campaign from the terminal row.
 */
function finishHandoff(runId: string, ownerRunId: string, outcome: "settled" | "owed" | "failed") {
  if (outcome === "settled") {
    ledger.settleUpdateRunOwedStep(ownerRunId, "plugin-convergence");
  } else if (outcome === "owed") {
    ledger.recordUpdateRunOwedStep(runId, "plugin-convergence", "npm registry still unavailable");
  }
  const finished = ledger.finishUpdateRun(
    runId,
    outcome === "failed"
      ? { status: "failed", reason: "candidate-validation-failed" }
      : { status: "skipped", reason: "already-current", after: { version: "2.0.0" } },
  );
  lifecycle.campaign?.reconcileRun(finished);
  clock.setTime(Date.now() + 2 * HOUR_MS);
}

describe("automatic retry of owed plugin steps", () => {
  it.each(["settled", "owed", "failed"] as const)(
    "hands off one same-version update per owed row; the retry %s",
    async (outcome) => {
      const owner = owedUpdate();

      await check();
      // Nothing newer is published: a campaign without a target or an available version.
      expect(getUpdateSchedule()?.campaign).toMatchObject({ state: "countdown" });
      expect(getUpdateSchedule()?.target).toBeUndefined();
      expect(getUpdateAvailable()).toBeNull();
      await clock.advanceBy(60_000);

      expect(runAuto).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ channel: "stable", packageTargetVersion: "2.0.0" }),
        expect.anything(),
      );
      const [retry] = ledger.listUpdateRuns();
      expect(retry).toMatchObject({
        trigger: "campaign",
        status: "running",
        target: { channel: "stable", tag: "latest", version: "2.0.0" },
        before: { version: "2.0.0" },
      });
      finishHandoff(retry!.runId, owner, outcome);
      expect(getUpdateSchedule()?.campaign).toBeUndefined();

      await hourlyCheck();
      await hourlyCheck();

      expect(runAuto).toHaveBeenCalledOnce();
      expect(getUpdateSchedule()?.campaign).toBeUndefined();
      expect(owed()).toEqual(
        outcome === "settled"
          ? []
          : [{ id: "plugin-convergence", runId: outcome === "owed" ? retry!.runId : owner }],
      );
    },
  );

  it("retries once more after a manual same-version update owes the row again", async () => {
    const owner = owedUpdate();
    await hourlyCheck();
    const [retry] = ledger.listUpdateRuns();
    finishHandoff(retry!.runId, owner, "failed");
    await hourlyCheck();
    expect(runAuto).toHaveBeenCalledOnce();

    // A person runs `openclaw update` on the current core; convergence fails again.
    owedUpdate({ trigger: "cli", before: "2.0.0" });
    await hourlyCheck();
    expect(runAuto).toHaveBeenCalledTimes(2);
    const [second] = ledger.listUpdateRuns();
    expect(second).toMatchObject({ trigger: "campaign", before: { version: "2.0.0" } });
    finishHandoff(second!.runId, second!.runId, "owed");
    await hourlyCheck();
    expect(runAuto).toHaveBeenCalledTimes(2);
  });

  it("retries on the beta channel", async () => {
    owedUpdate();
    registry("beta", "2.0.0");
    await hourlyCheck({ update: { channel: "beta", auto: { enabled: true } } });
    expect(runAuto).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ channel: "beta", packageTargetVersion: "2.0.0" }),
      expect.anything(),
    );
  });

  it("leaves automatic updates to a new release after a failed retry", async () => {
    const owner = owedUpdate();
    await hourlyCheck();
    const [retry] = ledger.listUpdateRuns();
    finishHandoff(retry!.runId, owner, "failed");

    registry("latest", "2.0.1");
    await hourlyCheck();
    // The stable rollout window for a new release still applies.
    clock.setTime(Date.now() + 19 * HOUR_MS);
    await hourlyCheck();

    expect(runAuto).toHaveBeenCalledTimes(2);
    expect(runAuto).toHaveBeenLastCalledWith(
      expect.objectContaining({ packageTargetVersion: "2.0.1" }),
      expect.anything(),
    );
  });

  it("waits for an active update run, then retries", async () => {
    owedUpdate();
    const active = ledger.createUpdateRun({ trigger: "cli", target: { kind: "package" } });

    await hourlyCheck();
    expect(runAuto).not.toHaveBeenCalled();
    expect(getUpdateSchedule()?.campaign).toBeUndefined();

    ledger.finishUpdateRun(active.runId, { status: "succeeded" });
    clock.setTime(Date.now() + 2 * HOUR_MS);
    await hourlyCheck();
    expect(runAuto).toHaveBeenCalledOnce();
  });

  it("ends the campaign without an update run when the row settles during the countdown", async () => {
    const owner = owedUpdate();
    await check();
    expect(getUpdateSchedule()?.campaign).toMatchObject({ state: "countdown" });
    // For example, `openclaw update repair` from a shell.
    ledger.settleUpdateRunOwedStep(owner, "plugin-convergence");
    await clock.advanceBy(60_000);

    expect(runAuto).not.toHaveBeenCalled();
    expect(getUpdateSchedule()?.campaign).toBeUndefined();
    expect(ledger.listUpdateRuns().map(({ runId }) => runId)).toEqual([owner]);
  });

  it("ends the campaign without an update run when an update starts during the countdown", async () => {
    const owner = owedUpdate();
    await check();
    expect(getUpdateSchedule()?.campaign).toMatchObject({ state: "countdown" });
    const manual = ledger.createUpdateRun({ trigger: "cli", target: { kind: "package" } });
    await clock.advanceBy(60_000);

    expect(runAuto).not.toHaveBeenCalled();
    expect(getUpdateSchedule()?.campaign).toBeUndefined();
    expect(ledger.listUpdateRuns().map(({ runId }) => runId)).toEqual([manual.runId, owner]);
  });

  it("waits an hour after the automatic update that installed this version", async () => {
    owedUpdate();
    // The Gateway that handed off that update recorded its attempt just before.
    writeConfigMachineState("update.checkState", {
      autoLastAttemptVersion: "2.0.0",
      autoLastAttemptAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    });

    await hourlyCheck();
    expect(runAuto).not.toHaveBeenCalled();

    clock.setTime(Date.now() + HOUR_MS);
    await hourlyCheck();
    expect(runAuto).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "automatic updates off", cfg: { update: { channel: "stable" } } },
    {
      name: "checkOnStart false",
      cfg: { update: { channel: "stable", checkOnStart: false, auto: { enabled: true } } },
    },
    { name: "OPENCLAW_NO_AUTO_UPDATE", env: true },
    { name: "no service supervisor", supervisor: null },
    { name: "an external supervisor", external: true },
    { name: "dev channel", cfg: { update: { channel: "dev", auto: { enabled: true } } } },
    {
      name: "extended-stable channel",
      cfg: { update: { channel: "extended-stable", auto: { enabled: true } } },
    },
    { name: "a row owed by another version", installed: "1.9.0" },
    { name: "a Doctor-only row", step: "post-plugin-doctor" },
    { name: "the registry naming an older version", latest: "1.9.0" },
  ] satisfies Array<{
    name: string;
    cfg?: OpenClawConfig;
    env?: boolean;
    external?: boolean;
    supervisor?: null;
    installed?: string;
    step?: "post-plugin-doctor";
    latest?: string;
  }>)("never announces with $name", async (cell) => {
    const owner = owedUpdate({ installed: cell.installed, step: cell.step });
    if (cell.env) {
      process.env.OPENCLAW_NO_AUTO_UPDATE = "1";
    }
    if (cell.external) {
      process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    }
    if (cell.supervisor === null) {
      detectRespawnSupervisorMock.mockReturnValue(null);
    }
    if (cell.cfg?.update?.channel === "dev" || cell.cfg?.update?.channel === "extended-stable") {
      registry(cell.cfg.update.channel, "2.0.0");
    }
    if (cell.latest) {
      registry("latest", cell.latest);
    }

    await hourlyCheck(cell.cfg);
    await clock.advanceBy(15 * 60_000);

    expect(runAuto).not.toHaveBeenCalled();
    expect(getUpdateSchedule()?.campaign).toBeUndefined();
    expect(ledger.listUpdateRuns().map(({ runId }) => runId)).toEqual([owner]);
  });
});
