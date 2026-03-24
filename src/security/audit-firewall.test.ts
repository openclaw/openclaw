import * as nodeChildProcess from "node:child_process";
import * as nodeFs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock fs and child_process before importing the module under test.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    accessSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

const accessSyncMock = vi.mocked(nodeFs.accessSync);
const readFileSyncMock = vi.mocked(nodeFs.readFileSync);
const spawnSyncMock = vi.mocked(nodeChildProcess.spawnSync);

// Import after mocks are set up.
import {
  collectFirewallFindings,
  detectUfwFirewall,
  locateUfw,
  queryUfwStatus,
  readUfwConfEnabled,
} from "./audit-firewall.js";

afterEach(() => {
  vi.resetAllMocks();
});

describe("locateUfw", () => {
  it("returns path from which when ufw is on PATH", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: Buffer.from("/usr/bin/ufw\n"),
      stderr: Buffer.alloc(0),
      pid: 1,
      output: [],
      signal: null,
    });

    const result = locateUfw({ PATH: "/usr/bin" });
    expect(result).toEqual({ path: "/usr/bin/ufw", viaPath: true });
    expect(spawnSyncMock).toHaveBeenCalledWith("which", ["ufw"], expect.any(Object));
  });

  it("falls back to sbin paths when which fails", () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      pid: 1,
      output: [],
      signal: null,
    });
    // First candidate (/usr/sbin/ufw) is executable.
    accessSyncMock.mockImplementation((p) => {
      if (p === "/usr/sbin/ufw") {
        return;
      }
      throw new Error("ENOENT");
    });

    const result = locateUfw({ PATH: "/usr/bin" });
    expect(result).toEqual({ path: "/usr/sbin/ufw", viaPath: false });
  });

  it("tries /usr/local/sbin/ufw when earlier sbin paths are not found", () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      pid: 1,
      output: [],
      signal: null,
    });
    accessSyncMock.mockImplementation((p) => {
      if (p === "/usr/local/sbin/ufw") {
        return;
      }
      throw new Error("ENOENT");
    });

    const result = locateUfw({ PATH: "/usr/bin" });
    expect(result).toEqual({ path: "/usr/local/sbin/ufw", viaPath: false });
  });

  it("tries /sbin/ufw when /usr/sbin/ufw is not found", () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      pid: 1,
      output: [],
      signal: null,
    });
    accessSyncMock.mockImplementation((p) => {
      if (p === "/sbin/ufw") {
        return;
      }
      throw new Error("ENOENT");
    });

    const result = locateUfw({ PATH: "/usr/bin" });
    expect(result).toEqual({ path: "/sbin/ufw", viaPath: false });
  });

  it("returns null when ufw is not found anywhere", () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      pid: 1,
      output: [],
      signal: null,
    });
    accessSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(locateUfw({ PATH: "/usr/bin" })).toBeNull();
  });
});

describe("readUfwConfEnabled", () => {
  it("returns true when ENABLED=yes", () => {
    readFileSyncMock.mockReturnValue("# UFW config\nENABLED=yes\n");
    expect(readUfwConfEnabled()).toBe(true);
  });

  it("returns false when ENABLED=no", () => {
    readFileSyncMock.mockReturnValue("ENABLED=no\n");
    expect(readUfwConfEnabled()).toBe(false);
  });

  it("ignores commented-out ENABLED lines", () => {
    readFileSyncMock.mockReturnValue("# ENABLED=yes\nENABLED=no\n");
    expect(readUfwConfEnabled()).toBe(false);
  });

  it("returns null when file does not exist", () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(readUfwConfEnabled()).toBeNull();
  });

  it("ignores inline comments after the value", () => {
    readFileSyncMock.mockReturnValue("ENABLED=yes # some comment\n");
    expect(readUfwConfEnabled()).toBe(true);
  });

  it("returns null when ENABLED key is absent", () => {
    readFileSyncMock.mockReturnValue("# Some other config\nLOGLEVEL=low\n");
    expect(readUfwConfEnabled()).toBeNull();
  });
});

describe("queryUfwStatus", () => {
  it("detects active status", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: Buffer.from("Status: active\n"),
      stderr: Buffer.alloc(0),
      pid: 1,
      output: [],
      signal: null,
    });

    const result = queryUfwStatus("/usr/sbin/ufw");
    expect(result).toEqual({ active: true, statusLine: "Status: active" });
  });

  it("detects inactive status", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: Buffer.from("Status: inactive\n"),
      stderr: Buffer.alloc(0),
      pid: 1,
      output: [],
      signal: null,
    });

    const result = queryUfwStatus("/usr/sbin/ufw");
    expect(result).toEqual({ active: false, statusLine: "Status: inactive" });
  });

  it("augments PATH with sbin directories", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: Buffer.from("Status: active\n"),
      stderr: Buffer.alloc(0),
      pid: 1,
      output: [],
      signal: null,
    });

    queryUfwStatus("/usr/sbin/ufw", { PATH: "/usr/bin" });
    const spawnCall = spawnSyncMock.mock.calls[0];
    const envArg = (spawnCall[2] as { env: NodeJS.ProcessEnv }).env;
    expect(envArg.PATH).toContain("/usr/sbin");
    expect(envArg.PATH).toContain("/usr/bin");
  });

  it("returns null active when output has abnormal format", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: Buffer.from("ERROR: problem running iptables\n"),
      stderr: Buffer.alloc(0),
      pid: 1,
      output: [],
      signal: null,
    });

    const result = queryUfwStatus("/usr/sbin/ufw");
    expect(result).toEqual({ active: null, statusLine: "ERROR: problem running iptables" });
  });

  it("returns null active when command fails", () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("Permission denied\n"),
      pid: 1,
      output: [],
      signal: null,
    });

    const result = queryUfwStatus("/usr/sbin/ufw");
    expect(result).toEqual({ active: null, statusLine: null });
  });

  it("returns null active when spawn errors", () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      error: new Error("ENOENT"),
      pid: 1,
      output: [],
      signal: null,
    });

    const result = queryUfwStatus("/usr/sbin/ufw");
    expect(result).toEqual({ active: null, statusLine: null });
  });
});

describe("detectUfwFirewall", () => {
  it("detects ufw via PATH and active", () => {
    // locateUfw: which succeeds
    spawnSyncMock.mockImplementation((cmd) => {
      if (cmd === "which") {
        return {
          status: 0,
          stdout: Buffer.from("/usr/bin/ufw\n"),
          stderr: Buffer.alloc(0),
          pid: 1,
          output: [],
          signal: null,
        };
      }
      // queryUfwStatus
      return {
        status: 0,
        stdout: Buffer.from("Status: active\n"),
        stderr: Buffer.alloc(0),
        pid: 1,
        output: [],
        signal: null,
      };
    });
    readFileSyncMock.mockReturnValue("ENABLED=yes\n");

    const result = detectUfwFirewall({ PATH: "/usr/bin" });
    expect(result.ufwPath).toBe("/usr/bin/ufw");
    expect(result.foundViaPath).toBe(true);
    expect(result.active).toBe(true);
    expect(result.confEnabled).toBe(true);
  });

  it("detects ufw in sbin when not on PATH", () => {
    spawnSyncMock.mockImplementation((cmd) => {
      if (cmd === "which") {
        return {
          status: 1,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          pid: 1,
          output: [],
          signal: null,
        };
      }
      return {
        status: 0,
        stdout: Buffer.from("Status: active\n"),
        stderr: Buffer.alloc(0),
        pid: 1,
        output: [],
        signal: null,
      };
    });
    accessSyncMock.mockImplementation((p) => {
      if (p === "/usr/sbin/ufw") {
        return;
      }
      throw new Error("ENOENT");
    });
    readFileSyncMock.mockReturnValue("ENABLED=yes\n");

    const result = detectUfwFirewall({ PATH: "/usr/bin" });
    expect(result.ufwPath).toBe("/usr/sbin/ufw");
    expect(result.foundViaPath).toBe(false);
    expect(result.active).toBe(true);
  });

  it("returns conf-only info when binary not found", () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      pid: 1,
      output: [],
      signal: null,
    });
    accessSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    readFileSyncMock.mockReturnValue("ENABLED=yes\n");

    const result = detectUfwFirewall({ PATH: "/usr/bin" });
    expect(result.ufwPath).toBeNull();
    expect(result.confEnabled).toBe(true);
  });
});

describe("collectFirewallFindings", () => {
  it("returns no findings on non-linux platforms", () => {
    const findings = collectFirewallFindings({ platform: "darwin" });
    expect(findings).toHaveLength(0);
  });

  it("returns no findings on Windows", () => {
    const findings = collectFirewallFindings({ platform: "win32" });
    expect(findings).toHaveLength(0);
  });

  it("returns ufw_not_on_path finding when found in sbin", () => {
    spawnSyncMock.mockImplementation((cmd) => {
      if (cmd === "which") {
        return {
          status: 1,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          pid: 1,
          output: [],
          signal: null,
        };
      }
      return {
        status: 0,
        stdout: Buffer.from("Status: active\n"),
        stderr: Buffer.alloc(0),
        pid: 1,
        output: [],
        signal: null,
      };
    });
    accessSyncMock.mockImplementation((p) => {
      if (p === "/usr/sbin/ufw") {
        return;
      }
      throw new Error("ENOENT");
    });
    readFileSyncMock.mockReturnValue("ENABLED=yes\n");

    const findings = collectFirewallFindings({ platform: "linux" });
    const notOnPath = findings.find((f) => f.checkId === "firewall.ufw_not_on_path");
    expect(notOnPath).toBeDefined();
    expect(notOnPath!.severity).toBe("info");
    expect(notOnPath!.detail).toContain("/usr/sbin/ufw");
    expect(notOnPath!.detail).toContain("sbin fallback");
  });

  it("reports ufw_active when firewall is active", () => {
    spawnSyncMock.mockImplementation((cmd) => {
      if (cmd === "which") {
        return {
          status: 0,
          stdout: Buffer.from("/usr/sbin/ufw\n"),
          stderr: Buffer.alloc(0),
          pid: 1,
          output: [],
          signal: null,
        };
      }
      return {
        status: 0,
        stdout: Buffer.from("Status: active\n"),
        stderr: Buffer.alloc(0),
        pid: 1,
        output: [],
        signal: null,
      };
    });
    readFileSyncMock.mockReturnValue("ENABLED=yes\n");

    const findings = collectFirewallFindings({ platform: "linux" });
    const active = findings.find((f) => f.checkId === "firewall.ufw_active");
    expect(active).toBeDefined();
    expect(active!.severity).toBe("info");
  });

  it("reports ufw_inactive when firewall is not active", () => {
    spawnSyncMock.mockImplementation((cmd) => {
      if (cmd === "which") {
        return {
          status: 0,
          stdout: Buffer.from("/usr/sbin/ufw\n"),
          stderr: Buffer.alloc(0),
          pid: 1,
          output: [],
          signal: null,
        };
      }
      return {
        status: 0,
        stdout: Buffer.from("Status: inactive\n"),
        stderr: Buffer.alloc(0),
        pid: 1,
        output: [],
        signal: null,
      };
    });
    readFileSyncMock.mockReturnValue("ENABLED=no\n");

    const findings = collectFirewallFindings({ platform: "linux" });
    const inactive = findings.find((f) => f.checkId === "firewall.ufw_inactive");
    expect(inactive).toBeDefined();
    expect(inactive!.severity).toBe("warn");
    expect(inactive!.remediation).toContain("sudo ufw");
  });

  it("reports ufw_status_unknown when status cannot be determined", () => {
    spawnSyncMock.mockImplementation((cmd) => {
      if (cmd === "which") {
        return {
          status: 0,
          stdout: Buffer.from("/usr/sbin/ufw\n"),
          stderr: Buffer.alloc(0),
          pid: 1,
          output: [],
          signal: null,
        };
      }
      return {
        status: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("Permission denied\n"),
        pid: 1,
        output: [],
        signal: null,
      };
    });
    readFileSyncMock.mockReturnValue("ENABLED=yes\n");

    const findings = collectFirewallFindings({ platform: "linux" });
    const unknown = findings.find((f) => f.checkId === "firewall.ufw_status_unknown");
    expect(unknown).toBeDefined();
    expect(unknown!.detail).toContain("ENABLED=yes");
  });

  it("reports ufw_conf_only when binary not found but conf says enabled", () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      pid: 1,
      output: [],
      signal: null,
    });
    accessSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    readFileSyncMock.mockReturnValue("ENABLED=yes\n");

    const findings = collectFirewallFindings({ platform: "linux" });
    const confOnly = findings.find((f) => f.checkId === "firewall.ufw_conf_only");
    expect(confOnly).toBeDefined();
    expect(confOnly!.severity).toBe("info");
  });

  it("returns no findings when ufw is not installed at all", () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      pid: 1,
      output: [],
      signal: null,
    });
    accessSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    readFileSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const findings = collectFirewallFindings({ platform: "linux" });
    expect(findings).toHaveLength(0);
  });
});
