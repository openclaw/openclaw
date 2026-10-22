import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const FAILED_EXIT = { code: 255, signal: null };

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { workerSshRunner, WORKER_TUNNEL_READY_MARKER } from "./tunnel-ssh-runner.js";

function createChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn((_signal?: NodeJS.Signals | number) => true),
  });
  child.once("exit", (code, signal) => {
    let closed = false;
    const close = () => {
      if (!closed && child.stdout.closed && child.stderr.closed) {
        closed = true;
        child.emit("close", code, signal);
      }
    };
    child.stdout.once("close", close);
    child.stderr.once("close", close);
    close();
  });
  return child;
}

let child: ReturnType<typeof createChild>;
beforeEach(() => {
  child = createChild();
  spawnMock.mockReset().mockReturnValue(child);
});

afterEach(() => vi.useRealTimers());

const start = (signal?: AbortSignal) =>
  workerSshRunner.start(["ssh"], { timeoutMs: 10_000, signal });
async function expectPending(process: ReturnType<typeof start>) {
  const settled = vi.fn();
  void process.exited.then(settled);
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
}

it.each([false, true])("settles despite delayed close (exit before stop: %s)", async (exited) => {
  vi.useFakeTimers();
  child.kill.mockReturnValue(!exited);
  const process = start();
  const exit = exited ? FAILED_EXIT : { code: null, signal: "SIGKILL" };
  if (exited) {
    child.emit("exit", exit.code, exit.signal);
  }
  const stopping = process.stop();
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  await vi.advanceTimersByTimeAsync(1_500);
  if (!exited) {
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("exit", exit.code, exit.signal);
  }
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(stopping).resolves.toBeUndefined();
  await expect(process.exited).resolves.toEqual(exit);
  await expect(process.ready).rejects.toThrow("Worker SSH tunnel failed");
});

it.each([false, true])("fences late readiness; redacts stderr (poll=%s)", async (poll) => {
  const process = start();
  const bearer = "secret-credential-value";
  const detail = "connection refused";

  child.emit("exit", 255, null);
  if (poll) {
    await setImmediate();
  }
  child.stdout.write(`${WORKER_TUNNEL_READY_MARKER}\n`);
  child.stderr.write(`Authorization: Bearer ${bearer}\n${detail}`);
  child.emit("close", 255, null);

  await expect(process.ready).rejects.toThrow(detail);
  const exit = await process.exited;
  expect(exit).toMatchObject({ ...FAILED_EXIT, stderrTail: expect.stringContaining(detail) });
  expect(exit.stderrTail).not.toContain(bearer);
});

it.each([
  [true, "did not exit after SIGKILL"],
  [false, "SIGKILL delivery failed"],
] as const)("rejects an unconfirmed stop (kill delivered: %s)", async (delivered, message) => {
  vi.useFakeTimers();
  child.kill.mockReturnValue(delivered);
  const process = start();
  const stopping = process.stop();
  const rejection = expect(stopping).rejects.toThrow(message);
  await vi.advanceTimersByTimeAsync(1_500);
  await vi.advanceTimersByTimeAsync(2_000);
  await rejection;

  if (!delivered) {
    await expectPending(process);
    child.emit("close", null, "SIGKILL");
    await expect(process.exited).resolves.toEqual({ code: null, signal: "SIGKILL" });
    await expect(process.stop()).resolves.toBeUndefined();
  }
});

it("keeps exited pending when a live child emits error without close", async () => {
  Object.assign(child, { pid: 4242 });
  const process = start();
  child.emit("error", new Error("kill delivery failed"));

  await expect(process.ready).rejects.toThrow("Worker SSH tunnel failed");
  await expectPending(process);

  child.emit("close", 0, null);
  await expect(process.exited).resolves.toEqual({ code: 0, signal: null });
});

it("bounds the stderr tail after a ready child exits", async () => {
  const process = start();
  child.stdout.write(`${WORKER_TUNNEL_READY_MARKER}\n`);
  await process.ready;
  child.stderr.write(`${"b".repeat(4_095)}😀`);
  child.emit("exit", 255, null);

  const exit = await process.exited;
  expect(exit).toMatchObject(FAILED_EXIT);
  expect(exit.stderrTail?.length).toBeLessThanOrEqual(4_096);
  expect(exit.stderrTail?.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
});

it("passes the owner signal to spawn so abort terminates and settles the child", async () => {
  spawnMock.mockImplementation((_command: string, _args: string[], options: SpawnOptions) => {
    options.signal?.addEventListener(
      "abort",
      () => {
        child.kill("SIGTERM");
        child.emit("error", Object.assign(new Error("aborted"), { name: "AbortError" }));
      },
      { once: true },
    );
    return child;
  });
  const controller = new AbortController();
  const process = start(controller.signal);

  controller.abort();

  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  await expect(process.ready).rejects.toThrow("Worker SSH tunnel failed");
  await expect(process.exited).resolves.toEqual({ code: null, signal: null });
  expect(spawnMock).toHaveBeenCalledWith(
    "ssh",
    [],
    expect.objectContaining({ signal: controller.signal }),
  );
});
