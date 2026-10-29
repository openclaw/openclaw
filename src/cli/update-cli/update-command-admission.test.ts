import "./update-command-execution.test-support.js";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as physicalStore from "../../infra/database-engine/physical-store.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { prepareGitMutation } from "../../infra/update-runner-git-target.js";
import * as databaseBackup from "../../snapshot/database-backup.js";
import { writeFixtureJson } from "../cli-fixtures.test-support.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { useExecutorFixture } from "./update-command-executor.test-support.js";
import type { updateGitInstall } from "./update-command-git.js";

const { bindExecutionGuards, executionParams, mocks, schemaContext, successfulUpdate } =
  await import("./update-command-execution.test-support.js");

type GitUpdateOptions = Parameters<typeof updateGitInstall>[0];
const makeFixture = useExecutorFixture("update-target-admission-");
function admissionFixture(target: Parameters<typeof createUpdateRun>[0]["target"]) {
  const { root: dir } = makeFixture();
  const env = { OPENCLAW_STATE_DIR: dir };
  const { runId } = createUpdateRun({ trigger: "cli", target }, { env });
  const context = { ...schemaContext("invoker"), env, readEnv: env };
  mocks.captureSchemaContext.mockResolvedValue(context);
  const params = executionParams(target?.kind === "git" ? "git" : "package");
  params.root = dir;
  params.opts.run = { runId, env };
  const execute = () =>
    withUpdateCommandExecutor(runId, async (executor) => {
      mocks.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admitExecutor) => {
        admitExecutor(await executor.enter(dir));
      });
      return executeMutableUpdate(await bindExecutionGuards(params));
    });
  return {
    dir,
    env,
    runId,
    context,
    params,
    execute,
    engineReads: vi.spyOn(databaseBackup, "readBackupEngine"),
    physicalEngineReads: vi.spyOn(physicalStore, "readBackupEngine"),
  };
}

it("admits compatible Git targets without copying stores", async () => {
  const { dir, env, context, params, execute, engineReads, physicalEngineReads } = admissionFixture(
    {
      kind: "git",
      channel: "dev",
    },
  );
  params.shouldRestart = false;
  params.opts.restart = false;
  mocks.captureManagedPreflight.mockResolvedValue(context);
  mocks.maybeStopService.mockResolvedValue({
    inspected: true,
    running: false,
    stopped: false,
    offline: true,
    serviceEnv: env,
    serviceUpdateVerdict: {
      kind: "owned",
      root: dir,
      fingerprint: "service-fingerprint",
      refreshDefinition: false,
    },
  });
  const events: string[] = [];
  mocks.runGitUpdate.mockImplementation(async (options: GitUpdateOptions) => {
    if (!options.inspectGitTarget || !options.beforeGitMutation) {
      throw new Error("Missing actual Git admission callbacks");
    }
    const target = { databaseEngines: ["sqlite", "postgres"] };
    await options.inspectGitTarget(target);
    events.push("inspected");
    await options.beforeGitMutation(target);
    events.push("activated");
    return { ...successfulUpdate, mode: "git" };
  });
  const result = await execute();
  expect(result).toMatchObject({ result: { status: "ok" }, mutationStarted: true });
  expect(events).toEqual(["inspected", "activated"]);
  expect(engineReads).not.toHaveBeenCalled();
  expect(physicalEngineReads).not.toHaveBeenCalled();
});

it.each(["package", "staged", "git"] as const)(
  "refuses an unsupported native receiver before activation: %s",
  async (route) => {
    const { dir, env, runId, params, execute, engineReads, physicalEngineReads } = admissionFixture(
      route === "git" ? { kind: "git", channel: "dev", tag: "latest" } : {},
    );
    params.updateStepTimeoutMs = 600_000;
    mocks.captureManagedPreflight.mockResolvedValue(undefined);
    const databaseEngines = ["sqlite", "postgres"];
    const schemaVersions = { state: 15, agent: 19 };
    const firstSha = "1".repeat(40);
    const nextSha = "2".repeat(40);
    await writeFixtureJson(path.join(dir, "package.json"), { openclaw: { databaseEngines } });
    if (route === "staged") {
      params.packageInstallSpec = path.join(dir, "candidate.tgz");
    }
    const events: string[] = [];
    mocks.nativeSupport.mockImplementation(async ({ executor }) => {
      executor.assertCurrent();
      events.push("native-admission");
      return false;
    });
    const candidate = async ({
      validateCandidate,
    }: {
      validateCandidate: (root: string) => Promise<unknown>;
    }) => {
      await validateCandidate(dir);
      // Models the package/Git publisher which follows successful validation.
      events.push("publish");
      return successfulUpdate;
    };
    mocks.runPackageUpdate.mockImplementation(candidate);
    mocks.runGitUpdate.mockImplementation(async (options: GitUpdateOptions) => {
      if (!options.inspectGitTarget || !options.validateCandidate) {
        throw new Error("Missing actual Git admission callbacks");
      }
      await prepareGitMutation({
        root: dir,
        revision: firstSha,
        timeoutMs: params.updateStepTimeoutMs,
        runCommand: async () => ({
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            version: "2026.9.4",
            openclaw: { schemaVersions, databaseEngines },
          }),
        }),
        beforeGitMutation: options.inspectGitTarget,
      });
      expect(getUpdateRun(runId, { env })?.target).toMatchObject({
        version: "2026.9.4",
        sha: firstSha,
      });
      await options.inspectGitTarget({
        sha: nextSha,
        schemaVersions,
        databaseEngines,
      });
      return candidate({ validateCandidate: options.validateCandidate });
    });
    const result = await execute();
    expect(result?.result).toMatchObject({
      status: "error",
      reason: "target-native-unsupported",
    });
    expect(events).toEqual(["native-admission"]);
    expect(mocks.nativeSupport.mock.calls[0]?.[0]).toMatchObject({
      timeoutMs: params.updateStepTimeoutMs,
    });
    expect(mocks.serviceStopped).toBe(false);
    expect(mocks.validateCanary).not.toHaveBeenCalled();
    // Known target support must not copy live stores merely to rediscover their engines.
    expect(engineReads).not.toHaveBeenCalled();
    expect(physicalEngineReads).not.toHaveBeenCalled();
    if (route === "git") {
      expect(getUpdateRun(runId, { env })?.target).toEqual({
        kind: "git",
        channel: "dev",
        tag: "latest",
        sha: nextSha,
      });
    }
  },
);
