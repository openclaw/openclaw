// Tests root help fast-path handling before full CLI startup.
import { describe, expect, it, vi } from "vitest";
import { tryHandlePrecomputedCommandHelpFastPath, tryHandleRootHelpFastPath } from "./entry.js";

describe("entry root help fast paths", () => {
  it("uses precomputed root help when no live config-sensitive options exist", async () => {
    const outputPrecomputedRootHelpText = vi.fn(() => true);
    const outputRootHelp = vi.fn();

    await expect(
      tryHandleRootHelpFastPath(["node", "openclaw", "--help"], {
        loadRootHelpRenderOptionsForConfigSensitivePlugins: async () => null,
        outputPrecomputedRootHelpText,
        outputRootHelp,
      }),
    ).resolves.toBe(true);

    expect(outputPrecomputedRootHelpText).toHaveBeenCalledTimes(1);
    expect(outputRootHelp).not.toHaveBeenCalled();
  });

  it("renders dynamic root help when live options are available", async () => {
    const outputPrecomputedRootHelpText = vi.fn(() => true);
    const outputRootHelp = vi.fn();
    const liveOptions = { includePluginDescriptors: true };

    await expect(
      tryHandleRootHelpFastPath(["node", "openclaw", "--help"], {
        loadRootHelpRenderOptionsForConfigSensitivePlugins: async () => liveOptions,
        outputPrecomputedRootHelpText,
        outputRootHelp,
      }),
    ).resolves.toBe(true);

    expect(outputPrecomputedRootHelpText).not.toHaveBeenCalled();
    expect(outputRootHelp).toHaveBeenCalledWith(liveOptions);
  });

  it("uses precomputed command help for non-config-sensitive commands", async () => {
    const outputPrecomputedBrowserHelpText = vi.fn(() => true);

    await expect(
      tryHandlePrecomputedCommandHelpFastPath(["node", "openclaw", "browser", "--help"], {
        outputPrecomputedBrowserHelpText,
      }),
    ).resolves.toBe(true);

    expect(outputPrecomputedBrowserHelpText).toHaveBeenCalledTimes(1);
  });

  it("skips precomputed nodes help when live root options are present", async () => {
    const outputPrecomputedNodesHelpText = vi.fn(() => true);

    await expect(
      tryHandlePrecomputedCommandHelpFastPath(["node", "openclaw", "nodes", "--help"], {
        loadRootHelpRenderOptionsForConfigSensitivePlugins: async () => ({
          includePluginDescriptors: true,
        }),
        outputPrecomputedNodesHelpText,
      }),
    ).resolves.toBe(false);

    expect(outputPrecomputedNodesHelpText).not.toHaveBeenCalled();
  });

  it("terminates the process when rendering root help fails", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await tryHandleRootHelpFastPath(["node", "openclaw", "--help"], {
      loadRootHelpRenderOptionsForConfigSensitivePlugins: async () => null,
      outputPrecomputedRootHelpText: () => false,
      outputRootHelp: async () => {
        throw new Error("render failed");
      },
    });

    expect(result).toBe(true);
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});
