import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { isContainerEnvironment } from "../../infra/container-environment.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { publishUpdateCommandTerminalResult } from "./update-command-terminal.js";
import { resolveUpdateResultNextAction } from "./update-recovery-guidance.js";

vi.mock("../../infra/container-environment.js", () => ({ isContainerEnvironment: vi.fn() }));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const hostGuidance =
  "Run `openclaw triage` on this machine to open a coding agent that can diagnose and repair the installation.";
const redeploy = "recreate or redeploy the container";
function failure(overrides: Partial<UpdateRunResult> = {}): UpdateRunResult {
  return {
    status: "error",
    mode: "npm",
    reason: "global-install-failed",
    recovery: { serviceRestartSafe: true, version: "1.0.0" },
    steps: [
      {
        name: "global install stage",
        command: "prepare staged npm install",
        cwd: "/fixture",
        durationMs: 0,
        exitCode: 1,
        stderrTail: "EACCES: permission denied",
      },
    ],
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

describe("container update recovery reporting", () => {
  it.each([
    ["npm", false, true],
    ["npm", true, true],
    ["pnpm", false, true],
    ["bun", true, true],
    ["npm", false, false],
    ["npm", true, false],
  ] as const)(
    "publishes consistent %s recovery (json=%s, container=%s)",
    (mode, json, container) => {
      vi.mocked(isContainerEnvironment).mockReturnValue(container);
      const state = dirs.make("container-update-report-");
      const env = {
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
      };
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      const result = publishUpdateCommandTerminalResult(
        { opts: { json, run }, coreAlreadyCurrent: false },
        failure({ mode }),
        { rolledBack: false },
      );
      const stored = getUpdateRun(run.runId, { env });
      expect(result.status).toBe("error");
      expect(stored?.status).toBe("failed");
      const action = stored?.origin.nextAction;
      if (container) {
        expect(action).toContain("inside a container");
        expect(action).toContain("Pull or build an OpenClaw image");
        expect(action).toContain(redeploy);
        expect(action).toContain("same state/config mounts");
        expect(action).not.toMatch(/sudo|npm config set prefix/);
      } else {
        expect(action).toBe(hostGuidance);
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

  it.each(["global update", "global update (omit optional)", "global install swap"])(
    "covers the %s permission failure",
    (name) => {
      const result = failure();
      result.steps[0] = { ...result.steps[0]!, name };
      expect(resolveUpdateResultNextAction({ result, env: {} })).toContain(redeploy);
    },
  );

  it.each([
    ["success", { status: "ok" }],
    ["git update", { mode: "git" }],
    ["unknown install", { mode: "unknown" }],
    ["missing steps", { steps: [] }],
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
        result.steps.push({
          ...step,
          name: "config validate",
          stderrTail: "invalid configuration",
        });
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

  it.each([true, false, undefined])(
    "preserves migrated-state and service safety (running=%s)",
    (serviceRunning) => {
      const result = failure({
        recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
      });
      const action = resolveUpdateResultNextAction({
        result,
        serviceRunning,
        runningVersion: "2.0.0",
        env: {},
      });
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
