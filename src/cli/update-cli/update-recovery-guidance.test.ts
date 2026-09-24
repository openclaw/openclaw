import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { isContainerEnvironment } from "../../infra/container-environment.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { recordUpdateResultNextAction } from "./update-command-result.js";
import { publishUpdateCommandTerminalResult } from "./update-command-terminal.js";
import { resolveUpdateResultNextAction } from "./update-recovery-guidance.js";

vi.mock("../../infra/container-environment.js", () => ({ isContainerEnvironment: vi.fn() }));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const hostGuidance =
  "Run `openclaw triage` on this machine to open a coding agent that can diagnose and repair the installation.";
const redeploy = "recreate or redeploy the container";
const permissionDetail =
  "Package update cannot write /usr/lib/node_modules (EACCES; owner UID 0 (root), GID 0). Run the package update as the directory's owning account, keeping the Gateway's existing state/configuration.";
const foreignDetail =
  "Selected npm destination /other is occupied by an unclaimed OpenClaw installation; launcher /other/bin/openclaw. Switch the runtime back and retry through the original absolute launcher.";
function failure(overrides: Partial<UpdateRunResult> = {}): UpdateRunResult {
  const failedStep = {
    name: "package-stage",
    command: "prepare staged npm install",
    cwd: "/fixture",
    durationMs: 0,
    exitCode: 1,
    stderrTail:
      overrides.reason === "global-install-permission-denied"
        ? permissionDetail
        : overrides.reason === "global-install-foreign-destination"
          ? foreignDetail
          : "EACCES: permission denied",
  };
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

beforeEach(() => {
  vi.mocked(isContainerEnvironment).mockReturnValue(true);
  vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "");
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("update recovery reporting", () => {
  it.each([true, false, undefined])(
    "uses raw recovery facts for immediate guidance without replacing history (running=%s)",
    (serviceRunning) => {
      vi.mocked(isContainerEnvironment).mockReturnValue(false);
      const env = { OPENCLAW_STATE_DIR: dirs.make("recovery-guidance-observation-") };
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      recordUpdateRunVerification(
        run.runId,
        {
          serviceRunning: serviceRunning !== true,
          runningVersion: "2026.8.99",
          booted: true,
          recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
        },
        { env },
      );
      recordUpdateRunStep(
        run.runId,
        { step: "gateway verification", status: "failed", detail: "stale-unhealthy" },
        { env },
      );
      const saved = getUpdateRun(run.runId, { env })?.verification;
      const latest = failure({
        reason: "post-update-plugins",
        recovery: { serviceRestartSafe: true, version: "2026.9.5", service: "healthy" },
        verification:
          serviceRunning === undefined ? {} : { serviceRunning, runningVersion: "2026.9.5" },
        steps:
          serviceRunning === false
            ? [
                {
                  name: "gateway recovery verification",
                  command: "gateway verification",
                  cwd: "/fixture",
                  durationMs: 0,
                  exitCode: 1,
                  failureFacts: [
                    {
                      check: "gateway-recovery",
                      code: "current-not-ready",
                      message: "Current Gateway readiness failed",
                    },
                  ],
                },
              ]
            : [],
      });

      const action = recordUpdateResultNextAction({ opts: { run } }, latest);

      expect(action).not.toContain("2026.8.99");
      expect(action).not.toContain("stale-unhealthy");
      expect(action).toContain("keep the update installed and do not roll back code alone");
      if (serviceRunning === true) {
        expect(action).toContain("gateway is running 2026.9.5");
        expect(action).not.toContain("Keep the gateway stopped");
      } else if (serviceRunning === false) {
        expect(action).toContain("Managed gateway remains stopped");
        expect(action).toContain("current-not-ready");
      } else {
        expect(action).not.toContain("gateway is running");
        expect(action).not.toContain("Managed gateway remains stopped");
      }
      const recorded = getUpdateRun(run.runId, { env });
      expect(recorded?.verification).toEqual(saved);
      expect(recorded?.origin.nextAction).toBe(action);
    },
  );

  it.each(["node-runtime-preflight", "global-install-permission-denied"])(
    "retains the actionable %s outcome in history",
    async (reason) => {
      vi.mocked(isContainerEnvironment).mockReturnValue(false);
      const state = dirs.make("update-environment-report-");
      const env = {
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
      };
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      const message =
        reason === "node-runtime-preflight"
          ? "openclaw@2026.9.4 requires Node >=24.16.0; this host runs 22.23.2; upgrade Node then rerun openclaw update."
          : "Cannot write /usr/lib/node_modules (owner UID 0); run the package update as the owning account.";
      const failedStep = {
        name: reason,
        command: "openclaw update",
        cwd: "/fixture",
        durationMs: 0,
        exitCode: 1,
        stderrTail: message,
      };
      vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      await publishUpdateCommandTerminalResult(
        { opts: { json: true, run }, coreAlreadyCurrent: false },
        failure({
          reason,
          failedStep,
          steps: [failedStep],
        }),
        { rolledBack: false },
      );
      const stored = getUpdateRun(run.runId, { env });
      expect(stored?.origin.nextAction).toBe(message);
      expect(stored && renderUpdateRunReport(stored).markdown).toContain(message);
    },
  );

  it.each(["error", "skipped"] as const)(
    "records an untouched dirty checkout (%s)",
    async (status) => {
      const state = dirs.make("dirty-update-report-");
      const env = {
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
      };
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      await publishUpdateCommandTerminalResult(
        { opts: { json: true, run }, coreAlreadyCurrent: false },
        failure({
          status,
          mode: "git",
          reason: "dirty",
          steps: [],
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        }),
        { rolledBack: false },
      );
      const stored = getUpdateRun(run.runId, { env });
      const action = stored?.origin.nextAction;
      expect(action).toContain("before installation");
      expect(action).toContain("checkout was preserved");
      expect(action).toContain("Commit your changes and retry");
      expect(action).not.toContain("could not prove a runnable installation");
      expect(output.mock.calls[0]?.[0]).toMatchObject({ run: { origin: { nextAction: action } } });
      expect(stored && renderUpdateRunReport(stored).markdown).toContain(action);
    },
  );

  it("persists activation timeout guidance for the owning profile", async () => {
    const state = dirs.make("activation-timeout-report-");
    const env = {
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
      OPENCLAW_PROFILE: "work",
    };
    const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});

    await publishUpdateCommandTerminalResult(
      { opts: { json: true, run }, coreAlreadyCurrent: false },
      failure({ reason: "update-activation-timeout", steps: [] }),
      { rolledBack: false },
    );

    const stored = getUpdateRun(run.runId, { env });
    expect(stored).toMatchObject({
      status: "failed",
      phase: "finished",
      reason: "update-activation-timeout",
    });
    const action = stored?.origin.nextAction;
    expect(action).toContain("openclaw --profile work update status");
    expect(action).toContain("openclaw --profile work doctor");
    expect(action).toContain("Wait for the owning updater and its child processes to stop");
    expect(action).toContain("openclaw --profile work update repair");
    expect(output.mock.calls[0]?.[0]).toMatchObject({ run: { origin: { nextAction: action } } });
    expect(stored && renderUpdateRunReport(stored).markdown).toContain(action);
  });

  it.each([
    ["unknown", true, true, "global-install-foreign-destination"],
    ["unknown", true, false, "global-install-foreign-destination"],
    ["npm", false, true, "global-install-permission-denied"],
    ["npm", true, true, "global-install-permission-denied"],
    ["pnpm", false, true, "global-install-failed"],
    ["bun", true, true, "global-install-failed"],
    ["npm", false, false, "global-install-permission-denied"],
    ["npm", true, false, "global-install-failed"],
  ] as const)(
    "publishes consistent %s recovery (json=%s, container=%s, reason=%s)",
    async (mode, json, container, reason) => {
      vi.mocked(isContainerEnvironment).mockReturnValue(container);
      const state = dirs.make("container-update-report-");
      const env = {
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
      };
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      const result = await publishUpdateCommandTerminalResult(
        { opts: { json, run }, coreAlreadyCurrent: false },
        failure({ mode, reason }),
        { rolledBack: false },
      );
      const stored = getUpdateRun(run.runId, { env });
      expect(result.status).toBe("error");
      expect(stored?.status).toBe("failed");
      const action = stored?.origin.nextAction;
      if (reason === "global-install-foreign-destination") {
        expect(action).toBe(
          container
            ? `${foreignDetail} Detected a foreign npm destination inside a container. Pull or build an OpenClaw image with the target version, then recreate or redeploy the container with the same state/config mounts. In-container package changes are not durable.`
            : foreignDetail,
        );
      }
      if (reason === "global-install-permission-denied") {
        expect(action?.startsWith(permissionDetail)).toBe(true);
      }
      if (container) {
        expect(action).toContain("inside a container");
        expect(action).toContain("Pull or build an OpenClaw image");
        expect(action).toContain(redeploy);
        expect(action).toContain("same state/config mounts");
        expect(action).not.toMatch(/sudo|npm config set prefix/);
      } else {
        expect(action).toBe(
          reason === "global-install-permission-denied"
            ? permissionDetail
            : reason === "global-install-foreign-destination"
              ? foreignDetail
              : hostGuidance,
        );
      }
      expect(stored && renderUpdateRunReport(stored).markdown).toContain(action);
      if (json) {
        expect(output).toHaveBeenCalledOnce();
        expect(output.mock.calls[0]?.[0]).toMatchObject({
          status: "error",
          run: { origin: { nextAction: action } },
        });
      } else {
        expect(log.mock.calls.flat().join("\n")).toContain(action);
      }
    },
  );

  it.each([
    ["package-install", "global-install-failed"],
    ["package-install-omit-optional", "global-install-failed"],
    ["package-swap", "global-install-failed"],
    ["global-install-permission-denied", "global-install-permission-denied"],
  ])("covers the %s permission failure", (name, reason) => {
    const result = failure({ reason });
    result.failedStep = {
      ...result.steps[0]!,
      name,
      stderrTail:
        reason === "global-install-failed"
          ? permissionDetail
          : permissionDetail.replace("EACCES", "EPERM"),
    };
    result.steps = [result.failedStep];
    expect(resolveUpdateResultNextAction({ result, env: {} })).toContain(redeploy);
  });

  it.each([
    ["success", { status: "ok" }],
    ["git update", { mode: "git" }],
    ["unknown install", { mode: "unknown" }],
    ["missing failure", { steps: [], failedStep: undefined }],
  ] satisfies [string, Partial<UpdateRunResult>][])(
    "does not give image advice for %s",
    (_name, overrides) => {
      expect(
        resolveUpdateResultNextAction({ result: failure(overrides), env: {} }) ?? "",
      ).not.toContain(redeploy);
    },
  );

  it.each([
    "other error",
    "unrelated step",
    "package Doctor",
    "later failure",
    "advisory",
    "successful step",
  ])("does not reinterpret %s as a container package failure", (kind) => {
    const result = failure();
    const step = result.steps[0]!;
    if (kind === "other error") {
      step.stderrTail = "ENOSPC: no space left on device";
    }
    if (kind === "unrelated step") {
      step.name = "config validate";
    }
    if (kind === "package Doctor") {
      step.name = "openclaw doctor";
    }
    if (kind === "later failure") {
      result.failedStep = {
        ...step,
        name: "config validate",
        stderrTail: "invalid configuration",
      };
      result.steps.push(result.failedStep);
    }
    if (kind === "advisory") {
      step.advisory = { kind: "recoverable-maintenance", message: "Old backup retained" };
    }
    if (kind === "successful step") {
      step.exitCode = 0;
    }
    expect(resolveUpdateResultNextAction({ result, env: {} })).toBe(hostGuidance);
  });

  it.each([true, false, undefined])(
    "preserves migrated-state and service safety (running=%s)",
    (serviceRunning) => {
      const result = failure({
        reason: "global-install-permission-denied",
        recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
      });
      const action = resolveUpdateResultNextAction({
        result,
        serviceRunning,
        runningVersion: "2.0.0",
        env: {},
      });
      expect(action?.startsWith(permissionDetail)).toBe(true);
      expect(action).toContain(redeploy);
      expect(action).toContain("Update Doctor may have migrated state");
      expect(action).toContain("keep the update installed and do not roll back code alone");
      expect(action).toContain(
        serviceRunning ? "gateway is running 2.0.0" : "could not prove a runnable installation",
      );
      if (serviceRunning === false) {
        expect(action).toContain("Keep the gateway stopped");
      }
    },
  );

  it("preserves rollback refusal without recommending a replacement image", () => {
    const action = resolveUpdateResultNextAction({
      result: failure({ reason: "rollback-project-changed" }),
      env: {},
    });
    expect(action).toContain("automatic rollback was refused to preserve them");
    expect(action).not.toContain(redeploy);
  });
});
