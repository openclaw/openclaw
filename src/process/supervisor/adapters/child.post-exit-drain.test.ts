// Post-exit drain settlement for detached grandchildren (#147304): the run
// settles once output goes idle after the root exits, and the settlement
// leaves the streams open for delayed writers. Split from child.test.ts to
// keep both files under the max-lines lint budget.
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStubChild } from "./child.test-support.js";

const { spawnWithFallbackMock, signalProcessTreeMock } = vi.hoisted(() => ({
  spawnWithFallbackMock: vi.fn(),
  // The synthetic PID must never reach the host's process groups; the mock
  // mirrors the real completion-callback contract instead.
  signalProcessTreeMock: vi.fn(
    (_pid: number, _signal: string, opts?: { onComplete?: () => void }) => {
      opts?.onComplete?.();
    },
  ),
}));

vi.mock("../../spawn-utils.js", () => ({
  spawnWithFallback: spawnWithFallbackMock,
}));

vi.mock("../../kill-tree.js", () => ({
  signalProcessTree: signalProcessTreeMock,
}));

let createChildAdapter: typeof import("./child.js").createChildAdapter;

const FORCE_KILL_WAIT_FALLBACK_MS = 4000;

describe("post-exit drain settlement for detached grandchildren", () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const setPlatform = (platform: NodeJS.Platform) => {
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
  };
  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  // Self-contained initialization: this suite must pass even when only these
  // tests are run (e.g. `vitest run -t "post-exit drain"`), without relying on
  // the sibling suite's beforeEach. (#147304 review follow-up)
  beforeEach(async () => {
    vi.resetModules();
    ({ createChildAdapter } = await import("./child.js"));
    spawnWithFallbackMock.mockClear();
  });

  it("caps the drain when detached grandchildren hold stdio after the root exits", async () => {
    vi.useFakeTimers();
    setPlatform("linux");
    const { child, emitExit } = createStubChild();
    spawnWithFallbackMock.mockResolvedValue({ child, usedFallback: false });
    const adapter = await createChildAdapter({
      argv: ["bash", "-c", "nohup sleep 600 | cat &"],
    });
    const settled = vi.fn();
    const wait = adapter.wait();
    void wait.then(settled);

    // Root exits while a detached grandchild keeps stdout open (no end/close).
    emitExit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();

    // The bounded post-exit drain cap settles instead of waiting forever.
    await vi.advanceTimersByTimeAsync(250);
    expect(settled).toHaveBeenCalledWith({ code: 0, signal: null });
  });

  it("keeps the idle cap from settling once a termination was requested", async () => {
    vi.useFakeTimers();
    setPlatform("linux");
    const { child, emitExit } = createStubChild();
    spawnWithFallbackMock.mockResolvedValue({ child, usedFallback: false });
    const adapter = await createChildAdapter({
      argv: ["bash", "-c", "nohup sleep 600 | cat &"],
    });
    const settled = vi.fn();
    void adapter.wait().then(settled);

    // A cancellation reaches the adapter before the root exits; the detached
    // grandchild still holds stdout. The supervisor's escalation owns cleanup,
    // so the idle cap must not settle it early.
    adapter.kill("SIGTERM");
    emitExit(null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).not.toHaveBeenCalled();
    expect(signalProcessTreeMock).toHaveBeenCalledWith(1234, "SIGTERM", expect.anything());

    // The supervisor escalates to a hard kill; that path arms its own
    // fallback and settles the wait on its schedule, not the idle cap's.
    adapter.kill("SIGKILL");
    await vi.advanceTimersByTimeAsync(FORCE_KILL_WAIT_FALLBACK_MS);
    expect(settled).toHaveBeenCalled();
  });

  it("disarms an already-armed idle cap when a termination arrives", async () => {
    vi.useFakeTimers();
    setPlatform("linux");
    const { child, emitExit } = createStubChild();
    spawnWithFallbackMock.mockResolvedValue({ child, usedFallback: false });
    const adapter = await createChildAdapter({
      argv: ["bash", "-c", "nohup sleep 600 | cat &"],
    });
    const settled = vi.fn();
    void adapter.wait().then(settled);

    // The root exits first and the cap arms; the cancellation arrives inside
    // the idle window and must disarm it.
    emitExit(0);
    await vi.advanceTimersByTimeAsync(0);
    adapter.kill("SIGTERM");
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).not.toHaveBeenCalled();
  });

  it("keeps draining while output continues after the root exits", async () => {
    vi.useFakeTimers();
    setPlatform("linux");
    const { child, emitExit } = createStubChild();
    spawnWithFallbackMock.mockResolvedValue({ child, usedFallback: false });
    const adapter = await createChildAdapter({
      argv: ["bash", "-c", "nohup sleep 600 | cat &"],
    });
    const settled = vi.fn();
    void adapter.wait().then(settled);
    // Capture subscribers define an active drain: output activity is tracked
    // through the capture path.
    adapter.onStdout?.(() => {});
    adapter.onStderr?.(() => {});

    emitExit(0);
    // While a detached descendant is still producing output, the drain cap
    // must reschedule instead of destroying its pipe.
    for (let i = 0; i < 3; i += 1) {
      child.stdout?.push(`chunk ${i}\n`);
      await vi.advanceTimersByTimeAsync(200);
      expect(settled).not.toHaveBeenCalled();
    }

    // Once output goes idle, the cap settles with the observed exit state.
    (child.stdout as PassThrough).end();
    await vi.advanceTimersByTimeAsync(250);
    expect(settled).toHaveBeenCalledWith({ code: 0, signal: null });
  });

  it("delivers output that arrived before capture subscribers attached", async () => {
    vi.useFakeTimers();
    setPlatform("linux");
    const { child, emitExit } = createStubChild();
    spawnWithFallbackMock.mockResolvedValue({ child, usedFallback: false });
    const adapter = await createChildAdapter({
      argv: ["bash", "-c", "nohup sleep 600 | cat &"],
    });

    // Output arrives while no capture subscriber exists yet: paused-mode
    // buffering must retain it until subscribers attach, not consume it.
    child.stdout?.push(`early stdout\n`);
    child.stderr?.push(`early stderr\n`);

    const seen = { stdout: [] as string[], stderr: [] as string[] };
    adapter.onStdout?.((text) => {
      seen.stdout.push(text);
    });
    adapter.onStderr?.((text) => {
      seen.stderr.push(text);
    });
    // Buffered pre-subscriber output flushes on the tick after capture starts.
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.stdout.join("")).toContain("early stdout");
    expect(seen.stderr.join("")).toContain("early stderr");

    emitExit(0);
    await vi.advanceTimersByTimeAsync(250);
  });
});
