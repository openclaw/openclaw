import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const getMemorySearchManager = vi.fn();
const loadConfig = vi.fn(() => ({}));
const resolveDefaultAgentId = vi.fn(() => "main");

vi.mock("../memory/index.js", () => ({
  getMemorySearchManager,
}));

vi.mock("../config/config.js", () => ({
  loadConfig,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId,
}));

afterEach(() => {
  vi.restoreAllMocks();
  getMemorySearchManager.mockReset();
});

describe("memory cli", () => {
  it("prints vector status when available", async () => {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {});
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        status: () => ({
          files: 2,
          chunks: 5,
          dirty: false,
          workspaceDir: "/tmp/clawd",
          dbPath: "/tmp/memory.sqlite",
          provider: "openai",
          model: "text-embedding-3-small",
          requestedProvider: "openai",
          vector: {
            enabled: true,
            available: true,
            extensionPath: "/opt/sqlite-vec.dylib",
            dims: 1024,
          },
        }),
        close,
      },
    });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", "status"], { from: "user" });

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector: ready"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector dims: 1024"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector path: /opt/sqlite-vec.dylib"));
    expect(close).toHaveBeenCalled();
  });

  it("prints vector error when unavailable", async () => {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {});
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        status: () => ({
          files: 0,
          chunks: 0,
          dirty: true,
          workspaceDir: "/tmp/clawd",
          dbPath: "/tmp/memory.sqlite",
          provider: "openai",
          model: "text-embedding-3-small",
          requestedProvider: "openai",
          vector: {
            enabled: true,
            available: false,
            loadError: "load failed",
          },
        }),
        close,
      },
    });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", "status", "--agent", "main"], { from: "user" });

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector: unavailable"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector error: load failed"));
    expect(close).toHaveBeenCalled();
  });
});
