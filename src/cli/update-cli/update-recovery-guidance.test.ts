import path from "node:path";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { isContainerEnvironment } from "../../infra/container-environment.js";
import * as ledger from "../../infra/update-run-ledger.js";
import * as reports from "../../infra/update-run-report.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import { cleanupUpdateCommandTest } from "./update-command-cleanup.test-support.js";
import { createPostCorePluginUpdateResult } from "./update-command-plugins-internals.js";
import { observeUpdateGatewayReadiness } from "./update-command-readiness.js";
import { recordUpdateResultNextAction } from "./update-command-result.js";
import * as serviceRecovery from "./update-command-service-recovery.js";
import { publishUpdateCommandTerminalResultForTest as publishUpdateCommandTerminalResult } from "./update-command-terminal.test-support.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";
import { resolveUpdateResultNextAction } from "./update-recovery-guidance.js";

vi.mock("../../infra/container-environment.js", () => ({ isContainerEnvironment: vi.fn() }));
vi.mock("./update-command-readiness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-readiness.js")>()),
  observeUpdateGatewayReadiness: vi.fn(),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const hostGuidance =
  "Run `openclaw triage` on this machine to open a coding agent that can diagnose and repair the installation.";
const redeploy = "recreate or redeploy the container";
const permissionDetail =
  "Package update cannot write /usr/lib/node_modules (EPERM; owner UID 0 (root), GID 0). Run the package update as the directory's owning account, keeping the Gateway's existing state/configuration.";
const foreignDetail =
  "Selected npm destination /other is occupied by an unclaimed OpenClaw installation; launcher /other/bin/openclaw. Switch the runtime back and retry through the original absolute launcher.";
function createRun(options: { profile?: string } = {}) {
  const state = dirs.make("update-recovery-guidance-");
  const env = {
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
    OPENCLAW_PROFILE: options.profile,
  };
  return { runId: ledger.createUpdateRun({ trigger: "cli" }, { env }).runId, env };
}

function failure(overrides: Partial<UpdateRunResult> = {}): UpdateRunResult {
  const failedStep = step("package-stage", {
    stderrTail:
      overrides.reason === "global-install-permission-denied"
        ? permissionDetail
        : overrides.reason === "global-install-foreign-destination"
          ? foreignDetail
          : "EACCES: permission denied",
  });
  return {
    status: "error",
    mode: "npm",
    reason: "global-install-failed",
    recovery: { serviceRestartSafe: true, version: "1.0.0" },
    steps: [failedStep],
    failedStep,
    durationMs: 0,
    ...overrides,
  };
}

function guidance(
  result: UpdateRunResult,
  options: Partial<Parameters<typeof resolveUpdateResultNextAction>[0]> = {},
) {
  return resolveUpdateResultNextAction({ result, env: {}, ...options });
}

function step(name: string, overrides: Partial<UpdateRunResult["steps"][number]> = {}) {
  return { name, command: name, cwd: "/fixture", durationMs: 0, exitCode: 1, ...overrides };
}
type Observation = Awaited<ReturnType<typeof observeUpdateGatewayReadiness>>;
function observeGateway(
  version: string,
  healthy = true,
  gatewayBuildId?: string,
  overrides: { health?: Partial<Observation["health"]>; http?: Observation["http"] } = {},
) {
  const { health, ...observation } = overrides;
  vi.mocked(observeUpdateGatewayReadiness).mockResolvedValue({
    health: {
      runtime: { status: "running", pid: 12345 },
      portUsage: { port: 19123, status: "busy", listeners: [], hints: [] },
      healthy,
      staleGatewayPids: [],
      expectedVersion: version,
      gatewayVersion: version,
      ...(gatewayBuildId ? { gatewayBuildId } : {}),
      ...health,
    },
    readyz: healthy,
    http: { healthz: 200, readyz: healthy ? 200 : 503 },
    launchAgentRecovery: null,
    ...observation,
  });
}
function publish(
  run: ReturnType<typeof createRun>,
  result: UpdateRunResult,
  options: { restart?: boolean; coreAlreadyCurrent?: boolean } = {},
) {
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  const { coreAlreadyCurrent = false, ...opts } = options;
  return publishUpdateCommandTerminalResult(
    { opts: { json: true, run, ...opts }, coreAlreadyCurrent },
    result,
    { rolledBack: false },
  );
}
function expectReportedAction(run: ReturnType<typeof createRun>) {
  const stored = ledger.getUpdateRun(run.runId, { env: run.env });
  const action = stored?.origin.nextAction;
  expect(vi.mocked(defaultRuntime.writeJson).mock.calls[0]?.[0]).toMatchObject({
    run: { origin: { nextAction: action } },
  });
  expect(stored && reports.renderUpdateRunReport(stored).markdown).toContain(action);
  return { stored, action };
}

async function publishRecorded(result: UpdateRunResult, profile?: string) {
  const run = createRun({ profile });
  await publish(run, result);
  return expectReportedAction(run);
}

beforeEach(() => {
  vi.mocked(isContainerEnvironment).mockReturnValue(true);
  vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "");
});
afterEach(cleanupUpdateCommandTest);

it("reports an untouched Gateway after a capacity refusal without recommending recovery", () => {
  const action = guidance(failure({ reason: "snapshot-capacity-insufficient" }), {
    verifiedServingVersion: "2026.7.1",
    env: { OPENCLAW_PROFILE: "work" },
  });
  expect(action).toContain("Your Gateway is still serving 2026.7.1; nothing to restore.");
  expect(action).toContain("Fix snapshot-capacity-insufficient");
  expect(action).toContain("openclaw --profile work update");
  expect(action).not.toMatch(
    /candidate|migrated|Rollback refused|gateway stop|stop the Gateway|update repair/i,
  );
});

it.each(["not-needed", "not-attempted", "succeeded", "failed"] as const)(
  "preserves the recorded %s rollback outcome after installed-runtime recovery admission",
  (status) => {
    const action = guidance(
      failure({
        recovery: { serviceRestartSafe: true, version: "2.0.0", service: "healthy" },
        rollbackOutcome: { status, reason: "recorded rollback detail" },
        steps: [step("installed gateway recovery admission", { exitCode: 0 })],
      }),
    );
    expect(action).toContain("installed Gateway is healthy");
    if (status === "not-attempted" || status === "failed") {
      expect(action).toContain(
        `Rollback ${status === "failed" ? "failed" : "not attempted"}: recorded rollback detail.`,
      );
    } else {
      expect(action).not.toContain("Rollback");
    }
  },
);

it("reserves stopped guidance for a named data risk", () => {
  const action = guidance(
    failure({
      reason: "service-definition-rollback-unverified",
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    }),
    { serviceRunning: false },
  );
  expect(action).not.toMatch(/keep the gateway stopped/i);
  expect(action).toContain("openclaw update repair");
  expect(action).toContain("openclaw gateway status --deep");
  expect(action).toContain("service-definition-rollback-unverified");
});

it.each(["unsettled", "foreign"] as const)(
  "keeps %s Doctor settlement guidance when the target Gateway responds",
  (settlement) => {
    const root = "/fixture/candidate";
    const unsettled = settlement === "unsettled";
    const message = "Doctor processes remain unsettled, data-at-risk.";
    const result = failure({
      root,
      reason: "state-migrated-no-rollback",
      before: { version: "2026.9.1" },
      after: { version: "2026.9.2" },
      recovery: { serviceRestartSafe: true, service: "healthy", version: "2026.9.2" },
      steps: [
        step("doctor process settlement", {
          cwd: unsettled ? root : "/fixture/other-candidate",
          exitCode: unsettled ? 1 : 0,
          stderrTail: unsettled ? message : undefined,
          failureFacts: unsettled
            ? [{ check: "openclaw doctor", code: "doctor-processes-unsettled", message }]
            : undefined,
        }),
      ],
    });
    expect(serviceRecovery.refuseUnsettledDoctorRecovery(result, root, () => {})).toBe(true);
    const nextAction = guidance(result, {
      environment: { container: false, stateDir: "/fixture/state" },
    });
    const input = reports.updateRunReportInputFromResult(result, { origin: { nextAction } });
    const report = reports.renderUpdateRunReport(input, {
      currentHealth: { kind: "responding", version: "2026.9.2" },
    });
    expect(report.lines.join("\n")).toContain(nextAction);
    expect(report.markdown).not.toContain("saved runtime verification failure no longer applies");
    expect(nextAction).toContain("Keep the Gateway stopped: data at risk (active-mutation)");
    if (unsettled) {
      expect(report.lines.join("\n")).toContain("doctor-processes-unsettled");
    } else {
      expect(result.recovery).toMatchObject({ serviceRestartSafe: false });
    }
  },
);

it.each([true, false])(
  "explains runtime retention failures without overriding recovery health (healthy=%s)",
  (healthy) => {
    vi.mocked(isContainerEnvironment).mockReturnValue(false);
    const failedStep = step("validating", {
      failureFacts: [{ check: "updater-runtime-retention", code: "host-owned-plugin-link" }],
    });
    const output = guidance(
      failure({
        reason: "update-failed",
        steps: [failedStep],
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      }),
      {
        serviceRunning: true,
        runningVersion: "2026.9.6",
        verifiedServingVersion: healthy ? "2026.9.6" : undefined,
        verificationFailure: "readyz-unhealthy",
      },
    );
    expect(output).toContain("https://docs.openclaw.ai/cli/update#runtime-retention-failures");
    expect(output).toContain("Do not skip runtime retention");
    if (healthy) {
      expect(output).toContain("Your Gateway is still serving 2026.9.6; nothing to restore.");
      expect(output).toContain("After repairing the link, retry the update.");
      expect(output).toContain("Restart remains unsafe (runtime-verification-failed)");
      expect(output).not.toContain("did not pass verification");
    } else {
      expect(output).toContain("gateway is running 2026.9.6 but did not pass verification");
      expect(output).toContain("readyz-unhealthy");
      expect(output).toContain(hostGuidance);
      expect(output).not.toContain("nothing to restore");
    }
  },
);

it.each(["stopped", "unsettled", "starting"])(
  "publishes actionable migrated-state recovery with a %s Gateway",
  async (state) => {
    vi.mocked(isContainerEnvironment).mockReturnValue(false);
    const run = createRun({ profile: "work" });
    const steps: UpdateRunResult["steps"] = [];
    if (state === "unsettled") {
      steps.push(step("doctor process settlement", { stderrTail: "PID 12345 unsettled." }));
    }
    if (state === "starting") {
      steps.push(
        step("gateway recovery verification", {
          exitCode: null,
          termination: "timeout",
          advisory: { kind: "recoverable-maintenance", message: "Gateway is still starting." },
        }),
      );
    }

    await publish(
      run,
      failure({
        reason: "state-migrated-no-rollback",
        steps,
        recovery: {
          serviceRestartSafe: false,
          reason: "state-migration-started",
          dataAtRisk: state === "unsettled" ? "active-mutation" : "state-migrated-no-rollback",
        },
        verification: { serviceRunning: state === "starting" },
      }),
    );

    const { stored, action } = expectReportedAction(run);
    expect(stored).toMatchObject({ status: "failed", reason: "state-migrated-no-rollback" });
    expect(action).toContain("openclaw --profile work update repair");
    expect(action).toContain("recovery snapshots");
    if (state === "unsettled") {
      expect(action).toContain("PID 12345 unsettled.");
      expect(action).toContain("Keep the Gateway stopped: data at risk (active-mutation)");
      expect(action).toContain("after the recorded processes have stopped");
    } else if (state === "stopped") {
      expect(action).toContain("Keep the Gateway stopped");
    }
  },
);

it("uses raw recovery facts for immediate guidance without replacing history", () => {
  const run = createRun();
  const { env } = run;
  ledger.recordUpdateRunVerification(
    run.runId,
    {
      serviceRunning: true,
      runningVersion: "2026.8.99",
      booted: true,
      recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
    },
    { env },
  );
  ledger.recordUpdateRunStep(
    run.runId,
    { step: "gateway verification", status: "failed", detail: "stale-unhealthy" },
    { env },
  );
  const saved = ledger.getUpdateRun(run.runId, { env })?.verification;
  const latest = failure({
    reason: "global-install-permission-denied",
    recovery: { serviceRestartSafe: true, version: "2026.9.5", service: "healthy" },
    verification: {},
    steps: [],
  });
  const action = recordUpdateResultNextAction({ opts: { run } }, latest);
  expect(action).not.toMatch(/2026\.8\.99|stale-unhealthy/);
  expect(action?.startsWith(permissionDetail)).toBe(true);
  expect(action).toContain(redeploy);
  expect(action).toContain("openclaw update repair");
  expect(action).not.toMatch(
    /keep the gateway stopped|gateway is running|Managed gateway remains stopped/i,
  );
  expect(action).toContain("could not prove a runnable installation");
  const recorded = ledger.getUpdateRun(run.runId, { env });
  expect(recorded?.verification).toEqual(saved);
  expect(recorded?.origin.nextAction).toBe(action);
});

it("records an untouched dirty checkout", async () => {
  const { action } = await publishRecorded(
    failure({
      mode: "git",
      reason: "dirty",
      steps: [],
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    }),
  );
  expect(action).toBe(
    "Local changes prevented this update before installation. Your checkout was preserved. Commit your changes and retry, or run `openclaw triage` for help.",
  );
});

it("persists activation timeout guidance for the owning profile", async () => {
  const { stored, action } = await publishRecorded(
    failure({ reason: "update-activation-timeout", steps: [] }),
    "work",
  );
  expect(stored).toMatchObject({
    status: "failed",
    phase: "finished",
    reason: "update-activation-timeout",
  });
  expect(action).toContain("openclaw --profile work update status");
  expect(action).toContain("openclaw --profile work doctor");
  expect(action).toContain("Wait for the owning updater and its child processes to stop");
  expect(action).toContain("openclaw --profile work update repair");
});

it.each([
  ["unknown", "global-install-foreign-destination"],
  ["bun", "global-install-failed"],
] as const)("publishes consistent %s container recovery (reason=%s)", async (mode, reason) => {
  const run = createRun();
  const result = await publish(run, failure({ mode, reason }));
  const { stored, action } = expectReportedAction(run);
  expect(result.status).toBe("error");
  expect(stored?.status).toBe("failed");
  const foreign = reason === "global-install-foreign-destination";
  expect(action)[foreign ? "toBe" : "toContain"](
    `${foreign ? `${foreignDetail} ` : ""}Detected ${foreign ? "a foreign npm destination" : "package update permission failure"} inside a container. Pull or build an OpenClaw image with the target version, then recreate or redeploy the container with the same state/config mounts. In-container package changes are not durable.`,
  );
  expect(action).not.toMatch(/sudo|npm config set prefix/);
  expect(vi.mocked(defaultRuntime.writeJson)).toHaveBeenCalledOnce();
  expect(vi.mocked(defaultRuntime.writeJson).mock.calls[0]?.[0]).toMatchObject({
    status: "error",
  });
});

it("recognizes permission failures from suffixed package steps", () => {
  const result = failure();
  result.failedStep = {
    ...result.steps[0]!,
    name: "package-install-omit-optional",
    stderrTail: permissionDetail.replace("EPERM", "EACCES"),
  };
  result.steps = [result.failedStep];
  expect(guidance(result)).toContain(redeploy);
});

it("preserves rollback refusal without recommending a replacement image", () => {
  const action = guidance(failure({ reason: "rollback-project-changed" }));
  expect(action).toContain("automatic rollback was refused to preserve them");
  expect(action).not.toContain(redeploy);
});

it("describes successful-update cleanup as permanent migration-original retirement", () => {
  const action = guidance(
    { status: "ok", mode: "git", steps: [], durationMs: 0 },
    { env: { OPENCLAW_PROFILE: "work", OPENCLAW_STATE_DIR: "/fixture/state" } },
  );
  expect(action).toBe(
    "After confirming the update and your conversations are healthy, preview retained migration originals eligible for permanent cleanup with `openclaw --profile work update cleanup --dry-run` for state `/fixture/state`. Before applying cleanup, stop the Gateway first (`openclaw --profile work gateway stop`). Use the same profile, state, and config settings.",
  );
});

it.each([false, true])(
  "retains plugin activation guidance when restart was skipped (core current=%s)",
  async (coreAlreadyCurrent) => {
    const run = createRun({ profile: "work" });
    await publish(
      run,
      {
        status: "ok",
        mode: "npm",
        before: { version: coreAlreadyCurrent ? "2026.9.7" : "2026.9.6" },
        after: { version: "2026.9.7" },
        steps: [],
        durationMs: 0,
        postUpdate: {
          plugins: createPostCorePluginUpdateResult({
            status: "ok",
            changed: true,
            npm: { changed: true, outcomes: [] },
          }),
        },
      },
      { restart: false, coreAlreadyCurrent },
    );
    const { action } = expectReportedAction(run);
    expect(action).toBe(
      "Plugins updated; Gateway restart skipped (--no-restart). Run `openclaw --profile work gateway restart` to activate them in the running Gateway.",
    );
  },
);

it.each([undefined, "2026.9.2", "2026.9.4", "2026.10.4"])(
  "records observed version %s and its readiness",
  async (gatewayVersion) => {
    const healthy = gatewayVersion === "2026.10.4";
    const run = createRun();
    const { env } = run;
    const previous = {
      runningVersion: "2026.9.2",
      runningBuildId: "previous-build",
      versionMatch: true,
    };
    if (!healthy) {
      ledger.recordUpdateRunVerification(run.runId, previous, { env });
    }
    observeGateway(healthy ? "2026.10.4" : "2026.9.4", healthy, undefined, {
      health: {
        gatewayVersion,
        ...(healthy ? { authenticationError: "device identity required" } : {}),
      },
      http: undefined,
    });
    const verified = await verifyUpdatedGateway({
      result: { status: "ok", mode: "npm", steps: [], durationMs: 0 },
      opts: { json: true, run },
      serviceEnv: env,
      gatewayPort: 19123,
    });
    expect(verified.ok).toBe(healthy);
    if (healthy) {
      const observed = ledger.getUpdateRun(run.runId, { env });
      expect(observed?.verification).toMatchObject({
        runningVersion: "2026.10.4",
        versionMatch: true,
        readyz: true,
        settled: true,
      });
      const observedStep = (name: string) => observed?.steps.find((entry) => entry.step === name);
      expect(observedStep("gateway verification")).toMatchObject({ status: "completed" });
      expect(observedStep("warning:gateway verification")).toMatchObject({
        status: "completed",
        detail: expect.stringContaining("device identity required"),
      });
    } else {
      const recorded = ledger.getUpdateRun(run.runId, { env });
      assert(recorded, "Missing update record");
      const { runningVersion, runningBuildId, versionMatch } = recorded.verification;
      expect({ runningVersion, runningBuildId, versionMatch }).toEqual({
        runningVersion: gatewayVersion,
        runningBuildId: undefined,
        versionMatch: gatewayVersion === undefined ? undefined : gatewayVersion === "2026.9.4",
      });
    }
  },
);
