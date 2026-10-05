import { afterEach, expect, it, vi } from "vitest";
import type { UpgradeRecipeMaintenanceReceipt } from "../infra/upgrade-recipes/maintenance-contract.js";

const startup = vi.hoisted(() => ({
  read: vi.fn<() => Promise<UpgradeRecipeMaintenanceReceipt | null>>(),
  bootstrap: vi.fn(),
}));
vi.mock("../infra/upgrade-recipes/maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/upgrade-recipes/maintenance.js")>()),
  readUpgradeRecipeMaintenanceReceipt: startup.read,
}));
vi.mock("./server-startup-bootstrap.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-startup-bootstrap.js")>()),
  prepareGatewayServerBootstrap: startup.bootstrap,
}));
afterEach(() => vi.clearAllMocks());

it.each(["maintenance-required", "commit-intent"] as const)(
  "refuses %s before ordinary bootstrap, plugins, and scheduled work",
  async (phase) => {
    startup.read.mockResolvedValue({
      binding: {
        protocol: 1,
        runId: "run",
        planDigest: "a".repeat(64),
        targetArtifactId: "target",
        installationKey: "/install",
        stateRootKey: "/state",
      },
      phase,
      revision: 1,
      updatedAtMs: 1,
    });
    const { createGatewayKernel } = await import("./server-kernel.js");
    await expect(createGatewayKernel()).rejects.toThrow("unresolved upgrade maintenance owner");
    expect(startup.bootstrap).not.toHaveBeenCalled();
  },
);

it("receipt inspection failure is not treated as absence", async () => {
  startup.read.mockRejectedValue(new Error("corrupt receipt"));
  const { createGatewayKernel } = await import("./server-kernel.js");
  await expect(createGatewayKernel()).rejects.toThrow("corrupt receipt");
  expect(startup.bootstrap).not.toHaveBeenCalled();
});
