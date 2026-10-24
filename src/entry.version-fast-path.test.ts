import "./test-utils/prepare-compiled-subprocesses.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../test/helpers/promise.js";
// Warm diagnostics before test deadlines, after compiled-subprocess preparation.
import "./cli/dotenv.js";
import { tryHandleRootVersionFastPath } from "./entry.version-fast-path.js";
import { resolveCommitHash } from "./infra/git-commit.js";
import { resetLogger, setLoggerOverride } from "./logging.js";
import "./logging/json-console-line.js";

vi.mock("./version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./version.js")>()),
  VERSION: "9.9.9-test",
}));

vi.mock("./infra/git-commit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./infra/git-commit.js")>()),
  resolveCommitHash: vi.fn(),
}));

const exit = vi.fn<typeof process.exit>();
const output = vi.fn<typeof console.log>();
const previousExitCode = process.exitCode;
const argv = ["node", "openclaw", "--version"];

beforeEach(() => {
  process.exitCode = undefined;
  vi.stubEnv("OPENCLAW_CONTAINER", undefined);
  vi.spyOn(process, "exit").mockImplementation(exit);
  vi.spyOn(console, "log").mockImplementation(output.mockReset());
});

afterEach(() => {
  const nativeExitCalls = exit.mock.calls.length;
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  resetLogger();
  expect(nativeExitCalls).toBe(0);
});

it.each([
  { commit: "abc1234", expected: "OpenClaw 9.9.9-test (abc1234)" },
  { commit: null, expected: "OpenClaw 9.9.9-test" },
])("prints version output with commit $commit", async ({ commit, expected }) => {
  const printed = createDeferred();
  output.mockImplementation(() => printed.resolve());
  vi.mocked(resolveCommitHash).mockReturnValue(commit);

  expect(tryHandleRootVersionFastPath(argv)).toBe(true);
  await printed.promise;

  expect(output).toHaveBeenCalledWith(expected);
  expect(process.exitCode).toBe(0);
});

it("skips host handling when container-targeted", () => {
  expect(
    tryHandleRootVersionFastPath(["node", "openclaw", "--container", "demo", "--version"]),
  ).toBe(false);

  vi.stubEnv("OPENCLAW_CONTAINER", "demo");
  expect(tryHandleRootVersionFastPath(argv)).toBe(false);
  expect(resolveCommitHash).not.toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
});

it.each(["pretty", "json"] as const)(
  "reports %s version-resolution errors",
  async (consoleStyle) => {
    const printed = createDeferred();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      printed.resolve();
      return true;
    });
    vi.mocked(resolveCommitHash).mockImplementation(() => {
      const error = new Error("version resolution failed");
      // Bun can materialize a collected stack with a bare header and no message.
      error.stack = "Error\n    at resolveCommitHash (git-commit.js:1:1)";
      throw error;
    });
    setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle });

    expect(tryHandleRootVersionFastPath(argv)).toBe(true);
    await printed.promise;

    expect(process.exitCode).toBe(1);
    expect(output).not.toHaveBeenCalled();
    const line = stderr.mock.calls.map(([value]) => String(value)).join("");
    if (consoleStyle === "json") {
      expect(JSON.parse(line)).toMatchObject({
        level: "error",
        message: expect.stringContaining("version resolution failed"),
      });
    } else {
      expect(line).toContain("version resolution failed");
    }
  },
);
