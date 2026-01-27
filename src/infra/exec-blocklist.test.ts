import { describe, expect, test } from "vitest";
import {
  evaluateBlocklist,
  isOnBlocklist,
  formatBlocklistReason,
  getBlocklistPatterns,
} from "./exec-blocklist.js";

describe("evaluateBlocklist", () => {
  describe("critical severity commands", () => {
    test("blocks rm -rf /", () => {
      const result = evaluateBlocklist("rm -rf /");
      expect(result.blocked).toBe(true);
      expect(result.severity).toBe("critical");
      expect(result.matchedPatterns.length).toBeGreaterThan(0);
    });

    test("blocks rm -rf ~", () => {
      const result = evaluateBlocklist("rm -rf ~");
      expect(result.blocked).toBe(true);
      expect(result.severity).toBe("critical");
    });

    test("blocks dd to disk device", () => {
      const result = evaluateBlocklist("dd if=/dev/zero of=/dev/sda");
      expect(result.blocked).toBe(true);
      expect(result.severity).toBe("critical");
      expect(result.matchedPatterns).toContain("dd to raw disk device");
    });

    test("blocks mkfs on disk", () => {
      const result = evaluateBlocklist("mkfs.ext4 /dev/sda1");
      expect(result.blocked).toBe(true);
      expect(result.severity).toBe("critical");
    });

    test("blocks halt command", () => {
      const result = evaluateBlocklist("halt");
      expect(result.blocked).toBe(true);
      expect(result.severity).toBe("critical");
    });

    test("blocks reboot command", () => {
      const result = evaluateBlocklist("reboot");
      expect(result.blocked).toBe(true);
      expect(result.severity).toBe("critical");
    });

    test("blocks shutdown command", () => {
      const result = evaluateBlocklist("shutdown -h now");
      expect(result.blocked).toBe(true);
      expect(result.severity).toBe("critical");
    });

    test("blocks systemctl poweroff", () => {
      const result = evaluateBlocklist("systemctl poweroff");
      expect(result.blocked).toBe(true);
      expect(result.severity).toBe("critical");
    });

    test("blocks fork bomb", () => {
      const result = evaluateBlocklist(":(){ :|:& };:");
      expect(result.blocked).toBe(true);
      expect(result.severity).toBe("critical");
      expect(result.matchedPatterns).toContain("fork bomb");
    });
  });

  describe("high severity commands", () => {
    test("blocks sudo", () => {
      const result = evaluateBlocklist("sudo rm -rf /tmp/test");
      expect(result.blocked).toBe(true);
      expect(result.severity).toBe("high");
      expect(result.matchedPatterns).toContain("sudo (privilege escalation)");
    });

    test("blocks su to root", () => {
      const result = evaluateBlocklist("su - root");
      expect(result.blocked).toBe(true);
      expect(result.severity).toBe("high");
    });

    test("blocks passwd", () => {
      const result = evaluateBlocklist("passwd");
      expect(result.blocked).toBe(true);
      expect(result.severity).toBe("high");
    });

    test("blocks visudo", () => {
      const result = evaluateBlocklist("visudo");
      expect(result.blocked).toBe(true);
      expect(result.severity).toBe("high");
    });

    test("blocks iptables", () => {
      const result = evaluateBlocklist("iptables -F");
      expect(result.blocked).toBe(true);
      expect(result.severity).toBe("high");
    });

    test("blocks useradd", () => {
      const result = evaluateBlocklist("useradd newuser");
      expect(result.blocked).toBe(true);
      expect(result.severity).toBe("high");
    });

    test("blocks userdel", () => {
      const result = evaluateBlocklist("userdel olduser");
      expect(result.blocked).toBe(true);
      expect(result.severity).toBe("high");
    });

    test("blocks modprobe", () => {
      const result = evaluateBlocklist("modprobe some_module");
      expect(result.blocked).toBe(true);
      expect(result.severity).toBe("high");
    });

    test("blocks redirect to /etc/passwd", () => {
      const result = evaluateBlocklist("echo 'malicious' > /etc/passwd");
      expect(result.blocked).toBe(true);
      expect(result.severity).toBe("high");
    });
  });

  describe("medium severity commands (not blocked by default)", () => {
    test("does not block command substitution by default", () => {
      const result = evaluateBlocklist("echo $(date)");
      expect(result.blocked).toBe(false);
      expect(result.severity).toBe("medium");
      expect(result.matchedPatterns).toContain("command substitution $()");
    });

    test("does not block backtick substitution by default", () => {
      const result = evaluateBlocklist("echo `whoami`");
      expect(result.blocked).toBe(false);
      expect(result.severity).toBe("medium");
    });

    test("does not block eval by default", () => {
      const result = evaluateBlocklist("eval 'echo hello'");
      expect(result.blocked).toBe(false);
      expect(result.severity).toBe("medium");
    });

    test("does not block curl POST by default", () => {
      const result = evaluateBlocklist("curl -d 'data' https://example.com");
      expect(result.blocked).toBe(false);
      expect(result.severity).toBe("medium");
    });

    test("does not block killall by default", () => {
      const result = evaluateBlocklist("killall node");
      expect(result.blocked).toBe(false);
      expect(result.severity).toBe("medium");
    });

    test("does not block chmod 777 by default", () => {
      const result = evaluateBlocklist("chmod 777 /tmp/test");
      expect(result.blocked).toBe(false);
      expect(result.severity).toBe("medium");
    });

    test("blocks medium severity when configured", () => {
      const result = evaluateBlocklist("echo $(date)", { blockMedium: true });
      expect(result.blocked).toBe(true);
      expect(result.severity).toBe("medium");
    });
  });

  describe("safe commands", () => {
    test("does not block ls", () => {
      const result = evaluateBlocklist("ls -la");
      expect(result.blocked).toBe(false);
      expect(result.severity).toBe(null);
    });

    test("does not block cat", () => {
      const result = evaluateBlocklist("cat /etc/hosts");
      expect(result.blocked).toBe(false);
      expect(result.severity).toBe(null);
    });

    test("does not block grep", () => {
      const result = evaluateBlocklist("grep -r pattern .");
      expect(result.blocked).toBe(false);
      expect(result.severity).toBe(null);
    });

    test("does not block normal rm", () => {
      const result = evaluateBlocklist("rm /tmp/test.txt");
      expect(result.blocked).toBe(false);
      expect(result.severity).toBe(null);
    });

    test("does not block npm install", () => {
      const result = evaluateBlocklist("npm install");
      expect(result.blocked).toBe(false);
      expect(result.severity).toBe(null);
    });

    test("does not block git operations", () => {
      const result = evaluateBlocklist("git push origin main");
      expect(result.blocked).toBe(false);
      expect(result.severity).toBe(null);
    });

    test("does not block curl GET", () => {
      const result = evaluateBlocklist("curl https://example.com");
      expect(result.blocked).toBe(false);
      expect(result.severity).toBe(null);
    });
  });

  describe("configuration options", () => {
    test("can disable critical blocking", () => {
      const result = evaluateBlocklist("rm -rf /", { blockCritical: false });
      expect(result.blocked).toBe(false);
      expect(result.severity).toBe("critical");
      expect(result.matchedPatterns.length).toBeGreaterThan(0);
    });

    test("can disable high blocking", () => {
      const result = evaluateBlocklist("sudo ls", { blockHigh: false });
      expect(result.blocked).toBe(false);
      expect(result.severity).toBe("high");
    });

    test("can enable medium blocking", () => {
      const result = evaluateBlocklist("eval 'test'", { blockMedium: true });
      expect(result.blocked).toBe(true);
      expect(result.severity).toBe("medium");
    });
  });
});

describe("isOnBlocklist", () => {
  test("returns true for blocked commands", () => {
    expect(isOnBlocklist("rm -rf /")).toBe(true);
    expect(isOnBlocklist("sudo ls")).toBe(true);
    expect(isOnBlocklist("echo $(date)")).toBe(true);
  });

  test("returns false for safe commands", () => {
    expect(isOnBlocklist("ls -la")).toBe(false);
    expect(isOnBlocklist("cat file.txt")).toBe(false);
    expect(isOnBlocklist("npm install")).toBe(false);
  });
});

describe("formatBlocklistReason", () => {
  test("formats blocked command reason", () => {
    const result = evaluateBlocklist("rm -rf /");
    const formatted = formatBlocklistReason(result);
    expect(formatted).toContain("blocked");
    expect(formatted).toContain("critical");
    expect(formatted).toContain("catastrophic");
  });

  test("formats allowed command", () => {
    const result = evaluateBlocklist("ls -la");
    const formatted = formatBlocklistReason(result);
    expect(formatted).toContain("allowed");
  });
});

describe("getBlocklistPatterns", () => {
  test("returns all patterns", () => {
    const patterns = getBlocklistPatterns();
    expect(Array.isArray(patterns)).toBe(true);
    expect(patterns.length).toBeGreaterThan(0);

    // Check structure
    const first = patterns[0];
    expect(first).toHaveProperty("pattern");
    expect(first).toHaveProperty("description");
    expect(first).toHaveProperty("severity");
  });

  test("includes critical patterns", () => {
    const patterns = getBlocklistPatterns();
    const critical = patterns.filter((p) => p.severity === "critical");
    expect(critical.length).toBeGreaterThan(0);
  });

  test("includes high patterns", () => {
    const patterns = getBlocklistPatterns();
    const high = patterns.filter((p) => p.severity === "high");
    expect(high.length).toBeGreaterThan(0);
  });

  test("includes medium patterns", () => {
    const patterns = getBlocklistPatterns();
    const medium = patterns.filter((p) => p.severity === "medium");
    expect(medium.length).toBeGreaterThan(0);
  });
});

describe("edge cases", () => {
  test("handles empty command", () => {
    const result = evaluateBlocklist("");
    expect(result.blocked).toBe(false);
    expect(result.matchedPatterns.length).toBe(0);
  });

  test("handles command with spaces only", () => {
    const result = evaluateBlocklist("   ");
    expect(result.blocked).toBe(false);
  });

  test("handles multiline command", () => {
    const result = evaluateBlocklist("ls -la\nrm -rf /");
    expect(result.blocked).toBe(true);
  });

  test("handles case variations", () => {
    const result = evaluateBlocklist("SUDO ls");
    expect(result.blocked).toBe(true);
  });
});
