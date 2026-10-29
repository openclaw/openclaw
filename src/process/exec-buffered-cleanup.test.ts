import { beforeEach, expect, it, vi } from "vitest";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
  recordCommandProcessFailure,
} from "./exec-result.js";
import { runCommandBuffered } from "./exec.js";

const runner = vi.hoisted(() => vi.fn());
vi.mock("./exec-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./exec-runner.js")>()),
  runCommandWithTimeout: runner,
  runUtf8CommandWithTimeout: vi.fn(),
}));
vi.mock("./exec-spawn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./exec-spawn.js")>()),
  COMMAND_PROCESS_TREE_KILL_GRACE_MS: 100,
  resolveCommandProcessSignal: vi.fn(),
  retainCommandProcessCleanup: vi.fn(),
  spawnCommand: vi.fn(),
  waitForCommandSpawn: vi.fn(),
  resolveCommandEnv: vi.fn(),
  shouldSpawnWithShell: vi.fn(),
}));
beforeEach(() => {
  runner.mockReset();
});

it.each(["uncertain", "normal"] as const)(
  "retains output and exit details with %s cleanup",
  async (cleanup) => {
    runner.mockImplementation(async (_argv, options) => {
      options.onOutputChunk(Buffer.from("out"), "stdout");
      options.onOutputChunk(Buffer.from("err"), "stderr");
      return { code: 7, signal: null, killed: false, termination: "exit", cleanup };
    });
    const result = await runCommandBuffered(["fixture"]);
    expect(result).toMatchObject({ code: 7, signal: null, killed: false, termination: "exit" });
    expect([result.stdout, result.stderr]).toEqual([Buffer.from("out"), Buffer.from("err")]);
    expect(hasCommandProcessCleanupError(result.error)).toBe(cleanup === "uncertain");
    if (cleanup === "normal") {
      expect(result.error).toBeUndefined();
    }
  },
);

it.each(["uncertain", "normal"] as const)(
  "retains startup failure identity or cause with %s cleanup",
  async (cleanup) => {
    const failure = recordCommandProcessFailure(new Error("startup failed"), {
      code: null,
      cleanup,
      termination: "exit",
    });
    runner.mockRejectedValue(failure);
    const result = await runCommandBuffered(["fixture"]);
    expect(result.termination).toBe("error");
    expect(hasCommandProcessCleanupError(result.error)).toBe(cleanup === "uncertain");
    if (cleanup === "uncertain") {
      expect(result.error?.cause).toBe(failure);
    } else {
      expect(result.error).toBe(failure);
    }
  },
);

it("preserves an existing canonical cleanup error", async () => {
  const failure = recordCommandProcessFailure(new CommandProcessCleanupError(), {
    code: null,
    cleanup: "uncertain",
    termination: "exit",
  });
  runner.mockRejectedValue(failure);
  expect((await runCommandBuffered(["fixture"])).error).toBe(failure);
});
