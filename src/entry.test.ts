// Tests CLI entrypoint argument handling and startup behavior.
import { describe, expect, it, vi } from "vitest";
import { runWithPrecomputedHelpMocks } from "./cli/precomputed-help.test-helpers.js";
import * as rootHelp from "./cli/program/root-help.js";
import * as liveHelp from "./cli/root-help-live-config.js";
import * as helpMetadata from "./cli/root-help-metadata.js";
import { tryHandlePrecomputedCommandHelpFastPath, tryHandleRootHelpFastPath } from "./entry.js";
import { withEnvAsync } from "./test-utils/env.js";

async function runRootHelp(
  argv: string[],
  setup: {
    env?: NodeJS.ProcessEnv;
    outputPrecomputedRootHelpText?: typeof helpMetadata.outputPrecomputedRootHelpText;
    outputRootHelp?: typeof rootHelp.outputRootHelp;
    loadRootHelpRenderOptionsForConfigSensitivePlugins?: typeof liveHelp.loadRootHelpRenderOptionsForConfigSensitivePlugins;
  },
) {
  const spies = [
    vi
      .spyOn(helpMetadata, "outputPrecomputedRootHelpText")
      .mockImplementation(setup.outputPrecomputedRootHelpText ?? (() => false)),
    vi
      .spyOn(rootHelp, "outputRootHelp")
      .mockImplementation(setup.outputRootHelp ?? (async () => {})),
    vi
      .spyOn(liveHelp, "loadRootHelpRenderOptionsForConfigSensitivePlugins")
      .mockImplementation(
        setup.loadRootHelpRenderOptionsForConfigSensitivePlugins ?? (async () => null),
      ),
  ];
  try {
    return await withEnvAsync(setup.env ?? {}, () => tryHandleRootHelpFastPath(argv));
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
}

describe("entry root help fast path", () => {
  it("prefers precomputed root help text when available", async () => {
    const outputPrecomputedRootHelpText = vi.fn(() => true);
    const outputRootHelp = vi.fn();

    const handled = await runRootHelp(["node", "openclaw", "--help"], {
      env: {},
      outputPrecomputedRootHelpText,
      outputRootHelp,
      loadRootHelpRenderOptionsForConfigSensitivePlugins: async () => null,
    });

    expect(handled).toBe(true);
    expect(outputPrecomputedRootHelpText).toHaveBeenCalledOnce();
    expect(outputRootHelp).not.toHaveBeenCalled();
  });

  it("renders root help without importing the full program", async () => {
    const outputRootHelp = vi.fn();

    const handled = await runRootHelp(["node", "openclaw", "--help"], {
      outputRootHelp,
      loadRootHelpRenderOptionsForConfigSensitivePlugins: async () => null,
      env: {},
    });

    expect(handled).toBe(true);
    expect(outputRootHelp).toHaveBeenCalledOnce();
  });

  it("structures root help rendering failures for JSON console style", async () => {
    const logging = await import("./logging.js");
    logging.setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "json" });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });

    try {
      await expect(
        runRootHelp(["node", "openclaw", "--help"], {
          env: {},
          loadRootHelpRenderOptionsForConfigSensitivePlugins: async () => ({
            config: {},
            env: {},
          }),
          outputRootHelp: () => {
            throw new Error("render failed");
          },
        }),
      ).rejects.toThrow("exit 1");
      const line = stderrSpy.mock.calls.map(([value]) => String(value)).join("");
      expect(JSON.parse(line)).toMatchObject({
        level: "error",
        message: expect.stringContaining("Failed to display help"),
      });
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      logging.resetLogger();
      vi.restoreAllMocks();
    }
  });

  it("ignores non-root help invocations", async () => {
    const outputRootHelp = vi.fn();

    const handled = await runRootHelp(["node", "openclaw", "status", "--help"], {
      outputRootHelp,
      loadRootHelpRenderOptionsForConfigSensitivePlugins: async () => null,
      env: {},
    });

    expect(handled).toBe(false);
    expect(outputRootHelp).not.toHaveBeenCalled();
  });

  it("skips the host help fast path when a container target is active", async () => {
    const outputRootHelp = vi.fn();

    const handled = await runRootHelp(["node", "openclaw", "--container", "demo", "--help"], {
      outputRootHelp,
      loadRootHelpRenderOptionsForConfigSensitivePlugins: async () => null,
      env: {},
    });

    expect(handled).toBe(false);
    expect(outputRootHelp).not.toHaveBeenCalled();
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
    const outputPrecomputedSecretsHelpText = vi.fn();

    const handled = await runWithPrecomputedHelpMocks(
      tryHandlePrecomputedCommandHelpFastPath,
      ["node", "openclaw", "--container", "demo", "secrets", "--help"],
      {
        env: {},
        outputPrecomputedSecretsHelpText: outputPrecomputedSecretsHelpText.mockReturnValue(true),
      },
    );

    expect(handled).toBe(false);
    expect(outputPrecomputedSecretsHelpText).not.toHaveBeenCalled();
  });
});
