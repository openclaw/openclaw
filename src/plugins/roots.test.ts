import os from "node:os";
import { describe, expect, it, vi, afterEach } from "vitest";
import { resolveSystemPluginsDir, resolvePluginSourceRoots } from "./roots.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveSystemPluginsDir", () => {
  it("returns the Windows ProgramData path on win32", () => {
    vi.spyOn(os, "platform").mockReturnValue("win32");
    const dir = resolveSystemPluginsDir({
      PROGRAMDATA: "D:\\ProgramData",
    } as NodeJS.ProcessEnv);
    expect(dir).toBe("D:\\ProgramData\\OpenClaw\\plugins");
  });

  it("falls back to C:\\ProgramData when PROGRAMDATA is unset on win32", () => {
    vi.spyOn(os, "platform").mockReturnValue("win32");
    const dir = resolveSystemPluginsDir({} as NodeJS.ProcessEnv);
    expect(dir).toBe("C:\\ProgramData\\OpenClaw\\plugins");
  });

  it("returns /etc/openclaw/plugins on Linux", () => {
    vi.spyOn(os, "platform").mockReturnValue("linux");
    const dir = resolveSystemPluginsDir({} as NodeJS.ProcessEnv);
    expect(dir).toBe("/etc/openclaw/plugins");
  });

  it("returns /etc/openclaw/plugins on macOS", () => {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    const dir = resolveSystemPluginsDir({} as NodeJS.ProcessEnv);
    expect(dir).toBe("/etc/openclaw/plugins");
  });
});

describe("resolvePluginSourceRoots", () => {
  it("includes system as a string in the returned roots", () => {
    const roots = resolvePluginSourceRoots({ env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } as NodeJS.ProcessEnv });
    expect(typeof roots.system).toBe("string");
    expect(roots.system.length).toBeGreaterThan(0);
  });
});
