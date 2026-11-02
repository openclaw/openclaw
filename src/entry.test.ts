import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithPrecomputedHelpMocks } from "./cli/precomputed-help.test-helpers.js";
import * as rootHelp from "./cli/program/root-help.js";
import * as liveHelp from "./cli/root-help-live-config.js";
import * as helpMetadata from "./cli/root-help-metadata.js";
import { tryHandlePrecomputedCommandHelpFastPath, tryHandleRootHelpFastPath } from "./entry.js";

describe("entry root help fast path", () => {
  beforeEach(() => {
    vi.spyOn(helpMetadata, "outputPrecomputedRootHelpText").mockReturnValue(false);
    vi.spyOn(rootHelp, "outputRootHelp").mockResolvedValue(undefined);
    vi.spyOn(liveHelp, "loadRootHelpRenderOptionsForConfigSensitivePlugins").mockResolvedValue(
      null,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["precomputed", ["--help"], true, true, 1, 0],
    ["rendered", ["--help"], false, true, 1, 1],
    ["non-root", ["status", "--help"], false, false, 0, 0],
    ["container", ["--container", "demo", "--help"], false, false, 0, 0],
  ] as const)("handles %s help", async (_name, args, cached, handled, precomputed, rendered) => {
    vi.mocked(helpMetadata.outputPrecomputedRootHelpText).mockReturnValue(cached);
    expect(await tryHandleRootHelpFastPath(["node", "openclaw", ...args])).toBe(handled);
    expect(helpMetadata.outputPrecomputedRootHelpText).toHaveBeenCalledTimes(precomputed);
    expect(rootHelp.outputRootHelp).toHaveBeenCalledTimes(rendered);
  });

  it("structures root help rendering failures for JSON console style", async () => {
    const logging = await import("./logging.js");
    logging.setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "json" });
    const previousExitCode = process.exitCode;
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });
    vi.mocked(liveHelp.loadRootHelpRenderOptionsForConfigSensitivePlugins).mockResolvedValue({
      config: {},
      env: {},
    });
    vi.mocked(rootHelp.outputRootHelp).mockImplementation(() => {
      throw new Error("render failed");
    });

    try {
      await expect(tryHandleRootHelpFastPath(["node", "openclaw", "--help"])).resolves.toBe(true);
      const line = stderrSpy.mock.calls.map(([value]) => String(value)).join("");
      expect(JSON.parse(line)).toMatchObject({
        level: "error",
        message: expect.stringContaining("Failed to display help"),
      });
      expect(process.exitCode).toBe(1);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
      logging.resetLogger();
    }
  });
});

describe("entry precomputed command help fast path", () => {
  it("falls through when the nodes live-config probe fails", async () => {
    const handled = await runWithPrecomputedHelpMocks(
      tryHandlePrecomputedCommandHelpFastPath,
      ["node", "openclaw", "nodes", "--help"],
      {
        env: {},
        loadRootHelpRenderOptionsForConfigSensitivePlugins: async () => {
          throw new Error("live config failed");
        },
      },
    );

    expect(handled).toBe(false);
  });

  it("skips the host command help fast path when a container target is active", async () => {
    const outputPrecomputedCommandHelpText = vi.fn();

    const handled = await runWithPrecomputedHelpMocks(
      tryHandlePrecomputedCommandHelpFastPath,
      ["node", "openclaw", "--container", "demo", "secrets", "--help"],
      {
        env: {},
        outputPrecomputedCommandHelpText: outputPrecomputedCommandHelpText.mockReturnValue(true),
      },
    );

    expect(handled).toBe(false);
    expect(outputPrecomputedCommandHelpText).not.toHaveBeenCalled();
  });
});
