import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { isContainerEnvironment } from "../../infra/container-environment.js";
import * as snapshot from "../../infra/sqlite-snapshot-source.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { observeUpdateGatewayReadiness } from "./update-command-readiness.js";
import { recordUpdateResultNextAction } from "./update-command-result.js";
import { publishUpdateCommandTerminalResult } from "./update-command-terminal.js";
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
function createRun(options: { nextAction?: string; profile?: string } = {}) {
  const state = dirs.make("update-recovery-guidance-");
  const env = {
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
    OPENCLAW_PROFILE: options.profile,
  };
  return {
    runId: createUpdateRun({ trigger: "cli", origin: { nextAction: options.nextAction } }, { env })
      .runId,
    env,
  };
}

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
  it.each([true, false])(
    "publishes recovery observation consistently after validation fails (healthy=%s)",
    async (healthy) => {
      vi.mocked(isContainerEnvironment).mockReturnValue(false);
      const run = createRun();
      const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      const failedStep = {
        name: "validating",
        command: "validate runtime inventory",
        cwd: "/fixture",
        durationMs: 1,
        exitCode: 1,
        stderrTail: "Runtime inventory refused a retained backup link",
      };
      const result = failure({
        reason: "update-failed",
        before: { version: "2026.9.6" },
        after: { version: "2026.9.6" },
        failedStep,
        steps: [failedStep],
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      });
      vi.mocked(observeUpdateGatewayReadiness).mockResolvedValue({
        health: {
          runtime: { status: "running", pid: 12345 },
          portUsage: { port: 19123, status: "busy", listeners: [], hints: [] },
          healthy,
          staleGatewayPids: [],
          expectedVersion: "2026.9.6",
          gatewayVersion: "2026.9.6",
          ...(healthy ? {} : { channelProbeErrors: [{ id: "discord", error: "not ready" }] }),
        },
        readyz: healthy,
        http: undefined,
        launchAgentRecovery: null,
      });
      await verifyUpdatedGateway({
        result,
        opts: { run },
        serviceEnv: run.env,
        gatewayPort: 19123,
        requireRunningService: true,
        purpose: "recovery",
      });
      await publishUpdateCommandTerminalResult(
        { opts: { run }, coreAlreadyCurrent: false },
        result,
        { rolledBack: false },
      );
      const stored = getUpdateRun(run.runId, { env: run.env });
      expect(stored?.status).toBe("failed");
      expect(stored?.reason).toBe("update-failed");
      expect(stored?.verification.recovery).toEqual(result.recovery);
      const terminal = log.mock.calls.flat().join("\n");
      const reportPath = terminal.split("\n").find((line) => line.startsWith("Report: "));
      expect(reportPath).toBeDefined();
      const markdown = fs.readFileSync(reportPath!.slice("Report: ".length), "utf8");
      for (const output of [terminal, markdown, stored?.origin.nextAction ?? ""]) {
        if (healthy) {
          expect(output).toContain("Your Gateway is still serving 2026.9.6; nothing to restore.");
          expect(output).toContain("Fix update-failed then run `openclaw update` again.");
          expect(output).not.toContain("did not pass verification");
        } else {
          expect(output).toContain("gateway is running 2026.9.6 but did not pass verification");
          expect(output).toContain("channel-errors");
          expect(output).toContain(hostGuidance);
          expect(output).not.toContain("nothing to restore");
        }
      }
      if (healthy) {
        expect(terminal).toContain("Gateway: verified serving after update failure.");
        expect(markdown).toContain("restart remains unsafe (runtime-verification-failed)");
      }
    },
  );

  it.each([false, true])(
    "records next action from the admitted row without a cold snapshot (terminal=%s)",
    async (terminal) => {
      vi.mocked(isContainerEnvironment).mockReturnValue(false);
      const run = createRun({ nextAction: "previous guidance" });
      const { env } = run;
      if (terminal) {
        finishUpdateRun(run.runId, { status: "failed", reason: "build-failed" }, { env });
      }
      const before = getUpdateRun(run.runId, { env });
      closeOpenClawStateDatabaseForTest();
      const read = vi
        .spyOn(snapshot, "prepareSqliteReadOnlyLocationSync")
        .mockImplementation(() => {
          throw new Error("SQLite source did not stabilize during update reporting");
        });
      let nextAction: string | undefined;
      try {
        nextAction = recordUpdateResultNextAction(
          { opts: { run } },
          {
            status: "error",
            mode: "git",
            reason: "build-failed",
            steps: [],
            durationMs: 1,
          },
        );
      } finally {
        read.mockRestore();
      }
      expect(nextAction).toContain("openclaw triage");
      const after = getUpdateRun(run.runId, { env });
      if (terminal) {
        expect(after).toEqual(before);
      } else {
        expect(after?.origin.nextAction).toBe(nextAction);
        expect(after?.phase).toBe(before?.phase);
        expect(after?.status).toBe("running");
      }
    },
  );
  it.each([true, false, undefined])(
    "uses raw recovery facts for immediate guidance without replacing history (running=%s)",
    (serviceRunning) => {
      const run = createRun();
      const { env } = run;
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
        reason: "global-install-permission-denied",
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
      expect(action?.startsWith(permissionDetail)).toBe(true);
      expect(action).toContain(redeploy);
      expect(action).toContain("Update Doctor may have migrated state");
      expect(action).toContain("keep the update installed and do not roll back code alone");
      if (serviceRunning === true) {
        expect(action).toContain("gateway is running 2026.9.5");
        expect(action).not.toContain("Keep the gateway stopped");
      } else if (serviceRunning === false) {
        expect(action).toContain("Managed gateway remains stopped");
        expect(action).toContain("Keep the gateway stopped");
        expect(action).toContain("could not prove a runnable installation");
        expect(action).toContain("current-not-ready");
      } else {
        expect(action).not.toContain("gateway is running");
        expect(action).not.toContain("Managed gateway remains stopped");
        expect(action).toContain("could not prove a runnable installation");
      }
      const recorded = getUpdateRun(run.runId, { env });
      expect(recorded?.verification).toEqual(saved);
      expect(recorded?.origin.nextAction).toBe(action);
    },
  );

  it("retains the actionable Node runtime refusal in history", async () => {
    const reason = "node-runtime-preflight";
    vi.mocked(isContainerEnvironment).mockReturnValue(false);
    const run = createRun();
    const { env } = run;
    const message =
      "openclaw@2026.9.4 requires Node >=24.16.0; this host runs 22.23.2; upgrade Node then rerun openclaw update.";
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
  });

  it("records an untouched dirty checkout", async () => {
    const run = createRun();
    const { env } = run;
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    await publishUpdateCommandTerminalResult(
      { opts: { json: true, run }, coreAlreadyCurrent: false },
      failure({
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
  });

  it("persists activation timeout guidance for the owning profile", async () => {
    const run = createRun({ profile: "work" });
    const { env } = run;
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
    ["pnpm", false, true, "global-install-failed"],
    ["bun", true, true, "global-install-failed"],
    ["npm", false, false, "global-install-permission-denied"],
    ["npm", true, false, "global-install-failed"],
  ] as const)(
    "publishes consistent %s recovery (json=%s, container=%s, reason=%s)",
    async (mode, json, container, reason) => {
      vi.mocked(isContainerEnvironment).mockReturnValue(container);
      const run = createRun();
      const { env } = run;
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

  it("recognizes permission failures from suffixed package steps", () => {
    const result = failure();
    result.failedStep = {
      ...result.steps[0]!,
      name: "package-install-omit-optional",
      stderrTail: permissionDetail.replace("EPERM", "EACCES"),
    };
    result.steps = [result.failedStep];
    expect(resolveUpdateResultNextAction({ result, env: {} })).toContain(redeploy);
  });

  it.each([
    ["success", { status: "ok" }],
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

  it.each(["other error", "unrelated step", "later failure", "advisory", "successful step"])(
    "does not reinterpret %s as a container package failure",
    (kind) => {
      const result = failure();
      const step = result.steps[0]!;
      if (kind === "other error") {
        step.stderrTail = "ENOSPC: no space left on device";
      }
      if (kind === "unrelated step") {
        step.name = "config validate";
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

  it("describes successful-update cleanup as permanent migration-original retirement", () => {
    const action = resolveUpdateResultNextAction({
      result: { status: "ok", mode: "git", steps: [], durationMs: 0 },
      env: { OPENCLAW_PROFILE: "work", OPENCLAW_STATE_DIR: "/fixture/state" },
    });

    expect(action).toContain("After confirming the update and your conversations are healthy");
    expect(action).toContain("retained migration originals eligible for permanent cleanup");
    expect(action).toContain("`openclaw --profile work update cleanup --dry-run`");
    expect(action).toContain("state `/fixture/state`");
    expect(action).toContain("Use the same profile, state, and config settings.");
  });
});
