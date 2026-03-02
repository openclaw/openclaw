import { describe, expect, it, vi } from "vitest";
import { collectUfwFindings } from "./audit-ufw.js";

describe("collectUfwFindings", () => {
  it("returns no findings on non-Linux", async () => {
    expect(await collectUfwFindings({ platform: "darwin" })).toEqual([]);
    expect(await collectUfwFindings({ platform: "win32" })).toEqual([]);
  });

  it("returns no findings when ufw binary not in sbin (Linux)", async () => {
    const execUfwFn = vi.fn();
    const out = await collectUfwFindings({
      platform: "linux",
      execUfwFn,
      resolveUfwBinary: () => null,
    });
    expect(out).toEqual([]);
    expect(execUfwFn).not.toHaveBeenCalled();
  });

  it("reports UFW active when status succeeds with Status: active", async () => {
    const execUfwFn = vi.fn().mockResolvedValue({
      stdout:
        "Status: active\n\nTo                         Action      From\n--                         ------      ----\n22/tcp                     ALLOW       Anywhere",
      stderr: "",
    });
    const out = await collectUfwFindings({
      platform: "linux",
      execUfwFn,
      resolveUfwBinary: () => "/usr/sbin/ufw",
      readUfwConfEnabled: async () => null,
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      checkId: "host.ufw",
      severity: "info",
      title: "UFW active",
      detail: "Host firewall (ufw) is active.",
    });
    expect(out[0]?.remediation).toBeUndefined();
  });

  it("reports UFW inactive when status succeeds without active", async () => {
    const execUfwFn = vi.fn().mockResolvedValue({
      stdout: "Status: inactive\n",
      stderr: "",
    });
    const out = await collectUfwFindings({
      platform: "linux",
      execUfwFn,
      resolveUfwBinary: () => "/usr/sbin/ufw",
      readUfwConfEnabled: async () => null,
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      checkId: "host.ufw",
      severity: "info",
      title: "UFW inactive",
      detail: "Host firewall (ufw) is installed but inactive.",
      remediation: "Consider enabling: sudo ufw enable (ensure SSH is allowed first).",
    });
  });

  it("reports UFW status unknown with config hint when status fails and ENABLED=yes", async () => {
    const execUfwFn = vi.fn().mockRejectedValue(new Error("Permission denied"));
    const out = await collectUfwFindings({
      platform: "linux",
      execUfwFn,
      resolveUfwBinary: () => "/usr/sbin/ufw",
      readUfwConfEnabled: async () => true,
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      checkId: "host.ufw",
      severity: "info",
      title: "UFW status unknown",
    });
    expect(out[0].detail).toContain("UFW enabled (per /etc/ufw/ufw.conf)");
    expect(out[0].detail).toContain("status check requires sudo");
  });

  it("reports UFW status unknown with sbin hint when status fails and config not ENABLED=yes", async () => {
    const execUfwFn = vi.fn().mockRejectedValue(new Error("Permission denied"));
    const out = await collectUfwFindings({
      platform: "linux",
      execUfwFn,
      resolveUfwBinary: () => "/usr/sbin/ufw",
      readUfwConfEnabled: async () => false,
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      checkId: "host.ufw",
      severity: "info",
      title: "UFW status unknown",
    });
    expect(out[0].detail).toContain("UFW installed (binary at /usr/sbin/ufw)");
    expect(out[0].remediation).toContain("sudo ufw status");
  });

  it("reports UFW status unknown when ufw runs but stderr contains 'not found' (e.g. dependency)", async () => {
    const execUfwFn = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("Command failed"), { stderr: "iptables not found", stdout: "" }),
      );
    const out = await collectUfwFindings({
      platform: "linux",
      execUfwFn,
      resolveUfwBinary: () => "/usr/sbin/ufw",
      readUfwConfEnabled: async () => null,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe("UFW status unknown");
  });

  it("reports UFW status unknown when err message contains 'command not found' from child stderr", async () => {
    const execUfwFn = vi
      .fn()
      .mockRejectedValue(new Error("Command failed: iptables: command not found"));
    const out = await collectUfwFindings({
      platform: "linux",
      execUfwFn,
      resolveUfwBinary: () => "/usr/sbin/ufw",
      readUfwConfEnabled: async () => null,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe("UFW status unknown");
  });
});
