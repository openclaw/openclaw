import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetPiRpc, runPiRpc } from "./tau-rpc.js";

vi.mock("node:child_process", () => {
  const spawn = vi.fn();
  return { spawn };
});

type MockChild = EventEmitter & {
  stdin: EventEmitter & {
    write: (chunk: string, cb?: (err?: Error | null) => void) => boolean;
    once: (event: "drain", listener: () => void) => unknown;
  };
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill: (signal?: NodeJS.Signals) => boolean;
};

function makeChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  const stdin = new EventEmitter() as MockChild["stdin"];
  stdin.write = (_chunk: string, cb?: (err?: Error | null) => void) => {
    cb?.(null);
    return true;
  };
  child.stdin = stdin;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

describe("tau-rpc", () => {
  afterEach(() => {
    resetPiRpc();
    vi.resetAllMocks();
  });

  it("sends prompt with string message", async () => {
    const { spawn } = await import("node:child_process");
    const child = makeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const writes: string[] = [];
    child.stdin.write = (chunk: string, cb?: (err?: Error | null) => void) => {
      writes.push(String(chunk));
      cb?.(null);
      return true;
    };

    const run = runPiRpc({
      argv: ["tau", "--mode", "rpc"],
      cwd: "/tmp",
      timeoutMs: 500,
      prompt: "hello",
    });

    // Allow the async `prompt()` to install the pending resolver before exiting.
    await Promise.resolve();

    expect(writes.length).toBeGreaterThan(0);
    child.emit("exit", 0, null);
    const res = await run;

    expect(res.code).toBe(0);
    expect(writes.length).toBeGreaterThan(0);
    const first = writes[0]?.trim();
    expect(first?.endsWith("\n")).toBe(false);
    const obj = JSON.parse(first ?? "{}") as { type?: string; message?: unknown };
    expect(obj.type).toBe("prompt");
    expect(obj.message).toBe("hello");
  });
});
