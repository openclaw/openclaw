import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { expectNoSideEffects, freshRestartCalls } from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  gatewayFixturePid,
  serviceReadRuntime,
  serviceRestart,
  serviceStart,
  serviceStop,
  serviceDefinitionMutationCapability,
  suspendScheduledTaskAutoStartForUpdate,
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  resolveGatewayInstallEntrypoint,
} from "./update-cli-modules.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const nodeExecutable = resolveTestNodeExecPath();
  const { createCaseDir, mockRunningManagedGateway, primeServiceCommand } =
    createUpdateCliFixture();

  it("refuses native preparation after admitted writable configuration drift", async () => {
    const argv = [nodeExecutable, path.join(process.cwd(), "dist", "index.js"), "gateway"];
    mockRunningManagedGateway(argv);
    const { maybeStopManagedServiceBeforeMutableUpdate } =
      await import("./update-cli/update-command-service.js");
    const params = {
      updateInstallKind: "package" as const,
      root: process.cwd(),
      shouldRestart: true,
      jsonMode: true,
    };
    const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
      ...params,
      phase: "inspect",
    });
    expect(inspected.serviceUpdateVerdict).toMatchObject({
      kind: "owned",
      refreshDefinition: true,
    });
    primeServiceCommand(argv, { PREFLIGHT_STORE_ROOT: createCaseDir("service-config-drift") });
    await expect(
      maybeStopManagedServiceBeforeMutableUpdate({
        ...params,
        expectedService: inspected,
        phase: "prepare",
      }),
    ).rejects.toThrow("changed");
    expect(suspendScheduledTaskAutoStartForUpdate).not.toHaveBeenCalled();
    expect(serviceStop).not.toHaveBeenCalled();
  });

  it.each([
    ["sealed", "writable"],
    ["writable", "unknown"],
  ] as const)(
    "retains activation but not refresh when authority changes %s -> %s",
    async (beforeKind, afterKind) => {
      mockRunningManagedGateway([
        nodeExecutable,
        path.join(process.cwd(), "dist", "index.js"),
        "gateway",
      ]);
      serviceDefinitionMutationCapability.mockResolvedValue({ kind: beforeKind, detail: "owner" });
      const { maybeStopManagedServiceBeforeMutableUpdate } =
        await import("./update-cli/update-command-service.js");
      const { revalidateManagedGatewayServiceAfterUpdate } =
        await import("./update-cli/update-command-service-revalidation.js");
      const before = await maybeStopManagedServiceBeforeMutableUpdate({
        root: process.cwd(),
        updateInstallKind: "git",
        shouldRestart: true,
        jsonMode: true,
      });
      serviceDefinitionMutationCapability.mockResolvedValue({ kind: afterKind, detail: "owner" });
      const { readGatewayServiceState, resolveGatewayService } =
        await import("../daemon/service.js");
      const state = await readGatewayServiceState(resolveGatewayService(), {
        requireEffective: true,
      });
      await expect(
        revalidateManagedGatewayServiceAfterUpdate({
          state,
          root: process.cwd(),
          preManagedServiceStop: before,
        }),
      ).resolves.toMatchObject({ kind: "owned", refreshDefinition: false });
    },
  );

  it.each(["unchanged", "changed"] as const)(
    "recovers shipped unresolved services only with unchanged inspection (%s)",
    async (inspection) => {
      const entrypoint = path.join(process.cwd(), "dist", "index.js");
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);
      mockRunningManagedGateway();
      const { maybeRestartServiceAfterFailedMutableUpdate } =
        await import("./update-cli/update-command-service.js");
      // Shipped handoffs can retain this launcher; fresh admission no longer stops it.
      const { createShippedUnresolvedServiceStop } =
        await import("./update-cli/update-command-service-state.test-support.js");
      const before = createShippedUnresolvedServiceStop(process.env, process.cwd());
      serviceReadRuntime.mockImplementation(async () =>
        freshRestartCalls().length > 0
          ? { status: "running", pid: gatewayFixturePid, state: "running" }
          : { status: "stopped", state: "stopped" },
      );
      if (inspection === "changed") {
        mockRunningManagedGateway(["foreign-openclaw", "gateway", "run"]);
      }

      await maybeRestartServiceAfterFailedMutableUpdate({
        preManagedServiceStop: before,
        recovery: { serviceRestartSafe: true, version: "1.0.0" },
        jsonMode: true,
      });

      expectNoSideEffects(serviceStart, serviceRestart);
      if (inspection === "unchanged") {
        expect(freshRestartCalls()).toEqual([
          [
            [process.execPath, entrypoint, "gateway", "restart", "--preserve-definition", "--json"],
            expect.objectContaining({ cwd: process.cwd(), baseEnv: {} }),
          ],
        ]);
      } else {
        expect(freshRestartCalls()).toHaveLength(0);
        expect(defaultRuntime.error).toHaveBeenCalledWith(
          expect.stringContaining("Failed to restart managed gateway service after failed update"),
        );
      }
    },
  );
});
