import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import {
  checkCommand,
  checkNodeVersion,
  checkPnpmVersion,
  parseVersion,
  compareVersions,
  parseEnvExample,
  parseEnvFile,
  checkEnvFileExists,
  checkEnvExampleExists,
  validateEnvFile,
} from "./check.js";

describe("check command", () => {
  it("should run installation checks and return results", async () => {
    const logs: string[] = [];
    const errors: string[] = [];

    const mockRuntime: RuntimeEnv = {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => errors.push(msg),
      debug: () => {},
      warn: () => {},
      exit: (_code?: number) => {},
      channelLog: () => {},
    };

    await checkCommand(mockRuntime, { json: true });

    // Should output JSON results
    expect(logs.length).toBe(1);
    const result = JSON.parse(logs[0]);
    expect(typeof result.ok).toBe("boolean");
    expect(Array.isArray(result.checks)).toBe(true);
    expect(result.checks.length).toBeGreaterThan(0);

    // Should have expected check IDs
    const checkIds = result.checks.map((c: { id: string }) => c.id);
    expect(checkIds).toContain("node-version");
    expect(checkIds).toContain("pnpm-version");
    expect(checkIds).toContain("env-exists");
    expect(checkIds).toContain("env-valid");
    expect(checkIds).toContain("config-exists");
    expect(checkIds).toContain("config-valid");
    expect(checkIds).toContain("gateway-mode");
    expect(checkIds).toContain("package-root");
  });

  it("should output JSON when json option is true", async () => {
    const logs: string[] = [];

    const mockRuntime: RuntimeEnv = {
      log: (msg: string) => logs.push(msg),
      error: () => {},
      debug: () => {},
      warn: () => {},
      exit: () => {},
      channelLog: () => {},
    };

    await checkCommand(mockRuntime, { json: true });

    expect(logs.length).toBe(1);
    const result = JSON.parse(logs[0]);
    expect(typeof result.ok).toBe("boolean");
    expect(Array.isArray(result.checks)).toBe(true);
  });

  it("should handle non-interactive mode", async () => {
    const logs: string[] = [];

    const mockRuntime: RuntimeEnv = {
      log: (msg: string) => logs.push(msg),
      error: () => {},
      debug: () => {},
      warn: () => {},
      exit: () => {},
      channelLog: () => {},
    };

    await checkCommand(mockRuntime, { json: true, nonInteractive: true });

    // Should still output results
    expect(logs.length).toBe(1);
    const result = JSON.parse(logs[0]);
    expect(typeof result.ok).toBe("boolean");
  });
});

describe("parseVersion", () => {
  it("should parse valid version strings", () => {
    expect(parseVersion("22.12.0")).toEqual([22, 12, 0]);
    expect(parseVersion("v22.12.0")).toEqual([22, 12, 0]);
    expect(parseVersion("10.23.0")).toEqual([10, 23, 0]);
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
  });

  it("should return null for invalid version strings", () => {
    expect(parseVersion("invalid")).toBeNull();
    expect(parseVersion("a.b.c")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("should return 0 for equal versions", () => {
    expect(compareVersions([22, 12, 0], [22, 12, 0])).toBe(0);
    expect(compareVersions([1, 2, 3], [1, 2, 3])).toBe(0);
  });

  it("should return positive when first version is greater", () => {
    expect(compareVersions([23, 0, 0], [22, 12, 0])).toBeGreaterThan(0);
    expect(compareVersions([22, 13, 0], [22, 12, 0])).toBeGreaterThan(0);
    expect(compareVersions([22, 12, 1], [22, 12, 0])).toBeGreaterThan(0);
  });

  it("should return negative when first version is smaller", () => {
    expect(compareVersions([21, 0, 0], [22, 12, 0])).toBeLessThan(0);
    expect(compareVersions([22, 11, 0], [22, 12, 0])).toBeLessThan(0);
    expect(compareVersions([22, 12, 0], [22, 12, 1])).toBeLessThan(0);
  });

  it("should handle different length versions", () => {
    expect(compareVersions([22, 12], [22, 12, 0])).toBe(0);
    expect(compareVersions([22, 12, 0], [22, 12])).toBe(0);
    expect(compareVersions([22, 12, 0, 1], [22, 12, 0])).toBeGreaterThan(0);
  });
});

describe("checkNodeVersion", () => {
  it("should return current Node.js version", () => {
    const result = checkNodeVersion();
    expect(typeof result.ok).toBe("boolean");
    expect(result.current).toBe(process.version);
    expect(result.required).toBe("22.12.0");
  });
});

describe("checkPnpmVersion", () => {
  it("should check pnpm version", () => {
    const result = checkPnpmVersion();
    // Should have ok property
    expect(typeof result.ok).toBe("boolean");
    // Should have required version
    expect(result.required).toBe("10.23.0");

    if (result.ok) {
      // If check passes, we should have a current version
      expect(result.current).toBeTruthy();
      expect(typeof result.current).toBe("string");
    }
  });
});

describe("parseEnvExample", () => {
  it("should parse variable names from .env.example content", () => {
    const content = `
# This is a comment
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Another comment
TELEGRAM_BOT_TOKEN=123456:ABC
`;
    const result = parseEnvExample(content);
    expect(result).toEqual(["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN"]);
  });

  it("should handle empty content", () => {
    expect(parseEnvExample("")).toEqual([]);
  });

  it("should handle content with only comments", () => {
    const content = `
# Comment 1
# Comment 2
`;
    expect(parseEnvExample(content)).toEqual([]);
  });

  it("should handle variable without value", () => {
    const content = `OPENAI_API_KEY=`;
    expect(parseEnvExample(content)).toEqual(["OPENAI_API_KEY"]);
  });
});

describe("parseEnvFile", () => {
  it("should parse variable names that have values", () => {
    const content = `
# This is a comment
OPENAI_API_KEY=sk-abc123
ANTHROPIC_API_KEY=sk-ant-xyz
TELEGRAM_BOT_TOKEN=
`;
    const result = parseEnvFile(content);
    expect(result).toEqual(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
  });

  it("should not include variables with empty values", () => {
    const content = `
OPENAI_API_KEY=sk-abc123
EMPTY_VAR=
`;
    const result = parseEnvFile(content);
    expect(result).toEqual(["OPENAI_API_KEY"]);
  });

  it("should handle inline comments", () => {
    const content = `
OPENAI_API_KEY=sk-abc123 # this is the key
`;
    const result = parseEnvFile(content);
    expect(result).toEqual(["OPENAI_API_KEY"]);
  });

  it("should handle empty content", () => {
    expect(parseEnvFile("")).toEqual([]);
  });
});

describe("checkEnvFileExists", () => {
  it("should return false when .env does not exist", () => {
    const result = checkEnvFileExists("/nonexistent/path");
    expect(result.ok).toBe(false);
    expect(result.path).toBe("/nonexistent/path/.env");
  });

  it("should return true when .env exists", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-test-"));
    fs.writeFileSync(path.join(tmpDir, ".env"), "TEST=value\n");

    const result = checkEnvFileExists(tmpDir);
    expect(result.ok).toBe(true);
    expect(result.path).toBe(path.join(tmpDir, ".env"));

    fs.unlinkSync(path.join(tmpDir, ".env"));
    fs.rmdirSync(tmpDir);
  });
});

describe("checkEnvExampleExists", () => {
  it("should return false when .env.example does not exist", () => {
    const result = checkEnvExampleExists("/nonexistent/path");
    expect(result.ok).toBe(false);
    expect(result.path).toBe("/nonexistent/path/.env.example");
  });

  it("should return true when .env.example exists", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-test-"));
    fs.writeFileSync(path.join(tmpDir, ".env.example"), "TEST=\n");

    const result = checkEnvExampleExists(tmpDir);
    expect(result.ok).toBe(true);
    expect(result.path).toBe(path.join(tmpDir, ".env.example"));

    fs.unlinkSync(path.join(tmpDir, ".env.example"));
    fs.rmdirSync(tmpDir);
  });
});

describe("validateEnvFile", () => {
  it("should return ok=true when both files are missing", () => {
    const result = validateEnvFile("/nonexistent/path");
    expect(result.ok).toBe(false);
    expect(result.envExists).toBe(false);
    expect(result.exampleExists).toBe(false);
  });

  it("should return ok=true when .env.example is missing", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-test-"));
    fs.writeFileSync(path.join(tmpDir, ".env"), "TEST=value\n");

    const result = validateEnvFile(tmpDir);
    expect(result.ok).toBe(true); // Not a failure - can't validate without example
    expect(result.envExists).toBe(true);
    expect(result.exampleExists).toBe(false);

    fs.unlinkSync(path.join(tmpDir, ".env"));
    fs.rmdirSync(tmpDir);
  });

  it("should return ok=false when .env is missing but .env.example exists", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-test-"));
    fs.writeFileSync(path.join(tmpDir, ".env.example"), "OPENAI_API_KEY=\nANTHROPIC_API_KEY=\n");

    const result = validateEnvFile(tmpDir);
    expect(result.ok).toBe(false);
    expect(result.envExists).toBe(false);
    expect(result.exampleExists).toBe(true);
    expect(result.missing).toContain("OPENAI_API_KEY");
    expect(result.missing).toContain("ANTHROPIC_API_KEY");

    fs.unlinkSync(path.join(tmpDir, ".env.example"));
    fs.rmdirSync(tmpDir);
  });

  it("should return ok=true when all required variables are present", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-test-"));
    fs.writeFileSync(path.join(tmpDir, ".env.example"), "OPENAI_API_KEY=\nANTHROPIC_API_KEY=\n");
    fs.writeFileSync(
      path.join(tmpDir, ".env"),
      "OPENAI_API_KEY=sk-abc123\nANTHROPIC_API_KEY=sk-ant-xyz\n",
    );

    const result = validateEnvFile(tmpDir);
    expect(result.ok).toBe(true);
    expect(result.envExists).toBe(true);
    expect(result.exampleExists).toBe(true);
    expect(result.missing).toEqual([]);

    fs.unlinkSync(path.join(tmpDir, ".env"));
    fs.unlinkSync(path.join(tmpDir, ".env.example"));
    fs.rmdirSync(tmpDir);
  });

  it("should report missing variables when some are not set", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-test-"));
    fs.writeFileSync(
      path.join(tmpDir, ".env.example"),
      "OPENAI_API_KEY=\nANTHROPIC_API_KEY=\nTELEGRAM_TOKEN=\n",
    );
    fs.writeFileSync(path.join(tmpDir, ".env"), "OPENAI_API_KEY=sk-abc123\n");

    const result = validateEnvFile(tmpDir);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("ANTHROPIC_API_KEY");
    expect(result.missing).toContain("TELEGRAM_TOKEN");
    expect(result.missing).not.toContain("OPENAI_API_KEY");

    fs.unlinkSync(path.join(tmpDir, ".env"));
    fs.unlinkSync(path.join(tmpDir, ".env.example"));
    fs.rmdirSync(tmpDir);
  });

  it("should not count variables with empty values as present", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-test-"));
    fs.writeFileSync(path.join(tmpDir, ".env.example"), "OPENAI_API_KEY=\n");
    fs.writeFileSync(path.join(tmpDir, ".env"), "OPENAI_API_KEY=\n");

    const result = validateEnvFile(tmpDir);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("OPENAI_API_KEY");

    fs.unlinkSync(path.join(tmpDir, ".env"));
    fs.unlinkSync(path.join(tmpDir, ".env.example"));
    fs.rmdirSync(tmpDir);
  });
});
