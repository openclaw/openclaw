import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as commands from "../process/exec.js";
import { withUpdateCandidateIoBudget } from "./update-candidate-io.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const probeResult: Awaited<ReturnType<typeof commands.runUtf8CommandWithTimeout>> = {
  code: 0,
  signal: null,
  killed: false,
  termination: "exit",
  cleanup: "normal",
  noOutputTimedOut: false,
  stdout: JSON.stringify({ facts: "0".repeat(64), bytes: 0 }),
  stderr: "",
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("uses completed I/O while it advances and probes again when it stops", async () => {
  vi.useFakeTimers();
  const directory = tempDirs.make("openclaw-io-reported-");
  const exit = createDeferred();
  const probe = vi.spyOn(commands, "runUtf8CommandWithTimeout").mockResolvedValue(probeResult);
  let completed = () => {};
  const operation = withUpdateCandidateIoBudget(
    { directory, bytes: 4096, progress: "reported" },
    (_signal, reportProgress) => {
      completed = reportProgress;
      return exit.promise;
    },
  );
  try {
    for (let index = 0; index < 3; index++) {
      completed();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe).toHaveBeenCalledTimes(1);
  } finally {
    exit.resolve();
    await operation;
  }
});

it.each([false, true])("completed I/O respects deadline expiry (late=%s)", async (late) => {
  vi.useFakeTimers();
  const directory = tempDirs.make("openclaw-io-renewal-");
  const exit = createDeferred();
  const probe = createDeferred<Awaited<ReturnType<typeof commands.runUtf8CommandWithTimeout>>>();
  const now = Date.now.bind(Date);
  let elapsed = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
  vi.spyOn(commands, "runUtf8CommandWithTimeout").mockImplementation(() => probe.promise);
  let completed = () => {};
  const operation = withUpdateCandidateIoBudget(
    { directory, bytes: 32 * 1024 ** 2, progress: "reported" },
    (_signal, reportProgress) => {
      completed = reportProgress;
      return exit.promise;
    },
  );
  const outcome = late
    ? expect(operation).rejects.toThrow("made no progress for 340 seconds")
    : expect(operation).resolves.toBeUndefined();
  elapsed = late ? 340_000 : 339_000;
  try {
    if (late) {
      expect(completed).toThrow("made no progress for 340 seconds");
    } else {
      completed();
      // Wake the original timer after progress extended its absolute deadline.
      elapsed = 0;
      await vi.advanceTimersByTimeAsync(340_000);
    }
  } finally {
    elapsed = late ? 340_000 : 0;
    exit.resolve();
    probe.resolve(probeResult);
    await outcome;
  }
});

it("checks the completion deadline before its timer callback runs", async () => {
  const directory = tempDirs.make("openclaw-io-completion-");
  const exit = createDeferred();
  const now = Date.now.bind(Date);
  let elapsed = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
  const operation = withUpdateCandidateIoBudget(
    { directory, bytes: 32 * 1024 ** 2 },
    () => exit.promise,
  );
  const rejected = expect(operation).rejects.toThrow("made no progress for 340 seconds");
  elapsed = 340_000;
  exit.resolve();
  await rejected;
});

it.each([
  { outcome: "completion", progress: undefined },
  { outcome: "cancellation", progress: undefined },
  { outcome: "completion", progress: "reported" as const },
  { outcome: "cancellation", progress: "reported" as const },
])(
  "preserves uncertain probe cleanup after $outcome (progress=$progress)",
  async ({ outcome, progress }) => {
    vi.useFakeTimers();
    const directory = tempDirs.make("openclaw-io-cleanup-");
    const probe = createDeferred<Awaited<ReturnType<typeof commands.runUtf8CommandWithTimeout>>>();
    const exit = createDeferred();
    const controller = new AbortController();
    let completed = () => {};
    vi.spyOn(commands, "runUtf8CommandWithTimeout").mockImplementation(() => probe.promise);
    const operation = withUpdateCandidateIoBudget(
      { directory, bytes: 4096, signal: controller.signal, progress },
      (_signal, reportProgress) => {
        completed = reportProgress;
        return exit.promise;
      },
    );
    if (progress) {
      await vi.advanceTimersByTimeAsync(1_000);
      completed();
    }
    const rejected = expect(operation).rejects.toMatchObject({ cleanup: "uncertain" });
    if (outcome === "cancellation") {
      controller.abort(new Error("cancel inspection"));
    }
    exit.resolve();
    probe.resolve({
      code: null,
      signal: "SIGKILL",
      killed: true,
      termination: "signal",
      cleanup: "uncertain",
      noOutputTimedOut: false,
      stdout: "",
      stderr: "",
    });
    await rejected;
  },
);
