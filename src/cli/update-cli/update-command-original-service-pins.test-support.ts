import { expect, it, vi } from "vitest";
import {
  commitDaemonRuntimePin,
  readDaemonRuntimePinForInstall,
} from "../../daemon/runtime-pin-state.js";
import * as runtimePins from "../../daemon/runtime-pin-state.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { OriginalServiceFixture } from "./update-command-original-service-fixture.test-support.js";
import { observeOriginalManagedServiceRuntime } from "./update-command-original-service.js";
import { maybeRestartService } from "./update-command-service.js";

export function registerRuntimePinPreservationTest(
  fixture: () => OriginalServiceFixture,
  admitted: (
    operation: (run: NonNullable<UpdateCommandOptions["run"]>) => Promise<void>,
  ) => Promise<void>,
) {
  it("preserves the observed runtime on a successful update while pin migration is pending", async () => {
    const { state, rootA, rootB, before, serviceNodeRunner, serviceState, mocks } = fixture();
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
      mocks.restart.mockResolvedValue("accepted");
      expect(
        await maybeRestartService({
          originalManagedServiceRuntime: original,
          shouldRestart: true,
          result: {
            status: "ok",
            mode: "npm",
            root: rootB,
            before: { version: "2026.9.4" },
            after: { version: "2026.9.5" },
            steps: [],
            durationMs: 1,
          },
          opts: { json: true, run },
          refreshServiceEnv: true,
          serviceInstallEnv: state.env,
          serviceEnv: state.env,
          serviceUpdateVerdict: before.serviceUpdateVerdict,
          gatewayPort: 18789,
          timeoutMs: 30_000,
        }),
      ).toBe("ok");
      expect(mocks.restart).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeRunner: serviceNodeRunner,
          refreshServiceEnv: false,
          serviceUpdateVerdict: expect.objectContaining({
            root: rootA,
            refreshDefinition: false,
            requiresInstallRootRefresh: false,
          }),
          expectedGatewayIdentity: { version: original.version, buildId: original.buildId },
        }),
        "restart",
      );
      expect(mocks.nativeInstall).not.toHaveBeenCalled();
      pending.mockRestore();
      read.mockRestore();
      const next = await observeOriginalManagedServiceRuntime(
        { root: rootB, opts: { run } },
        before,
      );
      expect(next?.definition.runtimePin?.pin).toEqual(pin);
    });
  });
}
