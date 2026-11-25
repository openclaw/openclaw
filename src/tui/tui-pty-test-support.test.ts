import type { IPty } from "@lydell/node-pty";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nodePtyMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));
const processTreeMocks = vi.hoisted(() => ({
  signalProcessTree: vi.fn((_pid: number, _signal: string, opts?: { onComplete?: () => void }) =>
    opts?.onComplete?.(),
  ),
}));

vi.mock("@lydell/node-pty", () => nodePtyMocks);
// mock-isolation: synthetic PTY process ids must never signal host processes.
vi.mock("../process/kill-tree.js", () => processTreeMocks);

import { startPty } from "./tui-pty-test-support.js";

function start(
  env: Record<string, string | undefined> = {},
  timeouts: { exitTimeoutMs?: number; outputTimeoutMs?: number } = {},
) {
  return startPty("node", [], {
    cwd: process.cwd(),
    env,
    exitTimeoutMs: 1_000,
    outputTimeoutMs: 1_000,
    ...timeouts,
  });
}

function mockPty() {
  const order: string[] = [];
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  const kill = vi.fn(() => order.push("term"));
  nodePtyMocks.spawn.mockReturnValue({
    pid: 4242,
    kill,
    write: vi.fn(),
    onData: (listener) => {
      onData = listener;
      return { dispose: () => order.push("data-dispose") };
    },
    onExit: (listener) => {
      onExit = listener;
      return { dispose: () => order.push("exit-dispose") };
    },
  } satisfies Pick<IPty, "pid" | "kill" | "write" | "onData" | "onExit">);
  processTreeMocks.signalProcessTree.mockImplementation((_pid, _signal, opts) => {
    order.push("force");
    opts?.onComplete?.();
  });
  return {
    order,
    kill,
    emit: (data: string) => onData?.(data),
    exit: (signal?: number) => {
      order.push("exit");
      onExit?.({ exitCode: 0, ...(signal === undefined ? {} : { signal }) });
    },
  };
}

describe("TUI PTY test support", () => {
  beforeEach(() => {
    nodePtyMocks.spawn.mockReset();
    processTreeMocks.signalProcessTree.mockClear();
    mockPty();
    vi.unstubAllEnvs();
  });

  it("removes explicitly cleared inherited environment variables", () => {
    vi.stubEnv("OPENCLAW_TUI_PTY_PARENT_ONLY", "parent");

    start({
      OPENCLAW_TUI_PTY_PARENT_ONLY: undefined,
      OPENCLAW_TUI_PTY_CHILD_ONLY: "child",
    });

    const spawnOptions = nodePtyMocks.spawn.mock.calls[0]?.[2];
    expect(spawnOptions?.env).not.toHaveProperty("OPENCLAW_TUI_PTY_PARENT_ONLY");
    expect(spawnOptions?.env).toMatchObject({
      OPENCLAW_TUI_PTY_CHILD_ONLY: "child",
      TERM: "xterm-256color",
    });
  });

  it.each([
    ["72", "20", 72, 20],
    ["0", "not-a-number", 100, 30],
  ] as const)("resolves terminal dimensions %s × %s", (colsEnv, rowsEnv, cols, rows) => {
    const run = start({
      OPENCLAW_TUI_PTY_COLS: colsEnv,
      OPENCLAW_TUI_PTY_ROWS: rowsEnv,
    });
    expect(nodePtyMocks.spawn.mock.calls[0]?.[2]).toMatchObject({ cols, rows });
    expect(run).toMatchObject({ cols, rows });
  });

  it.each([
    ["ANSI controls", ["\x1b[31ma \r\n\x1b[", "0mb"], undefined],
    ["CRLF", ["\x1b[31ma \r", "\n\x1b[0mb"], undefined],
    ["padding", ["\x1b[31ma ", "  \r\n", "\x1b[0mb"], undefined],
    ["hidden OSC text", ["\x1b]0;hidden marker\x07a b"], "hidden marker"],
  ] as const)("matches only visible text across %s", async (_label, chunks, hidden) => {
    const { emit } = mockPty();
    const run = start({}, hidden ? { outputTimeoutMs: 25 } : {});
    const output = run.waitForOutput("a b");
    for (const chunk of chunks) {
      emit(chunk);
    }

    await expect(output).resolves.toContain("a ");
    expect(run.visibleOutput()).toBe("a b");
    if (hidden) {
      expect(run.output()).toContain(hidden);
      await expect(run.waitForOutput(hidden)).rejects.toThrow(`timed out waiting for "${hidden}"`);
    }
  });

  it.each([
    ["graceful", ["term", "exit", "data-dispose", "exit-dispose"]],
    ["timeout", ["term", "force", "data-dispose", "exit-dispose"]],
    ["forced", ["force", "exit", "data-dispose", "exit-dispose"]],
  ] as const)("orders %s shutdown and subscription cleanup", async (mode, expected) => {
    const { order, kill, exit } = mockPty();
    const run = start({}, mode === "timeout" ? { exitTimeoutMs: 1 } : {});
    const method = mode === "forced" ? "forceKill" : "dispose";
    const pending = run[method]();
    if (mode !== "timeout") {
      expect(run[method]()).toBe(pending);
      expect(order).toEqual([mode === "forced" ? "force" : "term"]);
      exit(mode === "forced" ? 9 : undefined);
    }
    await pending;
    expect(order).toEqual(expected);
    if (mode === "forced") {
      expect(run.dispose()).toBe(pending);
    } else {
      expect(kill).toHaveBeenCalledWith("SIGTERM");
    }
    if (mode !== "graceful") {
      expect(processTreeMocks.signalProcessTree).toHaveBeenCalledExactlyOnceWith(4242, "SIGKILL", {
        onComplete: expect.any(Function),
      });
    }
  });
});
