import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { installLaunchAgent } from "../../daemon/launchd-install.js";
import { gitReleaseSlot } from "../../infra/git-release-paths.js";
import { createGitReleaseDirs, publishGitRelease } from "../../infra/git-release.js";
import {
  createUpdateRun,
  getUpdateRun,
  readOwedUpdateSteps,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { maybeRestartService } from "./update-command-service.js";

const native = vi.hoisted(() => ({
  membership: vi.fn(() => "inside" as "inside" | "outside"),
  control: vi.fn(),
  actions: [] as string[],
}));
// Native observation seam: a reparented helper still belongs to the Gateway's job.
vi.mock("../../daemon/service-process-membership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service-process-membership.js")>()),
  inspectServiceProcessMembershipSync: native.membership,
}));
vi.mock("../../infra/restart-stale-pids.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/restart-stale-pids.js")>()),
  getSelfAndAncestorPidsSync: () => new Set([process.pid, 1]),
}));
vi.mock("../../daemon/launchd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/launchd-exec.js")>()),
  execLaunchctl: native.control,
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: () => ({
    readRuntime: async () => ({ status: "running", pid: 4242 }),
  }),
}));
vi.mock("../../runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runtime.js")>();
  return {
    ...actual,
    defaultRuntime: { ...actual.defaultRuntime, error: vi.fn(), log: vi.fn() },
  };
});
// Model only the child transport: the real installer and its native guard decide refusal.
vi.mock("./update-command-service-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-command.js")>()),
  runUpdatedInstallGatewayCommand: async (
    params: { serviceEnv: NodeJS.ProcessEnv; result: { root: string } },
    action: string,
  ) => {
    native.actions.push(action);
    await installLaunchAgent({
      env: params.serviceEnv,
      stdout: new PassThrough(),
      programArguments: [
        process.execPath,
        path.join(
          path.dirname(path.dirname(path.dirname(params.result.root))),
          "openclaw-launcher.mjs",
        ),
        "gateway",
      ],
    });
    return "accepted";
  },
}));

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("restores the serving selection after a Gateway-origin conversion rebind is refused", async () => {
  const root = temporary.make("git-release-conversion-");
  vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: root });
  const stateDir = path.join(root, ".openclaw");
  const prefix = path.join(stateDir, "git-install");
  const env = {
    HOME: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.conversion",
  };
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  vi.stubEnv("OPENCLAW_PROFILE", "default");
  native.actions.length = 0;
  native.membership.mockReturnValue("inside");
  native.control.mockImplementation(async (args: string[]) => {
    expect(args[0]).toBe("print");
    return {
      code: 0,
      stdout: `${args[1]} = {\n\tstate = running\n\tpid = 4242\n}`,
      stderr: "",
      termination: "exit",
    };
  });
  const releases: string[] = [];
  let publication: Awaited<ReturnType<typeof publishGitRelease>> | undefined;
  for (const buildId of ["serving-build", "target-build"]) {
    const releaseRoot = (await createGitReleaseDirs(prefix)).releaseRoot;
    releases.push(releaseRoot);
    await fs.mkdir(path.join(releaseRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(releaseRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.11.4" }),
    );
    await fs.writeFile(
      path.join(releaseRoot, "dist", "build-info.json"),
      JSON.stringify({ version: "2026.11.4", buildId }),
    );
    publication = await publishGitRelease({ prefix, releaseRoot, trial: releases.length === 2 });
  }
  const result: UpdateRunResult = {
    mode: "git",
    status: "ok",
    root: gitReleaseSlot(prefix),
    steps: [],
    durationMs: 1,
    before: { version: "2026.11.4", buildId: "serving-build" },
    after: { version: "2026.11.4", buildId: "target-build" },
    gitReleaseConversion: publication?.rollback,
  };
  const run = {
    runId: createUpdateRun({ trigger: "control-ui", before: result.before }, { env }).runId,
    env,
  };
  recordUpdateRunVerification(
    run.runId,
    {
      serviceRunning: true,
      pid: 4242,
      runningVersion: "2026.11.4",
      runningBuildId: "serving-build",
      readyz: true,
      coreReady: true,
    },
    run,
  );
  const onVerified = vi.fn();
  const onVerificationFailure = vi.fn();
  const outcome = await maybeRestartService({
    result,
    shouldRestart: true,
    opts: { json: true, run },
    refreshServiceEnv: true,
    onVerified,
    onVerificationFailure,
    serviceEnv: env,
    gatewayPort: 19305,
    timeoutMs: 1000,
    serviceUpdateVerdict: {
      kind: "owned",
      root,
      fingerprint: "fixture",
      refreshDefinition: true,
      requiresInstallRootRefresh: true,
    },
  });
  expect(vi.mocked(defaultRuntime.error).mock.calls.flat().join("\n")).toContain(
    "Refusing to install LaunchAgent",
  );
  expect(outcome).toBe("failed");
  expect(native.membership).toHaveBeenCalledWith(4242, "darwin");
  expect(native.actions).toEqual(["install"]);
  expect(await fs.realpath(gitReleaseSlot(prefix))).toBe(releases[0]);
  await expect(fs.access(path.join(prefix, "releases", ".trial"))).rejects.toThrow();
  expect(vi.mocked(defaultRuntime.error).mock.calls.flat().join("\n")).toContain("external shell");
  expect(result.after?.buildId).toBe("target-build");
  expect(result.rollbackOutcome?.status).toBe("succeeded");
  expect(onVerified).not.toHaveBeenCalled();
  expect(onVerificationFailure).toHaveBeenCalledWith("git-release-service-rebind-refused");
  expect(getUpdateRun(run.runId, run)?.verification).toMatchObject({
    serviceRunning: true,
    pid: 4242,
    runningBuildId: "serving-build",
    readyz: true,
  });
  expect(readOwedUpdateSteps(run)).toContainEqual(
    expect.objectContaining({
      id: "service-definition",
      reason: expect.stringContaining("external shell"),
    }),
  );
});
