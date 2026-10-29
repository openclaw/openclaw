import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { capturePackageActivationRuntime } from "../../infra/package-update-activation-paths.js";
import { UpdatePreMutationError } from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { installFreshUpdateFixture } from "./update-command-fresh.test-support.js";
import { preparePackageUpdateRuntime } from "./update-command-node-runtime.js";
import * as preflight from "./update-command-runtime-preflight.js";

const { fixture } = installFreshUpdateFixture();
it.each(["before", "after", "unchanged"] as const)(
  "retains admission through runtime preparation: %s",
  async (boundary) => {
    const original = capturePackageActivationRuntime("node", process.execPath);
    let current = true;
    const check = vi.fn(async () => {
      if (!current) {
        throw new UpdatePreMutationError("managed-service-preflight", "original admission changed");
      }
    });
    await check();
    if (boundary === "before") {
      current = false;
    }
    const prepare = vi
      .spyOn(preflight, "resolvePackageRuntimePreflight")
      .mockImplementation(async (params) => {
        expect(params.nodeRunner).toBe(original.path);
        expect(params.runtimeRecovery).toBeUndefined();
        if (boundary === "after") {
          current = false;
        }
        return {
          ok: true,
          value: { nodeRunner: original.path, activationRuntime: { ...original } },
        };
      });
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const work = preparePackageUpdateRuntime({
        root: fixture.root,
        tag: "2026.9.2",
        shouldRestart: true,
        opts: { json: true },
        executor,
        timeoutMs: 5000,
        admittedPackageRuntime: original,
        managedServiceNodeRunner: "/service/original-node",
        assertPackageRuntimeCurrent: check,
      });
      if (boundary === "unchanged") {
        const result = await work;
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.activationRuntime).toBe(original);
          expect(result.value.replacedNodeRunner).toBe("/service/original-node");
        }
      } else {
        await expect(work).rejects.toThrow("original admission changed");
      }
    });
    expect(check).toHaveBeenCalledTimes(boundary === "before" ? 2 : 3);
    if (boundary === "before") {
      expect(prepare).not.toHaveBeenCalled();
    } else {
      expect(prepare).toHaveBeenCalledOnce();
    }
  },
);
