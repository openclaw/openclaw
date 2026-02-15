import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
// CLI command tests for `openclaw secrets` subcommands.
// These test the CLI layer — provider interactions are mocked.
// The actual implementation will be in src/commands/secrets.ts
// These imports will fail until implementation exists (TDD red phase).
import {
  secretsTestCommand,
  secretsListCommand,
  secretsSetupCommand,
  secretsMigrateCommand,
  secretsSetCommand,
} from "./secrets.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const orig = { log: console.log, error: console.error };
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  return {
    logs,
    errors,
    restore() {
      console.log = orig.log;
      console.error = orig.error;
    },
  };
}

// ---------------------------------------------------------------------------
// openclaw secrets test
// ---------------------------------------------------------------------------

describe("openclaw secrets test", () => {
  it("reports success when all refs resolve", async () => {
    const con = mockConsole();
    try {
      const exitCode = await secretsTestCommand({
        configPath: "/tmp/test-config.json",
        // Mock: all secrets resolve
        _mockProviderResult: { ok: true },
      });
      expect(exitCode).toBe(0);
      expect(con.logs.some((l) => /success|pass|ok/i.test(l))).toBe(true);
    } finally {
      con.restore();
    }
  });

  it("reports failure when a ref cannot resolve", async () => {
    const con = mockConsole();
    try {
      const exitCode = await secretsTestCommand({
        configPath: "/tmp/test-config.json",
        _mockProviderResult: { ok: false, error: "Secret not found: missing-key" },
      });
      expect(exitCode).toBe(1);
      expect(con.errors.some((l) => /fail|error/i.test(l))).toBe(true);
    } finally {
      con.restore();
    }
  });

  it("reports failure when provider is not configured", async () => {
    const con = mockConsole();
    try {
      const exitCode = await secretsTestCommand({
        configPath: "/tmp/no-secrets-config.json",
        _mockProviderResult: { ok: false, error: "No secrets providers configured" },
      });
      expect(exitCode).toBe(1);
    } finally {
      con.restore();
    }
  });

  it("reports failure when provider is unreachable", async () => {
    const con = mockConsole();
    try {
      const exitCode = await secretsTestCommand({
        configPath: "/tmp/test-config.json",
        _mockProviderResult: { ok: false, error: "Connection refused" },
      });
      expect(exitCode).toBe(1);
    } finally {
      con.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// openclaw secrets list
// ---------------------------------------------------------------------------

describe("openclaw secrets list", () => {
  it("lists configured providers and their status", async () => {
    const con = mockConsole();
    try {
      const exitCode = await secretsListCommand({
        configPath: "/tmp/test-config.json",
        _mockProviders: [{ name: "gcp", project: "my-project", status: "connected" }],
      });
      expect(exitCode).toBe(0);
      expect(con.logs.some((l) => /gcp/i.test(l))).toBe(true);
      expect(con.logs.some((l) => /connected/i.test(l))).toBe(true);
    } finally {
      con.restore();
    }
  });

  it("shows message when no providers configured", async () => {
    const con = mockConsole();
    try {
      const exitCode = await secretsListCommand({
        configPath: "/tmp/test-config.json",
        _mockProviders: [],
      });
      expect(exitCode).toBe(0);
      expect(con.logs.some((l) => /no.*provider|not configured/i.test(l))).toBe(true);
    } finally {
      con.restore();
    }
  });

  it("shows unreachable status for failed provider", async () => {
    const con = mockConsole();
    try {
      const exitCode = await secretsListCommand({
        configPath: "/tmp/test-config.json",
        _mockProviders: [{ name: "gcp", project: "my-project", status: "unreachable" }],
      });
      expect(exitCode).toBe(0);
      expect(con.logs.some((l) => /unreachable/i.test(l))).toBe(true);
    } finally {
      con.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// openclaw secrets setup
// ---------------------------------------------------------------------------

describe("openclaw secrets setup", () => {
  it("checks for gcloud CLI availability", async () => {
    const steps: string[] = [];
    const exitCode = await secretsSetupCommand({
      project: "test-project",
      yes: true,
      _mockExec: async (cmd: string) => {
        steps.push(cmd);
        if (cmd.includes("gcloud")) {
          return { stdout: "Google Cloud SDK", exitCode: 0 };
        }
        return { stdout: "", exitCode: 0 };
      },
    });
    expect(steps.some((s) => s.includes("gcloud"))).toBe(true);
  });

  it("fails if gcloud is not installed", async () => {
    const exitCode = await secretsSetupCommand({
      project: "test-project",
      yes: true,
      _mockExec: async (cmd: string) => {
        if (cmd.includes("gcloud")) {
          return { stdout: "", exitCode: 127 };
        }
        return { stdout: "", exitCode: 0 };
      },
    });
    expect(exitCode).toBe(1);
  });

  it("enables Secret Manager API", async () => {
    const steps: string[] = [];
    await secretsSetupCommand({
      project: "test-project",
      yes: true,
      _mockExec: async (cmd: string) => {
        steps.push(cmd);
        return { stdout: "", exitCode: 0 };
      },
    });
    expect(steps.some((s) => s.includes("secretmanager.googleapis.com"))).toBe(true);
  });

  it("creates service accounts for agents", async () => {
    const steps: string[] = [];
    await secretsSetupCommand({
      project: "test-project",
      agents: ["main", "chai"],
      yes: true,
      _mockExec: async (cmd: string) => {
        steps.push(cmd);
        return { stdout: "", exitCode: 0 };
      },
    });
    expect(steps.some((s) => s.includes("iam") && s.includes("openclaw-main"))).toBe(true);
    expect(steps.some((s) => s.includes("iam") && s.includes("openclaw-chai"))).toBe(true);
  });

  it("is idempotent — safe to run multiple times", async () => {
    const exitCode1 = await secretsSetupCommand({
      project: "test-project",
      yes: true,
      _mockExec: async () => ({ stdout: "already exists", exitCode: 0 }),
    });
    const exitCode2 = await secretsSetupCommand({
      project: "test-project",
      yes: true,
      _mockExec: async () => ({ stdout: "already exists", exitCode: 0 }),
    });
    expect(exitCode1).toBe(0);
    expect(exitCode2).toBe(0);
  });

  it("updates openclaw.json with secrets config", async () => {
    let writtenConfig: unknown = null;
    await secretsSetupCommand({
      project: "test-project",
      yes: true,
      _mockExec: async () => ({ stdout: "", exitCode: 0 }),
      _mockWriteConfig: (config: unknown) => {
        writtenConfig = config;
      },
    });
    expect(writtenConfig).toBeDefined();
    expect((writtenConfig as any)?.secrets?.providers?.gcp?.project).toBe("test-project");
  });
});

// ---------------------------------------------------------------------------
// openclaw secrets migrate
// ---------------------------------------------------------------------------

describe("openclaw secrets migrate", () => {
  it("scans config for sensitive values", async () => {
    const con = mockConsole();
    try {
      const exitCode = await secretsMigrateCommand({
        configPath: "/tmp/test-config.json",
        yes: true,
        _mockConfig: {
          models: { providers: { openai: { apiKey: "sk-real-key-123" } } },
          secrets: { providers: { gcp: { project: "test-project" } } },
        },
        _mockProvider: {
          setSecret: vi.fn().mockResolvedValue(undefined),
          getSecret: vi.fn().mockResolvedValue("sk-real-key-123"),
        },
      });
      expect(exitCode).toBe(0);
      // Should report found secrets
      expect(con.logs.some((l) => /found|scan|secret/i.test(l))).toBe(true);
    } finally {
      con.restore();
    }
  });

  it("uploads secrets to GCP and replaces with refs", async () => {
    const setSecret = vi.fn().mockResolvedValue(undefined);
    const getSecret = vi.fn().mockResolvedValue("sk-real-key-123");

    await secretsMigrateCommand({
      configPath: "/tmp/test-config.json",
      yes: true,
      _mockConfig: {
        models: { providers: { openai: { apiKey: "sk-real-key-123" } } },
        secrets: { providers: { gcp: { project: "test-project" } } },
      },
      _mockProvider: { setSecret, getSecret },
    });

    expect(setSecret).toHaveBeenCalled();
  });

  it("verifies all refs resolve after replacement", async () => {
    const getSecret = vi.fn().mockResolvedValue("sk-real-key-123");
    const setSecret = vi.fn().mockResolvedValue(undefined);

    const exitCode = await secretsMigrateCommand({
      configPath: "/tmp/test-config.json",
      yes: true,
      _mockConfig: {
        models: { providers: { openai: { apiKey: "sk-real-key-123" } } },
        secrets: { providers: { gcp: { project: "test-project" } } },
      },
      _mockProvider: { setSecret, getSecret },
    });

    expect(getSecret).toHaveBeenCalled();
    expect(exitCode).toBe(0);
  });

  it("does NOT purge plaintext if upload fails", async () => {
    const setSecret = vi.fn().mockRejectedValue(new Error("Upload failed"));
    let purged = false;

    const exitCode = await secretsMigrateCommand({
      configPath: "/tmp/test-config.json",
      yes: true,
      _mockConfig: {
        models: { providers: { openai: { apiKey: "sk-real-key-123" } } },
        secrets: { providers: { gcp: { project: "test-project" } } },
      },
      _mockProvider: { setSecret, getSecret: vi.fn() },
      _mockPurge: () => {
        purged = true;
      },
    });

    expect(exitCode).toBe(1);
    expect(purged).toBe(false);
  });

  it("prompts for confirmation before purging plaintext", async () => {
    let promptShown = false;

    const exitCode = await secretsMigrateCommand({
      configPath: "/tmp/test-config.json",
      yes: false, // interactive mode
      _mockConfig: {
        models: { providers: { openai: { apiKey: "sk-key" } } },
        secrets: { providers: { gcp: { project: "test-project" } } },
      },
      _mockProvider: {
        setSecret: vi.fn().mockResolvedValue(undefined),
        getSecret: vi.fn().mockResolvedValue("sk-key"),
      },
      _mockPrompt: async (message: string) => {
        promptShown = true;
        return true; // user confirms
      },
    });

    expect(promptShown).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// openclaw secrets set
// ---------------------------------------------------------------------------

describe("openclaw secrets set", () => {
  it("stores a secret with given name and value", async () => {
    const setSecret = vi.fn().mockResolvedValue(undefined);

    const exitCode = await secretsSetCommand({
      provider: "gcp",
      name: "my-new-secret",
      value: "super-secret-value",
      _mockProvider: { setSecret },
    });

    expect(exitCode).toBe(0);
    expect(setSecret).toHaveBeenCalledWith("my-new-secret", "super-secret-value");
  });

  it("fails when provider is not configured", async () => {
    const exitCode = await secretsSetCommand({
      provider: "gcp",
      name: "my-secret",
      value: "value",
      _mockProvider: null,
    });
    expect(exitCode).toBe(1);
  });

  it("fails when setSecret throws", async () => {
    const setSecret = vi.fn().mockRejectedValue(new Error("Permission denied"));

    const exitCode = await secretsSetCommand({
      provider: "gcp",
      name: "restricted-secret",
      value: "value",
      _mockProvider: { setSecret },
    });

    expect(exitCode).toBe(1);
  });

  it("succeeds with special characters in value", async () => {
    const setSecret = vi.fn().mockResolvedValue(undefined);

    const exitCode = await secretsSetCommand({
      provider: "gcp",
      name: "special-chars",
      value: 'p@$$w0rd!#%&*"',
      _mockProvider: { setSecret },
    });

    expect(exitCode).toBe(0);
    expect(setSecret).toHaveBeenCalledWith("special-chars", 'p@$$w0rd!#%&*"');
  });
});
