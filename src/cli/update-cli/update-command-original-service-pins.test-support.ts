import { expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../../config/config.js";
import {
  commitDaemonRuntimePin,
  readDaemonRuntimePinForInstall,
} from "../../daemon/runtime-pin-state.js";
import * as runtimePins from "../../daemon/runtime-pin-state.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { OriginalServiceFixture } from "./update-command-original-service-fixture.test-support.js";
import { observeOriginalManagedServiceRuntime } from "./update-command-original-service.js";
import { prepareUpdateRestart } from "./update-command-restart-context.js";
import { maybeRestartService } from "./update-command-service.js";

export function registerRuntimePinPreservationTest(
  fixture: () => OriginalServiceFixture,
  admitted: (
    operation: (run: NonNullable<UpdateCommandOptions["run"]>) => Promise<void>,
  ) => Promise<void>,
) {
  it("converges onto the candidate after Doctor completes runtime pin migration", async () => {
    const { state, rootB, before, serviceNodeRunner, serviceState, mocks } = fixture();
    const scope = { kind: "gateway" as const, env: state.env };
    const pin = { runtime: "node" as const, path: serviceNodeRunner };
    commitDaemonRuntimePin(
      scope,
      { expected: readDaemonRuntimePinForInstall(scope, serviceState.command, true), pin },
      serviceState.command,
    );
    const pending = vi
      .spyOn(runtimePins, "readDaemonRuntimePinMigrationPending")
      .mockReturnValue(true);
    const read = vi.spyOn(runtimePins, "readDaemonRuntimePin").mockImplementation(() => {
      throw new Error("pending pins must not be read");
    });
    await admitted(async (run) => {
      const original = await observeOriginalManagedServiceRuntime(
        { root: rootB, opts: { run } },
        before,
      );
      if (!original) {
        throw new Error("missing original observation");
      }
      expect(original.definition.runtimePin).toBeUndefined();
      pending.mockRestore();
      read.mockRestore();
      const result = {
        status: "ok" as const,
        mode: "npm" as const,
        root: rootB,
        before: { version: "2026.9.4" },
        after: { version: "2026.9.5" },
        steps: [],
        durationMs: 1,
      };
      const prepared = await prepareUpdateRestart(
        {
          originalManagedServiceRuntime: original,
          preManagedServiceStop: before,
          root: rootB,
          result,
          shouldRestart: true,
          updateStepTimeoutMs: 30_000,
          assertCurrent: () => run.executorFence!.assertCurrent(),
        },
        await readConfigFileSnapshot({ observe: false }),
      );
      expect(prepared.serviceUpdateVerdict).toMatchObject({
        kind: "owned",
        refreshDefinition: true,
        requiresInstallRootRefresh: true,
      });
      expect(original.definition.runtimePin?.pin).toEqual(pin);
      mocks.restart.mockImplementation(async (_params, action) => {
        if (action === "install") {
          serviceState.command!.programArguments = [
            serviceNodeRunner,
            `${rootB}/dist/index.js`,
            "gateway",
          ];
        }
        return "accepted";
      });
      expect(
        await maybeRestartService({
          originalManagedServiceRuntime: original,
          shouldRestart: true,
          result,
          opts: { json: true, run },
          refreshServiceEnv: prepared.refreshGatewayServiceEnv,
          serviceInstallEnv: prepared.gatewayServiceInstallEnv,
          serviceEnv: prepared.gatewayServiceEnv,
          serviceUpdateVerdict: prepared.serviceUpdateVerdict,
          gatewayPort: prepared.gatewayPort,
          timeoutMs: 30_000,
        }),
      ).toBe("ok");
      expect(mocks.restart).toHaveBeenCalledWith(
        expect.objectContaining({
          refreshServiceEnv: true,
          result: expect.objectContaining({ root: rootB }),
        }),
        "install",
      );
      expect(mocks.health).toHaveBeenLastCalledWith(
        expect.objectContaining({ expectedVersion: "2026.9.5" }),
      );
    });
  });
}
