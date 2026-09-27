import { expect, it, vi } from "vitest";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import { createOpenClawTestInstance } from "./openclaw-test-instance.js";

const mocks = vi.hoisted(() => ({ runManagedCommand: vi.fn() }));
vi.mock("../../scripts/lib/managed-child-process.mts", async (original) => ({
  ...(await original<typeof import("../../scripts/lib/managed-child-process.mts")>()),
  runManagedCommand: mocks.runManagedCommand,
}));

it("retains an unjoined CLI failure and closed admission after external completion", async () => {
  const cause = Object.assign(new Error("command tree remains unresolved"), {
    processTreeState: "indeterminate",
  });
  mocks.runManagedCommand.mockRejectedValue(cause);
  const instance = await createOpenClawTestInstance({
    name: "unjoined-command",
    entrypoint: ["unused-entrypoint.mjs"],
  });
  try {
    const error: unknown = await instance.cli(["fixture"]).catch((failure: unknown) => failure);
    expect(hasUnjoinedWork(error)).toBe(true);
    await expect(instance.cli(["fixture"])).rejects.toThrow("no longer accepts CLI commands");
    await expect(instance.startGateway()).rejects.toThrow("no longer accepts Gateway starts");
    const cleanup = instance.cleanup();
    expect(instance.cleanup()).toBe(cleanup);
    await expect(cleanup).rejects.toBe(error);
    mocks.runManagedCommand.mockResolvedValue(0);
    await expect(instance.cleanup()).rejects.toBe(error);
    expect(mocks.runManagedCommand).toHaveBeenCalledOnce();
  } finally {
    // The injected owner never spawned a process; only the test's isolated filesystem exists.
    await instance.state.cleanup();
    mocks.runManagedCommand.mockReset();
  }
});
