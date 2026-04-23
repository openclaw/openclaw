import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoggingConfig } from "../config/types.base.js";

function buildConfigModule(logging: unknown) {
  return {
    loadConfig: () => ({ logging }) as { logging?: LoggingConfig },
    readBestEffortConfig: () => ({ logging }) as { logging?: LoggingConfig },
  };
}

describe("readBestEffortLoggingConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("./node-require.js");
    vi.doUnmock("node:fs");
    vi.doUnmock("node:url");
  });

  it("loads config from the source-tree path when available", async () => {
    const requireConfigMock = vi.fn((id: string) => {
      if (id === "../config/config.js") {
        return buildConfigModule({ level: "debug" });
      }
      throw new Error(`unexpected module id: ${id}`);
    });

    const { readBestEffortLoggingConfig } = await import("./config-loader.js");

    expect(readBestEffortLoggingConfig(requireConfigMock)).toEqual({ level: "debug" });
    expect(requireConfigMock).toHaveBeenCalledWith("../config/config.js");
  });

  it("falls back to the flattened build path when source-layout config is absent", async () => {
    const requireConfigMock = vi.fn((id: string) => {
      if (id === "../config/config.js") {
        throw new Error("module not found");
      }
      if (id === "./config.js") {
        return buildConfigModule({ consoleStyle: "json" });
      }
      throw new Error(`unexpected module id: ${id}`);
    });

    const { readBestEffortLoggingConfig } = await import("./config-loader.js");

    expect(readBestEffortLoggingConfig(requireConfigMock)).toEqual({ consoleStyle: "json" });
    expect(requireConfigMock).toHaveBeenCalledWith("../config/config.js");
    expect(requireConfigMock).toHaveBeenCalledWith("./config.js");
  });

  it("falls back to a hashed flattened config chunk when config.js is not the config module", async () => {
    const requireConfigMock = vi.fn((id: string) => {
      if (id === "../config/config.js") {
        throw new Error("module not found");
      }
      if (id === "./config.js") {
        return {
          loadConfig: () => ({ logging: { level: "error" } }) as { logging?: LoggingConfig },
        };
      }
      if (id === "./config-Ck9ngs9g.js") {
        return buildConfigModule({ consoleStyle: "json" });
      }
      throw new Error(`unexpected module id: ${id}`);
    });
    const readdirSyncMock = vi.fn(() => [
      { name: "config-Ck9ngs9g.js", isFile: () => true },
      { name: "config-loader-Dqw-HP5B.js", isFile: () => true },
      { name: "nested", isFile: () => false },
    ]);
    vi.doMock("./node-require.js", () => ({
      resolveNodeRequireFromMeta: () => requireConfigMock,
    }));
    vi.doMock("node:fs", () => ({
      default: {
        readdirSync: readdirSyncMock,
      },
    }));
    vi.doMock("node:url", async () => {
      const actual = await vi.importActual<typeof import("node:url")>("node:url");
      return {
        ...actual,
        fileURLToPath: () => "/tmp/dist/config-loader.js",
      };
    });

    const { readBestEffortLoggingConfig } = await import("./config-loader.js");

    expect(readBestEffortLoggingConfig()).toEqual({ consoleStyle: "json" });
    expect(readdirSyncMock).toHaveBeenCalledWith("/tmp/dist", { withFileTypes: true });
    expect(requireConfigMock).toHaveBeenCalledWith("../config/config.js");
    expect(requireConfigMock).toHaveBeenCalledWith("./config.js");
    expect(requireConfigMock).toHaveBeenCalledWith("./config-Ck9ngs9g.js");
    expect(requireConfigMock).not.toHaveBeenCalledWith("./config-loader-Dqw-HP5B.js");
  });

  it("ignores candidates that do not export loadConfig", async () => {
    const requireConfigMock = vi.fn(() => ({}));
    vi.doMock("node:fs", () => ({
      default: {
        readdirSync: () => [],
      },
    }));

    const { readBestEffortLoggingConfig } = await import("./config-loader.js");

    expect(readBestEffortLoggingConfig(requireConfigMock)).toBeUndefined();
    expect(requireConfigMock).toHaveBeenCalledTimes(2);
  });

  it("returns undefined when the logging section is not an object", async () => {
    const requireConfigMock = vi.fn(() => buildConfigModule("debug"));

    const { readBestEffortLoggingConfig } = await import("./config-loader.js");

    expect(readBestEffortLoggingConfig(requireConfigMock)).toBeUndefined();
  });
});
