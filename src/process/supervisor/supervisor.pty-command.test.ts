// PTY command supervisor tests cover supervised terminal command lifecycles.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createPtyAdapterMock } = vi.hoisted(() => ({
  createPtyAdapterMock: vi.fn(),
}));

function firstPtyAdapterParams(): { args?: string[] } {
  const [call] = createPtyAdapterMock.mock.calls;
  if (!call) {
    throw new Error("expected createPtyAdapter call");
  }
  const [params] = call;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("expected createPtyAdapter params to be an object");
  }
  return params;
}

function createStubPtyAdapter() {
  return {
    pid: 1234,
    stdin: undefined,
    onStdout: (_listener: (chunk: string) => void) => {
      // no-op
    },
    onStderr: (_listener: (chunk: string) => void) => {
      // no-op
    },
    wait: async () => ({ code: 0, signal: null }),
    kill: (_signal?: NodeJS.Signals) => {
      // no-op
    },
    forceKillAndWait: async () => true,
    probeProcessTreeAlive: async () => false,
    dispose: () => {
      // no-op
    },
  };
}

describe("process supervisor PTY command contract", () => {
  let createProcessSupervisor: typeof import("./supervisor.js").createProcessSupervisor;

  beforeEach(async () => {
    vi.resetModules();
    createPtyAdapterMock.mockReset();
    createPtyAdapterMock.mockResolvedValue(createStubPtyAdapter());
    vi.doMock("../../agents/shell-utils.js", () => ({
      getShellConfig: () => ({ shell: "sh", args: ["-c"] }),
    }));
    vi.doMock("./adapters/pty.js", () => ({
      createPtyAdapter: (...args: unknown[]) => createPtyAdapterMock(...args),
    }));
    ({ createProcessSupervisor } = await import("./supervisor.js"));
  });

  afterEach(() => {
    vi.doUnmock("../../agents/shell-utils.js");
    vi.doUnmock("./adapters/pty.js");
  });

  it("passes PTY command verbatim to shell args", async () => {
    const supervisor = createProcessSupervisor();
    const command = `printf '%s\\n' "a b" && printf '%s\\n' '$HOME'`;

    const run = await supervisor.spawn({
      sessionId: "s1",
      backendId: "test",
      mode: "pty",
      ptyCommand: command,
      timeoutMs: 1_000,
    });
    const exit = await run.wait();

    expect(exit.reason).toBe("exit");
    expect(createPtyAdapterMock).toHaveBeenCalledTimes(1);
    const params = firstPtyAdapterParams();
    expect(params.args).toEqual(["-c", command]);
  });

  it("rejects empty PTY command", async () => {
    const supervisor = createProcessSupervisor();

    await expect(
      supervisor.spawn({
        sessionId: "s1",
        backendId: "test",
        mode: "pty",
        ptyCommand: "   ",
      }),
    ).rejects.toThrow("PTY command cannot be empty");
    expect(createPtyAdapterMock).not.toHaveBeenCalled();
  });
});
