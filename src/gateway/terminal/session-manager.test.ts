import { describe, expect, it, vi } from "vitest";
import type { TerminalPtyHandle } from "./pty.js";
import {
  TERMINAL_EVENT_DATA,
  TERMINAL_EVENT_EXIT,
  TerminalSessionManager,
  type TerminalOpenRequest,
} from "./session-manager.js";

/** A controllable fake PTY that records writes and lets tests drive data/exit. */
function makeFakePty() {
  let dataListener: ((chunk: string) => void) | undefined;
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  const handle: TerminalPtyHandle & {
    writes: string[];
    resizes: Array<[number, number]>;
    killed: boolean;
    emitData: (chunk: string) => void;
    emitExit: (code: number, signal?: number) => void;
  } = {
    pid: 4242,
    writes: [],
    resizes: [],
    killed: false,
    write: (data) => handle.writes.push(data),
    resize: (cols, rows) => handle.resizes.push([cols, rows]),
    onData: (listener) => {
      dataListener = listener;
    },
    onExit: (listener) => {
      exitListener = listener;
    },
    kill: () => {
      handle.killed = true;
    },
    emitData: (chunk) => dataListener?.(chunk),
    emitExit: (code, signal) => exitListener?.({ exitCode: code, signal }),
  };
  return handle;
}

function baseRequest(overrides?: Partial<TerminalOpenRequest>): TerminalOpenRequest {
  return {
    connId: "conn-1",
    agentId: "main",
    cwd: "/work",
    shell: "/bin/zsh",
    args: ["-l"],
    cols: 80,
    rows: 24,
    env: { TERM: "xterm-256color" },
    ...overrides,
  };
}

describe("TerminalSessionManager", () => {
  it("opens a session and streams output only to the owning connection", async () => {
    const emit = vi.fn();
    const fake = makeFakePty();
    const manager = new TerminalSessionManager({ emit, spawn: async () => fake });

    const outcome = await manager.open(baseRequest());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(manager.size).toBe(1);

    fake.emitData("hello");
    fake.emitData("world");
    expect(emit).toHaveBeenNthCalledWith(1, "conn-1", TERMINAL_EVENT_DATA, {
      sessionId: outcome.sessionId,
      seq: 0,
      data: "hello",
    });
    expect(emit).toHaveBeenNthCalledWith(2, "conn-1", TERMINAL_EVENT_DATA, {
      sessionId: outcome.sessionId,
      seq: 1,
      data: "world",
    });
  });

  it("routes input and resize to the pty for the owning connection", async () => {
    const fake = makeFakePty();
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => fake });
    const outcome = await manager.open(baseRequest());
    if (!outcome.ok) {
      throw new Error("expected open");
    }

    expect(manager.write("conn-1", outcome.sessionId, "ls\n")).toBe(true);
    expect(fake.writes).toEqual(["ls\n"]);
    expect(manager.resize("conn-1", outcome.sessionId, 120, 40)).toBe(true);
    expect(fake.resizes).toEqual([[120, 40]]);
  });

  it("refuses input from a different connection", async () => {
    const fake = makeFakePty();
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => fake });
    const outcome = await manager.open(baseRequest());
    if (!outcome.ok) {
      throw new Error("expected open");
    }
    expect(manager.write("conn-2", outcome.sessionId, "rm -rf /\n")).toBe(false);
    expect(fake.writes).toEqual([]);
  });

  it("emits an exit event and drops the session when the process exits", async () => {
    const emit = vi.fn();
    const fake = makeFakePty();
    const manager = new TerminalSessionManager({ emit, spawn: async () => fake });
    const outcome = await manager.open(baseRequest());
    if (!outcome.ok) {
      throw new Error("expected open");
    }

    fake.emitExit(0);
    expect(manager.size).toBe(0);
    expect(emit).toHaveBeenCalledWith("conn-1", TERMINAL_EVENT_EXIT, {
      sessionId: outcome.sessionId,
      exitCode: 0,
      signal: null,
      reason: "process_exit",
    });
    expect(fake.killed).toBe(true);
  });

  it("kills every session a disconnected connection owned without emitting", async () => {
    const emit = vi.fn();
    const ptys = [makeFakePty(), makeFakePty()];
    let idx = 0;
    const manager = new TerminalSessionManager({ emit, spawn: async () => ptys[idx++] });
    await manager.open(baseRequest());
    await manager.open(baseRequest());
    expect(manager.size).toBe(2);
    emit.mockClear();

    manager.closeForConn("conn-1");
    expect(manager.size).toBe(0);
    expect(ptys[0].killed).toBe(true);
    expect(ptys[1].killed).toBe(true);
    // Silent teardown: the socket is already gone.
    expect(emit).not.toHaveBeenCalled();
  });

  it("disposes every session silently (gateway shutdown)", async () => {
    const emit = vi.fn();
    const ptys = [makeFakePty(), makeFakePty()];
    let idx = 0;
    const manager = new TerminalSessionManager({ emit, spawn: async () => ptys[idx++] });
    await manager.open(baseRequest());
    await manager.open(baseRequest({ connId: "conn-2" }));
    emit.mockClear();

    manager.disposeAll();
    expect(manager.size).toBe(0);
    expect(ptys[0].killed).toBe(true);
    expect(ptys[1].killed).toBe(true);
    // Shutdown drops the sockets, so notifying clients is pointless.
    expect(emit).not.toHaveBeenCalled();
  });

  it("enforces the session limit", async () => {
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => makeFakePty(),
      maxSessions: 1,
    });
    const first = await manager.open(baseRequest());
    expect(first.ok).toBe(true);
    const second = await manager.open(baseRequest());
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("limit");
    }
  });

  it("kills a pending open whose connection disconnects during spawn", async () => {
    const emit = vi.fn();
    const fake = makeFakePty();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new TerminalSessionManager({
      emit,
      spawn: async () => {
        await gate;
        return fake;
      },
    });
    const openPromise = manager.open(baseRequest({ connId: "conn-x" }));
    // Connection drops while the shell is still spawning.
    manager.closeForConn("conn-x");
    release?.();
    const outcome = await openPromise;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("closed");
    }
    // The freshly spawned PTY is killed, not registered as an orphan.
    expect(fake.killed).toBe(true);
    expect(manager.size).toBe(0);
  });

  it("enforces the cap against concurrent opens racing on the async spawn", async () => {
    // Spawn resolves on a later tick so both opens await it before either registers.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => {
        await gate;
        return makeFakePty();
      },
      maxSessions: 1,
    });
    const both = Promise.all([manager.open(baseRequest()), manager.open(baseRequest())]);
    release?.();
    const [a, b] = await both;
    // Exactly one succeeds; the reserved slot blocks the concurrent open.
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(manager.size).toBe(1);
  });

  it("reports a spawn failure instead of throwing", async () => {
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => {
        throw new Error("node-pty missing");
      },
    });
    const outcome = await manager.open(baseRequest());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("spawn_failed");
      expect(outcome.message).toContain("node-pty missing");
    }
  });
});
