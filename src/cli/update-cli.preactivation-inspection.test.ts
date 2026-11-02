import path from "node:path";
import { assert, expect, it, vi } from "vitest";
import { DoctorUnreadableStateDatabaseError } from "../infra/state-repair-message.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import * as assertions from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as update from "./update-cli-modules.test-support.js";
import { writeOpenClawPackageFixture } from "./update-cli/update-cli-package.test-support.js";
import * as configOwner from "./update-cli/update-command-config.js";
import * as executionOwner from "./update-cli/update-command-execution.js";
import * as contextOwner from "./update-cli/update-command-managed-context.js";
import * as migratedOwner from "./update-cli/update-command-migrated.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

const setup = createUpdateCliFixture();

it.each([
  { kind: "git", failure: "pre-activation" },
  { kind: "package", failure: "pre-activation" },
  { kind: "git", failure: "post-mutation" },
  { kind: "git", failure: "data-at-risk" },
  { kind: "package", failure: "data-at-risk" },
] as const)(
  "routes $kind $failure failure through the appropriate finalization",
  async ({ kind, failure }) => {
    const afterMutation = failure === "post-mutation";
    const dataAtRisk = failure === "data-at-risk";
    let mutationAdmitted: ReturnType<typeof update.mockGitUpdateAfterMutation> | undefined;
    const previousSha = "b".repeat(40);
    const root =
      kind === "package"
        ? await setup.mockPackageInstallAtCaseDir("preactivation-inspection")
        : process.cwd();
    if (kind === "package") {
      setup.mockFileBackedPathExists();
      const actual = await vi.importActual<typeof import("../daemon/gateway-entrypoint.js")>(
        "../daemon/gateway-entrypoint.js",
      );
      // Recovery probes the installed predecessor, not the post-core Doctor fixture.
      vi.mocked(update.resolveGatewayInstallEntrypoint)
        .mockReset()
        .mockImplementation(actual.resolveGatewayInstallEntrypoint);
      setup.mockRunningManagedGateway([
        process.execPath,
        path.join(root, "dist/index.js"),
        "gateway",
        "run",
      ]);
    } else {
      await writeOpenClawPackageFixture(root, "1.0.0", {
        entrySource: "export {};\n",
        builtSha: previousSha,
        inventory: true,
      });
      setup.mockGatewayHealth("1.0.0", "previous-gateway", "fixture-original-build");
      setup.mockOwnedGitService(root);
      mocks.serviceLoaded.mockResolvedValue(true);
      mutationAdmitted = update.mockGitUpdateAfterMutation(
        update.makeOkUpdateResult({ root, after: { sha: "a".repeat(40), version: "1.0.0" } }),
      );
    }
    const events: string[] = [];
    const original = dataAtRisk
      ? new DoctorUnreadableStateDatabaseError("state.sqlite", "fixture corruption")
      : new DOMException("CLI stopping", "AbortError");
    const continueCandidate = vi.spyOn(migratedOwner, "continueMigratedUpdateInFreshProcess");
    const capture = contextOwner.captureOwnedManagedUpdateContext;
    const inspect = vi.fn(async () => {
      throw new Error("Live source did not stabilize");
    });
    if (afterMutation) {
      mutationAdmitted!.mockImplementation(() => {
        events.push("mutation-failed");
        mocks.stateSchemaVersions.mockImplementation(inspect);
        throw original;
      });
    }
    vi.spyOn(contextOwner, "captureOwnedManagedUpdateContext").mockImplementation(
      async (params) => {
        if (!afterMutation && params.stopState?.stopped) {
          vi.spyOn(configOwner, "readUpdateConfigFileSnapshot").mockRejectedValueOnce(original);
          try {
            return await capture(params);
          } catch (error) {
            events.push("capture-failed");
            mocks.stateSchemaVersions.mockImplementation(inspect);
            throw error;
          }
        }
        return capture(params);
      },
    );
    const activateGateway = setup.mockPackageGatewayLifecycle();
    const stop = mocks.serviceStop.getMockImplementation()!;
    mocks.serviceStop.mockImplementation(async (...args) => {
      events.push("stop");
      return stop(...args);
    });
    const run = vi.mocked(update.runCommandWithTimeout).getMockImplementation()!;
    vi.mocked(update.runCommandWithTimeout).mockImplementation(async (argv, options) => {
      const result = await run(argv, options);
      if (kind === "git" && argv[3] === "rev-parse" && argv[4] === "HEAD") {
        return { ...result, stdout: `${previousSha}\n` };
      }
      if (result.code === 0 && argv[2] === "gateway" && argv[3] === "restart") {
        if (kind === "git") {
          await activateGateway(argv);
          setup.mockGatewayHealth("1.0.0", "restored-gateway", "fixture-original-build");
        }
        events.push("restore");
      }
      return result;
    });
    const execute = executionOwner.executeMutableUpdate;
    let execution: Awaited<ReturnType<typeof execute>> | undefined;
    vi.spyOn(executionOwner, "executeMutableUpdate").mockImplementation(async (params) => {
      execution = await execute(params);
      return execution;
    });

    await expect(update.updateCommand({ yes: true, json: true })).rejects.toEqual(
      new update.ExitError(1),
    );

    assert(execution);
    expect(events, assertions.getErrorOutput()).toEqual(
      afterMutation ? ["stop", "mutation-failed"] : ["stop", "capture-failed", "restore"],
    );
    expect(assertions.freshRestartCalls()).toHaveLength(afterMutation ? 0 : 1);
    expect(execution).toMatchObject({
      mutationStarted: afterMutation,
      failure: { cause: afterMutation ? original : { cause: original } },
      result: { status: "error" },
    });
    expect(execution.schemaVersions).toBeDefined();
    if (afterMutation || dataAtRisk) {
      expect(inspect).toHaveBeenCalledOnce();
      expect(continueCandidate).toHaveBeenCalledOnce();
      expect(execution.result).toMatchObject({
        reason: "rollback-state-unverified",
        recovery: {
          serviceRestartSafe: false,
          dataAtRisk: dataAtRisk ? "unreadable-state" : "rollback-state-unverified",
        },
      });
      if (mutationAdmitted) {
        expect(mutationAdmitted).toHaveBeenCalledTimes(afterMutation ? 1 : 0);
      }
      return;
    }
    expect(continueCandidate).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    const result = assertions.lastWriteJsonCall() as UpdateRunResult;
    expect(result.reason).toBe("update-failed");
    expect(result.steps).not.toContainEqual(
      expect.objectContaining({ name: "state-schema-verification" }),
    );
    expect(JSON.stringify(result)).toContain("Failed to capture managed gateway update state");
    expect(result.recovery).not.toHaveProperty("dataAtRisk");
    expect(update.getUpdateRun(result.runId!)).toMatchObject({
      status: "failed",
      reason: "update-failed",
    });
  },
);
