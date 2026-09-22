import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as commands from "../process/exec.js";
import { withUpdateCandidateIoBudget } from "./update-candidate-io.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

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

it.each(["completion", "cancellation"])(
  "preserves uncertain probe cleanup after %s",
  async (outcome) => {
    const directory = tempDirs.make("openclaw-io-cleanup-");
    const probe = createDeferred<Awaited<ReturnType<typeof commands.runUtf8CommandWithTimeout>>>();
    const exit = createDeferred();
    const controller = new AbortController();
    vi.spyOn(commands, "runUtf8CommandWithTimeout").mockImplementation(() => probe.promise);
    const operation = withUpdateCandidateIoBudget(
      { directory, bytes: 4096, signal: controller.signal },
      () => exit.promise,
    );
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
