// PTY command supervisor tests cover supervised terminal command lifecycles.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createStubChildAdapter } from "./supervisor.test-support.js";

const { createPtyAdapterMock } = vi.hoisted(() => ({
  createPtyAdapterMock: vi.fn(),
}));

vi.mock("./adapters/pty.js", () => ({
  createPtyAdapter: (...args: unknown[]) => createPtyAdapterMock(...args),
}));

describe("process supervisor PTY command contract", () => {
  let createProcessSupervisor: typeof import("./supervisor.js").createProcessSupervisor;

  beforeAll(async () => {
    ({ createProcessSupervisor } = await import("./supervisor.js"));
  });

  beforeEach(() => {
    createPtyAdapterMock.mockClear();
  });

  it("launches the supplied executable and argv verbatim without rediscovering a shell", async () => {
    const adapter = Object.assign(createStubChildAdapter(), { supportsRawOutput: false });
    adapter.settle(0);
    createPtyAdapterMock.mockResolvedValue(adapter);
    const supervisor = createProcessSupervisor();
    const command = `printf '%s\\n' "a b" && printf '%s\\n' '$HOME'`;

    const run = await supervisor.spawn({
      mode: "pty",
      argv: ["/trusted/launcher", "--literal", command],
      timeoutMs: 1_000,
    });
    const exit = await run.wait();

    expect(exit.reason).toBe("exit");
    expect(createPtyAdapterMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ shell: "/trusted/launcher", args: ["--literal", command] }),
    );
  });

  it("rejects empty PTY argv", async () => {
    const supervisor = createProcessSupervisor();

    await expect(
      supervisor.spawn({
        mode: "pty",
        argv: [],
      }),
    ).rejects.toThrow("spawn argv cannot be empty");
    expect(createPtyAdapterMock).not.toHaveBeenCalled();
  });
});
