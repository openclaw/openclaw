// Preserve the same package/Git entry fixture and its external service boundaries.
import "./update-command-execution.test-support.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { UpdateCommandOptions } from "./shared.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";

const { executionParams, mocks, successfulUpdate } =
  await import("./update-command-execution.test-support.js");
const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  root = fs.realpathSync(dirs.make("update-initial-admission-"));
  for (const dir of ["tmp", "state", "dist"]) {
    fs.mkdirSync(path.join(root, dir), { mode: 0o700 });
  }
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "1.0.1" }),
  );
  fs.writeFileSync(path.join(root, "dist", "index.js"), "");
  fs.writeFileSync(path.join(root, "state", "openclaw.json"), "{}\n");
  env = {
    HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "state", "openclaw.json"),
  };
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(path.join(root, "tmp"));
  mocks.maybeStopService.mockResolvedValue({
    stopped: false,
    inspected: true,
    runtimeInspected: true,
    running: false,
  });
  mocks.validateCanary.mockResolvedValue({
    status: "ok",
    phase: "readiness",
    steps: [],
    durationMs: 1,
    logTail: [],
    doctorConfigWrites: true,
  });
});
afterEach(() => vi.restoreAllMocks());

it.each(["package", "artifact", "git"] as const)(
  "admits the acquired owner at the real %s preparation boundary through activation and Doctor",
  async (kind) => {
    const params = {
      ...executionParams(kind === "git" ? "git" : "package"),
      root,
      shouldRestart: false,
    };
    if (kind === "artifact") {
      params.packageInstallSpec = path.join(root, "candidate.tgz");
      params.tag = params.packageInstallSpec;
    }
    const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
    const run: NonNullable<UpdateCommandOptions["run"]> = { runId, env };
    params.opts.run = run;
    let admitted: UpdateRecoveryFence | undefined;
    let activated = false;
    let doctorAdmitted = false;
    await withUpdateCommandExecutor(runId, async (executor) => {
      mocks.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admitExecutor) => {
        const fence = await executor.enter(root);
        admitExecutor(fence);
        admitted = fence;
        expect(run.executorFence).toBe(fence);
      });
      const doctor = (
        context: ReturnType<
          NonNullable<
            Parameters<
              typeof import("./update-command-package.js").runPackageInstallUpdate
            >[0]["getDoctorContext"]
          >
        >,
      ) => {
        expect(context?.executorFence).toBe(admitted);
        context?.assertCurrent?.();
        expect(context).toBeDefined();
        doctorAdmitted = true;
      };
      mocks.runPackageUpdate.mockImplementation(
        async (
          options: Parameters<
            typeof import("./update-command-package.js").runPackageInstallUpdate
          >[0],
        ) => {
          await options.validateCandidate(root);
          await options.beforeActivate();
          activated = true;
          doctor(options.getDoctorContext?.());
          return successfulUpdate;
        },
      );
      mocks.runGitUpdate.mockImplementation(
        async (
          options: Parameters<typeof import("./update-command-git.js").updateGitInstall>[0],
        ) => {
          await options.inspectGitTarget?.({ schemaVersions: { state: 15, agent: 19 } });
          await options.validateCandidate?.(root);
          await options.beforeGitMutation?.({ schemaVersions: { state: 15, agent: 19 } });
          activated = true;
          doctor(options.getDoctorContext?.());
          return { ...successfulUpdate, mode: "git" };
        },
      );
      const result = await executeMutableUpdate(params);
      expect(result?.result.status, JSON.stringify(mocks.runtimeError.mock.calls)).toBe("ok");
      expect(result?.mutationStarted).toBe(true);
      expect(activated).toBe(true);
      expect(doctorAdmitted).toBe(true);
      expect(admitted).toBeDefined();
      admitted?.assertCurrent();
    });
  },
);

it.each([
  "unsolicited-assignment",
  "unregistered-fence",
  "wrong-run",
  "wrong-root",
  "run-replaced",
  "run-id-changed",
  "requester-replaced",
  "requester-revoked",
  "recovery-pending",
  "replacement-after-admission",
] as const)(
  "refuses %s instead of adopting an arbitrary first or replacement owner",
  async (change) => {
    const params = { ...executionParams("package"), root, shouldRestart: false };
    const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
    let current = true;
    const requesterAuthority = {
      requester: { channel: "test", senderId: "owner" },
      isCurrent: () => current,
    };
    const run: NonNullable<UpdateCommandOptions["run"]> = { runId, env, requesterAuthority };
    params.opts.run = run;
    const wrongRoot = path.join(root, "other");
    fs.mkdirSync(wrongRoot);
    let admitted = false;
    await withUpdateCommandExecutor(
      change === "wrong-run" ? randomUUID() : runId,
      async (executor) => {
        mocks.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admitExecutor) => {
          const fence = await executor.enter(change === "wrong-root" ? wrongRoot : root);
          if (change === "unsolicited-assignment") {
            run.executorFence = fence;
          }
          if (change === "run-replaced") {
            params.opts.run = { ...run };
          }
          if (change === "run-id-changed") {
            run.runId = randomUUID();
          }
          if (change === "requester-replaced") {
            run.requesterAuthority = { ...requesterAuthority };
          }
          if (change === "requester-revoked") {
            current = false;
          }
          if (change === "recovery-pending") {
            params.opts.recovery = {};
          }
          admitExecutor(change === "unregistered-fence" ? { assertCurrent() {} } : fence);
          admitted = true;
          if (change === "replacement-after-admission") {
            run.executorFence = { assertCurrent() {} };
          }
        });
        const result = await executeMutableUpdate(params);
        expect(result?.result.status).toBe("error");
        expect(result?.mutationStarted).toBe(false);
        expect(admitted).toBe(change === "replacement-after-admission");
        expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
        expect(mocks.serviceStopped).toBe(false);
      },
    );
  },
);
