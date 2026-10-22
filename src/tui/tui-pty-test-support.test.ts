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

function createMockPty(overrides: Partial<IPty> = {}): IPty {
  return {
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    ...overrides,
  } as IPty;
}

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

function captureOutput() {
  let onData: ((data: string) => void) | undefined;
  nodePtyMocks.spawn.mockReturnValue(
    createMockPty({
      onData: vi.fn((listener: (data: string) => void) => {
        onData = listener;
        return { dispose: vi.fn() };
      }),
    }),
  );
  return (data: string) => onData?.(data);
}

function lifecycle(term = "term", force = "force") {
  const order: string[] = [];
  let onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  const kill = vi.fn(() => order.push(term));
  nodePtyMocks.spawn.mockReturnValue(
    createMockPty({
      pid: 4242,
      kill,
      onData: vi.fn(() => ({ dispose: () => order.push("data-dispose") })),
      onExit: vi.fn((listener: typeof onExit) => {
        onExit = listener;
        return { dispose: () => order.push("exit-dispose") };
      }),
    }),
  );
  processTreeMocks.signalProcessTree.mockImplementation((_pid, _signal, opts) => {
    order.push(force);
    opts?.onComplete?.();
  });
  return {
    order,
    kill,
    exit: (signal?: number) => {
      order.push("exit");
      onExit?.({ exitCode: 0, ...(signal === undefined ? {} : { signal }) });
    },
  };
}

describe("TUI PTY test support", () => {
  beforeEach(() => {
    nodePtyMocks.spawn.mockReset().mockReturnValue(createMockPty());
    processTreeMocks.signalProcessTree.mockClear();
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
    expect(nodePtyMocks.spawn).toHaveBeenCalledWith(
      "node",
      [],
      expect.objectContaining({ cols, rows }),
    );
    expect(run).toMatchObject({ cols, rows });
  });

  it.each([
    { chunkSize: "1", chunks: ["A", "👋", "B"] },
    { chunkSize: "2", chunks: ["A👋", "B"] },
  ])(
    "preserves Unicode characters with fixture-specific $chunkSize-character input chunks",
    async ({ chunkSize, chunks }) => {
      const write = vi.fn();
      nodePtyMocks.spawn.mockReturnValue(createMockPty({ write }));

      const run = start({
        OPENCLAW_TUI_PTY_TYPE_CHUNK_SIZE: chunkSize,
        OPENCLAW_TUI_PTY_TYPE_DELAY_MS: "1",
      });

      await run.write("A👋B");

      expect(write).toHaveBeenCalledTimes(chunks.length);
      expect(write.mock.calls.map(([chunk]) => chunk)).toEqual(chunks);
    },
  );

  it.each([
    {
      label: "split ANSI control sequences",
      chunks: ["\u001b[38;2;155;163;178minto live     \r\n\u001b[", "0mworkspace"],
    },
    {
      label: "split wrapped CRLF sequences",
      chunks: ["\u001b[38;2;155;163;178minto live     \r", "\n\u001b[0mworkspace"],
    },
    {
      label: "split wrapped terminal padding",
      chunks: ["\u001b[38;2;155;163;178minto live   ", "  \r\n", "\u001b[0mworkspace"],
    },
  ])("matches visible text across $label", async ({ chunks }) => {
    const onData = captureOutput();
    const run = start({});

    const output = run.waitForOutput("into live workspace");
    for (const chunk of chunks) {
      onData(chunk);
    }

    await expect(output).resolves.toContain("into live");
    expect(run.visibleOutput()).toBe("into live workspace");
  });

  it("does not match text hidden inside terminal control sequences", async () => {
    const onData = captureOutput();
    const run = start({}, { outputTimeoutMs: 25 });

    onData("\u001b]0;hidden session marker\u0007visible session");

    await expect(run.waitForOutput("visible session")).resolves.toContain("visible session");
    expect(run.visibleOutput()).toBe("visible session");
    expect(run.output()).toContain("hidden session marker");
    await expect(run.waitForOutput("hidden session marker")).rejects.toThrow(
      'timed out waiting for "hidden session marker"',
    );
  });

  it("waits for PTY exit before completing idempotent disposal", async () => {
    const { order, kill, exit } = lifecycle("kill");
    const run = start({});

    const disposal = run.dispose();
    expect(run.dispose()).toBe(disposal);
    expect(order).toEqual(["kill"]);

    exit();
    await disposal;

    expect(order).toEqual(["kill", "exit", "data-dispose", "exit-dispose"]);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("force-kills the owned process tree when graceful disposal times out", async () => {
    const { order, kill } = lifecycle();
    const run = start({}, { exitTimeoutMs: 1 });

    await run.dispose();

    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(processTreeMocks.signalProcessTree).toHaveBeenCalledWith(4242, "SIGKILL", {
      onComplete: expect.any(Function),
    });
    expect(order).toEqual(["term", "force", "data-dispose", "exit-dispose"]);
  });

  it("force-kills the PTY and waits for its exit event", async () => {
    const { order, exit } = lifecycle("term", "kill");
    const run = start({});

    const forcedExit = run.forceKill();
    expect(run.forceKill()).toBe(forcedExit);
    expect(order).toEqual(["kill"]);
    expect(processTreeMocks.signalProcessTree).toHaveBeenCalledWith(4242, "SIGKILL", {
      onComplete: expect.any(Function),
    });

    exit(9);
    await forcedExit;
    expect(run.dispose()).toBe(forcedExit);

    expect(order).toEqual(["kill", "exit", "data-dispose", "exit-dispose"]);
    expect(processTreeMocks.signalProcessTree).toHaveBeenCalledTimes(1);
  });
});
