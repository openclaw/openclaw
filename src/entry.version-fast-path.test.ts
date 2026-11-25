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

it("skips host handling when container-targeted", () => {
  expect(
    tryHandleRootVersionFastPath(["node", "openclaw", "--container", "demo", "--version"]),
  ).toBe(false);

  vi.stubEnv("OPENCLAW_CONTAINER", "demo");
  expect(tryHandleRootVersionFastPath(argv)).toBe(false);
  expect(resolveCommitHash).not.toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
});

it.each([
  ["abc1234", undefined, "OpenClaw 9.9.9-test (abc1234)"],
  [null, undefined, "OpenClaw 9.9.9-test"],
  [null, "pretty", undefined],
  [null, "json", undefined],
] as const)("handles commit %s with %s diagnostics", async (commit, consoleStyle, expected) => {
  const printed = createDeferred();
  let diagnostic = "";
  output.mockImplementation(() => printed.resolve());
  if (consoleStyle) {
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      diagnostic += String(chunk);
      printed.resolve();
      return true;
    });
    setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle });
  }
  vi.mocked(resolveCommitHash).mockImplementation(() => {
    if (!consoleStyle) {
      return commit;
    }
    const error = new Error("version resolution failed");
    // Bun can materialize a collected stack with a bare header and no message.
    error.stack = "Error\n    at resolveCommitHash (git-commit.js:1:1)";
    throw error;
  });

  expect(tryHandleRootVersionFastPath(argv)).toBe(true);
  await printed.promise;

  expect(process.exitCode).toBe(consoleStyle ? 1 : 0);
  if (!consoleStyle) {
    expect(output).toHaveBeenCalledWith(expected);
    return;
  }
  expect(output).not.toHaveBeenCalled();
  if (consoleStyle === "json") {
    expect(JSON.parse(diagnostic)).toMatchObject({
      level: "error",
      message: expect.stringContaining("version resolution failed"),
    });
  } else {
    expect(diagnostic).toContain("version resolution failed");
  }
});
