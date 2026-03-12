import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import {
  formatBonjourInstanceName,
  resolveBonjourCliPath,
  resolveTailnetDnsHint,
} from "./server-discovery.js";

describe("formatBonjourInstanceName", () => {
  it("should return 'OpenClaw' for empty string", () => {
    expect(formatBonjourInstanceName("")).toBe("OpenClaw");
  });

  it("should return 'OpenClaw' for whitespace only", () => {
    expect(formatBonjourInstanceName("   ")).toBe("OpenClaw");
  });

  it("should trim whitespace from display name", () => {
    expect(formatBonjourInstanceName("  My Server  ")).toBe("My Server (OpenClaw)");
  });

  it("should not modify name already containing 'openclaw' (case insensitive)", () => {
    expect(formatBonjourInstanceName("My OpenClaw Server")).toBe("My OpenClaw Server");
    expect(formatBonjourInstanceName("my openclaw server")).toBe("my openclaw server");
    expect(formatBonjourInstanceName("MY OPENCLAW SERVER")).toBe("MY OPENCLAW SERVER");
  });

  it("should append ' (OpenClaw)' to names without 'openclaw'", () => {
    expect(formatBonjourInstanceName("My Server")).toBe("My Server (OpenClaw)");
    expect(formatBonjourInstanceName("Development")).toBe("Development (OpenClaw)");
  });

  it("should handle special characters in names", () => {
    expect(formatBonjourInstanceName("Server-123_test")).toBe("Server-123_test (OpenClaw)");
  });
});

describe("resolveBonjourCliPath", () => {
  it("should return env path when OPENCLAW_CLI_PATH is set", () => {
    const result = resolveBonjourCliPath({
      env: { OPENCLAW_CLI_PATH: "/custom/path/openclaw" },
    });
    expect(result).toBe("/custom/path/openclaw");
  });

  it("should trim whitespace from env path", () => {
    const result = resolveBonjourCliPath({
      env: { OPENCLAW_CLI_PATH: "  /custom/path/openclaw  " },
    });
    expect(result).toBe("/custom/path/openclaw");
  });

  it("should return sibling cli when it exists", () => {
    const mockStatSync = vi.fn((path: string) => {
      if (path === "/exec/dir/openclaw") {
        return { isFile: () => true } as fs.Stats;
      }
      throw new Error("File not found");
    });

    const result = resolveBonjourCliPath({
      execPath: "/exec/dir/node",
      statSync: mockStatSync,
    });
    expect(result).toBe("/exec/dir/openclaw");
  });

  it("should return argv path when it exists", () => {
    const mockStatSync = vi.fn((path: string) => {
      if (path === "/argv/path/openclaw") {
        return { isFile: () => true } as fs.Stats;
      }
      throw new Error("File not found");
    });

    const result = resolveBonjourCliPath({
      argv: ["node", "/argv/path/openclaw"],
      statSync: mockStatSync,
    });
    expect(result).toBe("/argv/path/openclaw");
  });

  it("should return dist cli when it exists", () => {
    const mockStatSync = vi.fn((path: string) => {
      if (path === "/cwd/dist/index.js") {
        return { isFile: () => true } as fs.Stats;
      }
      throw new Error("File not found");
    });

    const result = resolveBonjourCliPath({
      cwd: "/cwd",
      statSync: mockStatSync,
    });
    expect(result).toBe("/cwd/dist/index.js");
  });

  it("should return bin cli when it exists", () => {
    const mockStatSync = vi.fn((path: string) => {
      if (path === "/cwd/bin/openclaw") {
        return { isFile: () => true } as fs.Stats;
      }
      throw new Error("File not found");
    });

    const result = resolveBonjourCliPath({
      cwd: "/cwd",
      statSync: mockStatSync,
    });
    expect(result).toBe("/cwd/bin/openclaw");
  });

  it("should return undefined when no cli is found", () => {
    const mockStatSync = vi.fn(() => {
      throw new Error("File not found");
    });

    const result = resolveBonjourCliPath({
      env: {},
      cwd: "/cwd",
      statSync: mockStatSync,
    });
    expect(result).toBeUndefined();
  });

  it("should prioritize env path over other options", () => {
    const mockStatSync = vi.fn(() => {
      return { isFile: () => true } as fs.Stats;
    });

    const result = resolveBonjourCliPath({
      env: { OPENCLAW_CLI_PATH: "/env/path/openclaw" },
      execPath: "/exec/dir/node",
      argv: ["node", "/argv/path/openclaw"],
      cwd: "/cwd",
      statSync: mockStatSync,
    });
    expect(result).toBe("/env/path/openclaw");
  });

  it("should handle statSync errors gracefully", () => {
    const mockStatSync = vi.fn(() => {
      throw new Error("Permission denied");
    });

    const result = resolveBonjourCliPath({
      cwd: "/cwd",
      statSync: mockStatSync,
    });
    expect(result).toBeUndefined();
  });
});

describe("resolveTailnetDnsHint", () => {
  it("should return env value when OPENCLAW_TAILNET_DNS is set", async () => {
    const result = await resolveTailnetDnsHint({
      env: { OPENCLAW_TAILNET_DNS: "my-tailnet.ts.net" },
    });
    expect(result).toBe("my-tailnet.ts.net");
  });

  it("should trim trailing dot from env value", async () => {
    const result = await resolveTailnetDnsHint({
      env: { OPENCLAW_TAILNET_DNS: "my-tailnet.ts.net." },
    });
    expect(result).toBe("my-tailnet.ts.net");
  });

  it("should trim whitespace from env value", async () => {
    const result = await resolveTailnetDnsHint({
      env: { OPENCLAW_TAILNET_DNS: "  my-tailnet.ts.net  " },
    });
    expect(result).toBe("my-tailnet.ts.net");
  });

  it("should return undefined when enabled is false", async () => {
    const result = await resolveTailnetDnsHint({
      env: {},
      enabled: false,
    });
    expect(result).toBeUndefined();
  });

  it("should return undefined for empty env value", async () => {
    const result = await resolveTailnetDnsHint({
      env: { OPENCLAW_TAILNET_DNS: "" },
    });
    expect(result).toBeUndefined();
  });

  it("should return undefined for whitespace-only env value", async () => {
    const result = await resolveTailnetDnsHint({
      env: { OPENCLAW_TAILNET_DNS: "   " },
    });
    expect(result).toBeUndefined();
  });

  it("should call exec when env is not set", async () => {
    const mockExec = vi.fn().mockResolvedValue("tailnet-hostname.ts.net");
    
    const result = await resolveTailnetDnsHint({
      env: {},
      exec: mockExec,
    });
    
    expect(mockExec).toHaveBeenCalled();
    expect(result).toBe("tailnet-hostname.ts.net");
  });

  it("should return undefined when exec fails", async () => {
    const mockExec = vi.fn().mockRejectedValue(new Error("Command failed"));
    
    const result = await resolveTailnetDnsHint({
      env: {},
      exec: mockExec,
    });
    
    expect(result).toBeUndefined();
  });

  it("should handle exec timeout gracefully", async () => {
    const mockExec = vi.fn().mockRejectedValue(new Error("Timeout"));
    
    const result = await resolveTailnetDnsHint({
      env: {},
      exec: mockExec,
    });
    
    expect(result).toBeUndefined();
  });
});
