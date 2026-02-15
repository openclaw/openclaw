import { describe, expect, it } from "vitest";
import {
  applyOutputCsp,
  resolveChannelOutputRules,
  type OutputCspRuleId,
} from "./output-policy.js";

describe("applyOutputCsp", () => {
  it("returns text unchanged when no rules are provided", () => {
    const result = applyOutputCsp("Hello world", []);
    expect(result.text).toBe("Hello world");
    expect(result.strippedRules).toEqual([]);
  });

  it("applies multiple rules", () => {
    const text = "Visit https://evil.com and check /home/user/secret.txt";
    const result = applyOutputCsp(text, ["no-external-urls", "no-file-paths"]);
    expect(result.text).toBe("Visit [URL redacted] and check [path redacted]");
    expect(result.strippedRules).toHaveLength(2);
    expect(result.strippedRules[0]!.ruleId).toBe("no-external-urls");
    expect(result.strippedRules[1]!.ruleId).toBe("no-file-paths");
  });

  describe("no-external-urls", () => {
    it("redacts external URLs", () => {
      const result = applyOutputCsp("Go to https://example.com/path", ["no-external-urls"]);
      expect(result.text).toBe("Go to [URL redacted]");
      expect(result.strippedRules[0]!.matches).toEqual(["https://example.com/path"]);
    });

    it("does NOT match localhost", () => {
      const result = applyOutputCsp("Visit http://localhost:3000/api", ["no-external-urls"]);
      expect(result.text).toBe("Visit http://localhost:3000/api");
      expect(result.strippedRules).toEqual([]);
    });

    it("does NOT match 127.0.0.1", () => {
      const result = applyOutputCsp("Visit http://127.0.0.1:8080", ["no-external-urls"]);
      expect(result.text).toBe("Visit http://127.0.0.1:8080");
      expect(result.strippedRules).toEqual([]);
    });

    it("does NOT match RFC 1918 addresses in URLs", () => {
      const texts = ["http://10.0.0.1/admin", "http://172.16.0.1/api", "http://192.168.1.1/config"];
      for (const text of texts) {
        const result = applyOutputCsp(text, ["no-external-urls"]);
        expect(result.strippedRules).toEqual([]);
      }
    });
  });

  describe("no-file-paths", () => {
    it("redacts Unix paths", () => {
      const result = applyOutputCsp("File at /home/user/data.txt", ["no-file-paths"]);
      expect(result.text).toBe("File at [path redacted]");
    });

    it("redacts Windows paths", () => {
      const result = applyOutputCsp("File at C:\\Users\\admin\\secret.txt", ["no-file-paths"]);
      expect(result.text).toBe("File at [path redacted]");
    });

    it("matches various Unix directories", () => {
      const dirs = ["/tmp/file", "/var/log/app.log", "/etc/passwd", "/opt/app/config"];
      for (const path of dirs) {
        const result = applyOutputCsp(`See ${path}`, ["no-file-paths"]);
        expect(result.text).toBe("See [path redacted]");
      }
    });
  });

  describe("no-code-blocks", () => {
    it("redacts fenced code blocks without language tag", () => {
      const result = applyOutputCsp("Here:\n```\nconst x = 1;\n```\nDone", ["no-code-blocks"]);
      expect(result.text).toBe("Here:\n[code block redacted]\nDone");
    });

    it("redacts fenced code blocks with language tag", () => {
      const result = applyOutputCsp("Example:\n```typescript\nconst x: number = 1;\n```\nEnd", [
        "no-code-blocks",
      ]);
      expect(result.text).toBe("Example:\n[code block redacted]\nEnd");
    });
  });

  describe("no-system-info", () => {
    it("redacts kernel version strings", () => {
      const result = applyOutputCsp("Running Linux server 5.15.0-generic #1 SMP x86_64", [
        "no-system-info",
      ]);
      expect(result.text).toContain("[system info redacted]");
      expect(result.strippedRules).toHaveLength(1);
    });

    it("redacts environment variable dumps", () => {
      const text = "Config:\nHOME=/home/user\nPATH=/usr/bin\nSHELL=/bin/bash";
      const result = applyOutputCsp(text, ["no-system-info"]);
      expect(result.text).toContain("[system info redacted]");
    });
  });

  describe("no-api-keys", () => {
    it("redacts sk- prefixed keys", () => {
      const result = applyOutputCsp("Key: sk-abcdefghijklmnopqrstuvwxyz", ["no-api-keys"]);
      expect(result.text).toBe("Key: [key redacted]");
    });

    it("redacts Bearer tokens", () => {
      const result = applyOutputCsp(
        "Auth: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
        ["no-api-keys"],
      );
      expect(result.text).toContain("[key redacted]");
    });

    it("redacts AWS access keys", () => {
      const result = applyOutputCsp("AWS key: AKIAIOSFODNN7EXAMPLE", ["no-api-keys"]);
      expect(result.text).toBe("AWS key: [key redacted]");
    });

    it("redacts pk_live/pk_test keys", () => {
      const result = applyOutputCsp("Stripe: pk_live_abcdefghijklmnopqrstuvwxyz", ["no-api-keys"]);
      expect(result.text).toBe("Stripe: [key redacted]");
    });
  });

  describe("no-internal-ips", () => {
    it("redacts RFC 1918 IPs", () => {
      const result = applyOutputCsp("Server at 192.168.1.100 port 8080", ["no-internal-ips"]);
      expect(result.text).toBe("Server at [IP redacted] port 8080");
    });

    it("redacts 10.x IPs", () => {
      const result = applyOutputCsp("Connect to 10.0.0.5", ["no-internal-ips"]);
      expect(result.text).toBe("Connect to [IP redacted]");
    });

    it("redacts 172.16-31.x IPs", () => {
      const result = applyOutputCsp("Host: 172.20.0.1", ["no-internal-ips"]);
      expect(result.text).toBe("Host: [IP redacted]");
    });
  });
});

describe("resolveChannelOutputRules", () => {
  it("returns channel-specific rules when configured", () => {
    const rules = resolveChannelOutputRules("telegram", {
      defaultRules: ["no-external-urls"],
      channels: { telegram: { rules: ["no-file-paths", "no-api-keys"] } },
    });
    expect(rules).toEqual(["no-file-paths", "no-api-keys"]);
  });

  it("falls back to defaultRules when channel not configured", () => {
    const rules = resolveChannelOutputRules("discord", {
      defaultRules: ["no-external-urls", "no-api-keys"],
      channels: { telegram: { rules: ["no-file-paths"] } },
    });
    expect(rules).toEqual(["no-external-urls", "no-api-keys"]);
  });

  it("returns empty array when no config", () => {
    const rules = resolveChannelOutputRules("telegram", {});
    expect(rules).toEqual([]);
  });

  it("resolves channel names case-insensitively", () => {
    const rules = resolveChannelOutputRules("Telegram", {
      channels: { telegram: { rules: ["no-api-keys"] } },
    });
    expect(rules).toEqual(["no-api-keys"]);
  });
});
