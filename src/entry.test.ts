// Tests CLI entrypoint argument handling and startup behavior.
import { describe, expect, it, vi } from "vitest";
import { tryHandlePrecomputedCommandHelpFastPath, tryHandleRootHelpFastPath } from "./entry.js";
import { withEnvAsync } from "./test-utils/env.js";

describe("entry root help fast path", () => {
  it("respects the startup help fast path kill switch", async () => {
    const argv = ["node", "openclaw", "--help"];
    const outputPrecomputedRootHelpText = vi.fn(() => true);
    const outputRootHelp = vi.fn();
    const loadRootHelpRenderOptionsForConfigSensitivePlugins = vi.fn(async () => null);

    await expect(
      tryHandleRootHelpFastPath(argv, {
        env: { OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH: "1" },
        outputPrecomputedRootHelpText,
        outputRootHelp,
        loadRootHelpRenderOptionsForConfigSensitivePlugins,
      }),
    ).resolves.toBe(false);

    expect(loadRootHelpRenderOptionsForConfigSensitivePlugins).not.toHaveBeenCalled();
    expect(outputPrecomputedRootHelpText).not.toHaveBeenCalled();
    expect(outputRootHelp).not.toHaveBeenCalled();
  });

  it("respects the process env startup help fast path kill switch", async () => {
    const outputPrecomputedRootHelpText = vi.fn(() => true);
    const outputRootHelp = vi.fn();
    const loadRootHelpRenderOptionsForConfigSensitivePlugins = vi.fn(async () => null);

    await withEnvAsync({ OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH: "1" }, async () => {
      await expect(
        tryHandleRootHelpFastPath(["node", "openclaw", "--help"], {
          outputPrecomputedRootHelpText,
          outputRootHelp,
          loadRootHelpRenderOptionsForConfigSensitivePlugins,
        }),
      ).resolves.toBe(false);

      expect(loadRootHelpRenderOptionsForConfigSensitivePlugins).not.toHaveBeenCalled();
      expect(outputPrecomputedRootHelpText).not.toHaveBeenCalled();
      expect(outputRootHelp).not.toHaveBeenCalled();
    });
  });

  it("prefers precomputed root help text when available", async () => {
    const outputPrecomputedRootHelpText = vi.fn(() => true);
    const outputRootHelp = vi.fn();

    const handled = await tryHandleRootHelpFastPath(["node", "openclaw", "--help"], {
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

    const handled = await tryHandleRootHelpFastPath(["node", "openclaw", "--help"], {
      outputRootHelp,
      loadRootHelpRenderOptionsForConfigSensitivePlugins: async () => null,
      env: {},
    });

    expect(handled).toBe(true);
    expect(outputRootHelp).toHaveBeenCalledOnce();
  });

  it("renders live root help when plugin config changes command descriptors", async () => {
    const outputPrecomputedRootHelpText = vi.fn();
    const outputRootHelp = vi.fn();
    const liveOptions = {
      config: {
        plugins: {
          slots: {
            memory: "memory-lancedb",
          },
        },
      },
      env: {},
    };

    const handled = await tryHandleRootHelpFastPath(["node", "openclaw", "--help"], {
      env: {},
      outputPrecomputedRootHelpText: outputPrecomputedRootHelpText.mockReturnValue(true),
      outputRootHelp,
      loadRootHelpRenderOptionsForConfigSensitivePlugins: async () => liveOptions,
    });

    expect(handled).toBe(true);
    expect(outputPrecomputedRootHelpText).not.toHaveBeenCalled();
    expect(outputRootHelp).toHaveBeenCalledExactlyOnceWith(liveOptions);
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
        tryHandleRootHelpFastPath(["node", "openclaw", "--help"], {
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

    const handled = await tryHandleRootHelpFastPath(["node", "openclaw", "status", "--help"], {
      outputRootHelp,
      loadRootHelpRenderOptionsForConfigSensitivePlugins: async () => null,
      env: {},
    });

    expect(handled).toBe(false);
    expect(outputRootHelp).not.toHaveBeenCalled();
  });

  it("skips the host help fast path when a container target is active", async () => {
    const outputRootHelp = vi.fn();

    const handled = await tryHandleRootHelpFastPath(
      ["node", "openclaw", "--container", "demo", "--help"],
      {
        outputRootHelp,
        loadRootHelpRenderOptionsForConfigSensitivePlugins: async () => null,
        env: {},
      },
    );

    expect(handled).toBe(false);
    expect(outputRootHelp).not.toHaveBeenCalled();
  });
});

describe("entry precomputed command help fast path", () => {
  it.each([
    ["browser", "outputPrecomputedBrowserHelpText"],
    ["secrets", "outputPrecomputedSecretsHelpText"],
    ["nodes", "outputPrecomputedNodesHelpText"],
  ] as const)(
    "renders precomputed %s help without loading the full program",
    async (command, key) => {
      const output = vi.fn(() => true);
      const handled = await tryHandlePrecomputedCommandHelpFastPath(
        ["node", "openclaw", command, "--help"],
        {
          env: {},
          loadRootHelpRenderOptionsForConfigSensitivePlugins: async () => null,
          [key]: output,
        },
      );
      expect(handled).toBe(true);
      expect(output).toHaveBeenCalledOnce();
    },
  );

  it("renders precomputed doctor help without loading the full program", async () => {
    const outputPrecomputedSubcommandHelpText = vi.fn(() => true);
    expect(
      await tryHandlePrecomputedCommandHelpFastPath(["node", "openclaw", "doctor", "--help"], {
        env: {},
        outputPrecomputedSubcommandHelpText,
      }),
    ).toBe(true);
    expect(outputPrecomputedSubcommandHelpText).toHaveBeenCalledExactlyOnceWith("doctor");
  });

  it("renders precomputed subcommand help with leading root options", async () => {
    const outputPrecomputedSubcommandHelpText = vi.fn(() => true);

    const handled = await tryHandlePrecomputedCommandHelpFastPath(
      ["node", "openclaw", "--profile", "work", "--no-color", "models", "-h"],
      {
        env: {},
        outputPrecomputedSubcommandHelpText,
      },
    );

    expect(handled).toBe(true);
    expect(outputPrecomputedSubcommandHelpText).toHaveBeenCalledExactlyOnceWith("models");
  });

  it("keeps subcommand help fast path strict for extra or mixed flags", async () => {
    const invocations = [
      ["node", "openclaw", "doctor", "--version"],
      ["node", "openclaw", "gateway", "-V"],
      ["node", "openclaw", "doctor", "--help", "--version"],
      ["node", "openclaw", "doctor", "--help", "--bogus"],
      ["node", "openclaw", "doctor", "--help", "extra"],
      ["node", "openclaw", "doctor", "--version", "-h"],
      ["node", "openclaw", "--bogus", "doctor", "--help"],
      ["node", "openclaw", "gateway", "status", "--help"],
      ["node", "openclaw", "status", "--help"],
    ];
    const outputPrecomputedSubcommandHelpText = vi.fn();

    for (const argv of invocations) {
      const handled = await tryHandlePrecomputedCommandHelpFastPath(argv, {
        env: {},
        outputPrecomputedSubcommandHelpText:
          outputPrecomputedSubcommandHelpText.mockReturnValue(true),
      });

      expect(handled).toBe(false);
    }
    expect(outputPrecomputedSubcommandHelpText).not.toHaveBeenCalled();
  });

  it("defers nodes help when plugin config can change command metadata", async () => {
    const outputPrecomputedNodesHelpText = vi.fn();
    const loadRootHelpRenderOptionsForConfigSensitivePlugins = vi.fn(async () => ({ env: {} }));

    const handled = await tryHandlePrecomputedCommandHelpFastPath(
      ["node", "openclaw", "nodes", "--help"],
      {
        env: {},
        loadRootHelpRenderOptionsForConfigSensitivePlugins,
        outputPrecomputedNodesHelpText: outputPrecomputedNodesHelpText.mockReturnValue(true),
      },
    );

    expect(handled).toBe(false);
    expect(loadRootHelpRenderOptionsForConfigSensitivePlugins).toHaveBeenCalledOnce();
    expect(outputPrecomputedNodesHelpText).not.toHaveBeenCalled();
  });

  it("falls through when startup metadata is unavailable", async () => {
    const handled = await tryHandlePrecomputedCommandHelpFastPath(
      ["node", "openclaw", "secrets", "--help"],
      {
        env: {},
        outputPrecomputedSecretsHelpText: () => false,
      },
    );

    expect(handled).toBe(false);
  });

  it("falls through when startup metadata loading fails", async () => {
    const handled = await tryHandlePrecomputedCommandHelpFastPath(
      ["node", "openclaw", "secrets", "--help"],
      {
        env: {},
        outputPrecomputedSecretsHelpText: () => {
          throw new Error("startup metadata failed");
        },
      },
    );

    expect(handled).toBe(false);
  });

  it("falls through when the nodes live-config probe fails", async () => {
    const handled = await tryHandlePrecomputedCommandHelpFastPath(
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

  it("ignores nested subcommand help invocations", async () => {
    const outputPrecomputedNodesHelpText = vi.fn();

    const handled = await tryHandlePrecomputedCommandHelpFastPath(
      ["node", "openclaw", "nodes", "invoke", "--help"],
      {
        env: {},
        outputPrecomputedNodesHelpText: outputPrecomputedNodesHelpText.mockReturnValue(true),
      },
    );

    expect(handled).toBe(false);
    expect(outputPrecomputedNodesHelpText).not.toHaveBeenCalled();
  });

  it("ignores command version invocations", async () => {
    const outputPrecomputedNodesHelpText = vi.fn();

    const handled = await tryHandlePrecomputedCommandHelpFastPath(
      ["node", "openclaw", "nodes", "--version"],
      {
        env: {},
        outputPrecomputedNodesHelpText: outputPrecomputedNodesHelpText.mockReturnValue(true),
      },
    );

    expect(handled).toBe(false);
    expect(outputPrecomputedNodesHelpText).not.toHaveBeenCalled();
  });

  it("respects the startup help fast path kill switch", async () => {
    const outputPrecomputedSecretsHelpText = vi.fn();

    const handled = await tryHandlePrecomputedCommandHelpFastPath(
      ["node", "openclaw", "secrets", "--help"],
      {
        env: { OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH: "1" },
        outputPrecomputedSecretsHelpText: outputPrecomputedSecretsHelpText.mockReturnValue(true),
      },
    );

    expect(handled).toBe(false);
    expect(outputPrecomputedSecretsHelpText).not.toHaveBeenCalled();
  });

  it("respects the process env startup help fast path kill switch", async () => {
    const outputPrecomputedSecretsHelpText = vi.fn();
    await withEnvAsync({ OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH: "1" }, async () => {
      const handled = await tryHandlePrecomputedCommandHelpFastPath(
        ["node", "openclaw", "secrets", "--help"],
        {
          outputPrecomputedSecretsHelpText: outputPrecomputedSecretsHelpText.mockReturnValue(true),
        },
      );

      expect(handled).toBe(false);
      expect(outputPrecomputedSecretsHelpText).not.toHaveBeenCalled();
    });
  });

  it("skips the host command help fast path when a container target is active", async () => {
    const outputPrecomputedSecretsHelpText = vi.fn();

    const handled = await tryHandlePrecomputedCommandHelpFastPath(
      ["node", "openclaw", "--container", "demo", "secrets", "--help"],
      {
        env: {},
        outputPrecomputedSecretsHelpText: outputPrecomputedSecretsHelpText.mockReturnValue(true),
      },
    );

    expect(handled).toBe(false);
    expect(outputPrecomputedSecretsHelpText).not.toHaveBeenCalled();
  });

  it("skips the host command help fast path when a container target comes from env", async () => {
    const outputPrecomputedBrowserHelpText = vi.fn();

    const handled = await tryHandlePrecomputedCommandHelpFastPath(
      ["node", "openclaw", "browser", "--help"],
      {
        env: { OPENCLAW_CONTAINER: "demo" },
        outputPrecomputedBrowserHelpText: outputPrecomputedBrowserHelpText.mockReturnValue(true),
      },
    );

    expect(handled).toBe(false);
    expect(outputPrecomputedBrowserHelpText).not.toHaveBeenCalled();
  });
});
