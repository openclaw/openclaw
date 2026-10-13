import { describe, expect, it, vi } from "vitest";
import {
  installPluginMcpDependencies,
  isInstallSpecSupportedOnPlatform,
} from "./install-mcp-dependencies.js";
import * as skillLifecycle from "../skills/lifecycle/install.js";

describe("installPluginMcpDependencies", () => {
  it("propagates failure when dependency installation fails", async () => {
    const installSpy = vi.spyOn(skillLifecycle, "installDeclaredTool").mockResolvedValue({
      ok: false,
      message: "toolchain uv is not available",
    });

    const result = await installPluginMcpDependencies({
      pluginId: "python-plugin",
      mcpServers: {
        server1: {
          transport: "stdio",
          command: "uvx",
          args: ["broken-pkg"],
          install: [{ kind: "uv", package: "broken-pkg" }],
        },
      },
      timeoutMs: 15_000,
      logger: {},
    });

    expect(result).toEqual({
      ok: false,
      error: "Failed to install MCP dependency for python-plugin/server1: toolchain uv is not available",
    });
    installSpy.mockRestore();
  });

  it("skips recipes restricted to different host platforms", async () => {
    const installSpy = vi.spyOn(skillLifecycle, "installDeclaredTool").mockResolvedValue({ ok: true });
    const currentPlatform = process.platform;
    const otherPlatform = currentPlatform === "darwin" ? "linux" : "darwin";

    const result = await installPluginMcpDependencies({
      pluginId: "cross-platform-plugin",
      mcpServers: {
        tool: {
          transport: "stdio",
          command: "mcp-tool",
          install: [
            { kind: "brew", formula: "other-os-tool", os: [otherPlatform] },
            { kind: "uv", package: "current-os-tool", os: [currentPlatform] },
          ],
        },
      },
      timeoutMs: 20_000,
      logger: {},
    });

    expect(result).toEqual({ ok: true });
    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(installSpy).toHaveBeenCalledWith({
      spec: { kind: "uv", package: "current-os-tool", os: [currentPlatform] },
      config: undefined,
      timeoutMs: 20_000,
    });
    installSpy.mockRestore();
  });

  it("aborts recipe execution when signal is already aborted", async () => {
    const installSpy = vi.spyOn(skillLifecycle, "installDeclaredTool");
    const controller = new AbortController();
    controller.abort();

    await expect(
      installPluginMcpDependencies({
        pluginId: "aborted-plugin",
        mcpServers: {
          server: {
            install: [{ kind: "uv", package: "tool" }],
          },
        },
        timeoutMs: 10_000,
        signal: controller.signal,
        logger: {},
      }),
    ).rejects.toThrow();

    expect(installSpy).not.toHaveBeenCalled();
    installSpy.mockRestore();
  });

  it("halts subsequent recipes and asserts lifecycle ownership", async () => {
    const installSpy = vi.spyOn(skillLifecycle, "installDeclaredTool").mockResolvedValue({ ok: true });
    let ownershipCallCount = 0;
    const assertOwned = vi.fn(() => {
      ownershipCallCount++;
      if (ownershipCallCount > 2) {
        throw new Error("lost installation ownership");
      }
    });

    await expect(
      installPluginMcpDependencies({
        pluginId: "ownership-plugin",
        mcpServers: {
          first: {
            install: [{ kind: "uv", package: "tool-one" }],
          },
          second: {
            install: [{ kind: "uv", package: "tool-two" }],
          },
        },
        timeoutMs: 10_000,
        assertOwned,
        logger: {},
      }),
    ).rejects.toThrow("lost installation ownership");

    // First tool ran, second was halted before execution due to lost ownership
    expect(installSpy).toHaveBeenCalledTimes(1);
    installSpy.mockRestore();
  });
});
