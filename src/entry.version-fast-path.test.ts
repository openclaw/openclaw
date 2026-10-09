import "./test-utils/prepare-compiled-subprocesses.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../test/helpers/promise.js";
import { tryHandleRootVersionFastPath } from "./entry.version-fast-path.js";
import { resolveCommitHash } from "./infra/git-commit.js";

vi.mock("./version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./version.js")>()),
  VERSION: "9.9.9-test",
}));

vi.mock("./infra/git-commit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./infra/git-commit.js")>()),
  resolveCommitHash: vi.fn(),
}));

describe("entry root version fast path", () => {
  const exit = vi.fn<typeof process.exit>();
  let logging: typeof import("./logging.js");

  beforeAll(async () => {
    // Cold diagnostics can compile worker artifacts; prepare them before behavior deadlines.
    [logging] = await Promise.all([
      import("./logging.js"),
      import("./cli/dotenv.js"),
      import("./logging/json-console-line.js"),
    ]);
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_CONTAINER", undefined);
    vi.spyOn(process, "exit").mockImplementation(exit);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    logging.resetLogger();
  });

  it.each([
    { commit: "abc1234", expected: "OpenClaw 9.9.9-test (abc1234)" },
    { commit: null, expected: "OpenClaw 9.9.9-test" },
  ])("prints version output with commit $commit", async ({ commit, expected }) => {
    const printed = createDeferred();
    const output = vi.spyOn(console, "log").mockImplementation(() => printed.resolve());
    vi.mocked(resolveCommitHash).mockReturnValue(commit);

    expect(tryHandleRootVersionFastPath(["node", "openclaw", "--version"])).toBe(true);
    await printed.promise;

    expect(output).toHaveBeenCalledWith(expected);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("skips host handling when container-targeted", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(
      tryHandleRootVersionFastPath(["node", "openclaw", "--container", "demo", "--version"]),
    ).toBe(false);

    vi.stubEnv("OPENCLAW_CONTAINER", "demo");
    expect(tryHandleRootVersionFastPath(["node", "openclaw", "--version"])).toBe(false);
    expect(resolveCommitHash).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it.each(["pretty", "json"] as const)(
    "reports version-resolution failures with %s console output",
    async (consoleStyle) => {
      const printed = createDeferred();
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => {
        printed.resolve();
        return true;
      });
      vi.mocked(resolveCommitHash).mockImplementation(() => {
        throw new Error("version resolution failed");
      });
      logging.setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle });

      expect(tryHandleRootVersionFastPath(["node", "openclaw", "--version"])).toBe(true);
      await printed.promise;

      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
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
});
