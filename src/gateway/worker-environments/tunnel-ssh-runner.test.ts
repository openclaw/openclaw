// Worker SSH tunnel runner: readiness must settle even when the child stalls.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

import { createWorkerSshRunner, WORKER_TUNNEL_READY_MARKER } from "./tunnel-ssh-runner.js";

type MockChildProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

describe("createWorkerSshRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects ready when the marker never arrives before the timeout", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);
    const proc = createWorkerSshRunner().start(["ssh", "host"], {});
    const readyOutcome = proc.ready.then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(readyOutcome).resolves.toMatch(/ready marker not received/);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("resolves ready on the marker and does not fire the timeout later", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);
    const proc = createWorkerSshRunner().start(["ssh", "host"], {});
    let settled: string | undefined;
    void proc.ready.then(
      () => {
        settled = "resolved";
      },
      () => {
        settled = "rejected";
      },
    );

    child.stdout.emit("data", `banner\n${WORKER_TUNNEL_READY_MARKER}\n`);
    await vi.waitFor(() => expect(settled).toBe("resolved"));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe("resolved");
    expect(child.kill).not.toHaveBeenCalled();
  });
});
