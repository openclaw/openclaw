import path from "node:path";
import { assert, expect, it, vi } from "vitest";
import type * as GatewayEntrypoints from "../daemon/gateway-entrypoint.js";
import { DoctorUnreadableStateDatabaseError } from "../infra/state-repair-message.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import * as assertions from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as update from "./update-cli-modules.test-support.js";
import * as configOwner from "./update-cli/update-command-config.js";
import * as executionOwner from "./update-cli/update-command-execution.js";
import * as contextOwner from "./update-cli/update-command-managed-context.js";
import * as migratedOwner from "./update-cli/update-command-migrated.js";
import type { MutableUpdateExecutionResult } from "./update-cli/update-command-result.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

const setup = createUpdateCliFixture();

it.each(["pre-activation", "data-at-risk"] as const)(
  "routes package %s failure through the appropriate finalization",
  async (failure) => {
    const dataAtRisk = failure === "data-at-risk";
    const root = await setup.mockPackageInstallAtCaseDir("preactivation-inspection");
    setup.mockFileBackedPathExists();
    const actual = await vi.importActual<typeof GatewayEntrypoints>(
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
    const events: string[] = [];
    const original = dataAtRisk
      ? new DoctorUnreadableStateDatabaseError("state.sqlite", "fixture corruption")
      : new DOMException("CLI stopping", "AbortError");
    const continueCandidate = vi.spyOn(migratedOwner, "continueMigratedUpdateInFreshProcess");
    const capture = contextOwner.captureOwnedManagedUpdateContext;
    const inspect = vi.fn(async () => {
      throw new Error("Live source did not stabilize");
    });
    vi.spyOn(contextOwner, "captureOwnedManagedUpdateContext").mockImplementation(
      async (params) => {
        if (params.stopState?.stopped) {
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
    const stop = mocks.serviceStop.getMockImplementation()!;
    mocks.serviceStop.mockImplementation(async (...args) => {
      events.push("stop");
      return stop(...args);
    });
    const run = vi.mocked(update.runCommandWithTimeout).getMockImplementation()!;
    vi.mocked(update.runCommandWithTimeout).mockImplementation(async (argv, options) => {
      const result = await run(argv, options);
      if (result.code === 0 && argv[2] === "gateway" && argv[3] === "restart") {
        events.push("restore");
      }
      return result;
    });
    const execute = executionOwner.executeMutableUpdate;
    let execution: MutableUpdateExecutionResult | null | undefined;
    vi.spyOn(executionOwner, "executeMutableUpdate").mockImplementation(async (params) => {
      execution = await execute(params);
      return execution;
    });

    await expect(update.updateCommand({ yes: true, json: true })).rejects.toEqual(
      new update.ExitError(1),
    );

    assert(execution);
    expect(events, assertions.getErrorOutput()).toEqual(["stop", "capture-failed", "restore"]);
    expect(assertions.freshRestartCalls()).toHaveLength(1);
    expect(execution).toMatchObject({
      mutationStarted: false,
      failure: { cause: { cause: original } },
      result: { status: "error" },
    });
    expect(execution.schemaVersions).toBeDefined();
    if (dataAtRisk) {
      expect(inspect).toHaveBeenCalledOnce();
      expect(continueCandidate).toHaveBeenCalledOnce();
      expect(execution.result).toMatchObject({
        reason: "rollback-state-unverified",
        recovery: {
          serviceRestartSafe: false,
          dataAtRisk: "unreadable-state",
        },
      });
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
