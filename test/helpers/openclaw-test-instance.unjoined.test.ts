import fs from "node:fs/promises";
import net from "node:net";
import { expect, it, vi } from "vitest";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import { createOpenClawTestInstance } from "./openclaw-test-instance.js";
import { runQaGatewayFixture } from "./qa-gateway-cleanup.js";

const mocks = vi.hoisted(() => ({
  runManagedCommand: vi.fn(),
  createChildAdapter: vi.fn(),
}));
vi.mock("../../src/process/supervisor/adapters/child.js", async (original) => ({
  ...(await original<typeof import("../../src/process/supervisor/adapters/child.js")>()),
  createChildAdapter: mocks.createChildAdapter,
}));
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

it.skipIf(process.platform === "win32")(
  "retains construction and extinction failures before releasing Gateway state",
  async () => {
    const startup = new Error("synthetic spawn failure");
    const cleanup = new Error("synthetic extinction failure");
    const listener = net.createServer((socket) => socket.destroy());
    mocks.createChildAdapter.mockImplementationOnce(
      async (
        params: Parameters<
          typeof import("../../src/process/supervisor/adapters/child.js").createChildAdapter
        >[0],
      ) => {
        await new Promise<void>((resolve, reject) => {
          listener.once("error", reject);
          listener.listen(instance.port, "127.0.0.1", () => {
            listener.off("error", reject);
            resolve();
          });
        });
        params.onSpawnCleanup?.(Promise.reject(cleanup));
        throw startup;
      },
    );
    const instance = await createOpenClawTestInstance({
      name: "unjoined-construction",
      entrypoint: ["unused-entrypoint.mjs"],
    });
    try {
      await expect(instance.startGateway()).rejects.toMatchObject({ errors: [startup, cleanup] });
      await expect(instance.cli(["fixture"])).rejects.toThrow("no longer accepts CLI commands");
      await expect(instance.startGateway()).rejects.toThrow("no longer accepts Gateway starts");
      await expect(instance.cleanup()).rejects.toBe(cleanup);
      await expect(fs.stat(instance.state.root)).resolves.toBeDefined();
      expect(mocks.createChildAdapter).toHaveBeenCalledOnce();
      expect(listener.listening).toBe(true);
      expect(listener.address()).toMatchObject({ address: "127.0.0.1", port: instance.port });
    } finally {
      // The injected construction never launches a process; retire its listener and isolated state.
      await runQaGatewayFixture(
        async () => {},
        () =>
          listener.listening
            ? new Promise<void>((resolve, reject) => {
                listener.close((error) => (error ? reject(error) : resolve()));
              })
            : undefined,
        () => instance.state.cleanup(),
        () => mocks.createChildAdapter.mockReset(),
      );
    }
  },
);
