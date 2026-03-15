import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import type { PluginLogger } from "../plugins/types.js";
import { registerExtensionHostCliCommands } from "./cli-lifecycle.js";

function createLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("registerExtensionHostCliCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips overlapping command registrations", () => {
    const program = new Command();
    program.command("memory");
    const registry = createEmptyPluginRegistry();
    const memoryRegister = vi.fn();
    const otherRegister = vi.fn();
    registry.cliRegistrars.push(
      {
        pluginId: "memory-core",
        register: memoryRegister,
        commands: ["memory"],
        source: "bundled",
      },
      {
        pluginId: "other",
        register: otherRegister,
        commands: ["other"],
        source: "bundled",
      },
    );
    const logger = createLogger();

    registerExtensionHostCliCommands({
      program,
      registry,
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      logger,
    });

    expect(memoryRegister).not.toHaveBeenCalled();
    expect(otherRegister).toHaveBeenCalledOnce();
    expect(logger.debug).toHaveBeenCalledWith(
      "plugin CLI register skipped (memory-core): command already registered (memory)",
    );
  });

  it("warns on sync and async registration failures", async () => {
    const program = new Command();
    const registry = createEmptyPluginRegistry();
    registry.cliRegistrars.push(
      {
        pluginId: "sync-fail",
        register: () => {
          throw new Error("sync fail");
        },
        commands: ["sync"],
        source: "bundled",
      },
      {
        pluginId: "async-fail",
        register: async () => {
          throw new Error("async fail");
        },
        commands: ["async"],
        source: "bundled",
      },
    );
    const logger = createLogger();

    registerExtensionHostCliCommands({
      program,
      registry,
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      logger,
    });
    await Promise.resolve();

    expect(logger.warn).toHaveBeenCalledWith(
      "plugin CLI register failed (sync-fail): Error: sync fail",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "plugin CLI register failed (async-fail): Error: async fail",
    );
  });
});
