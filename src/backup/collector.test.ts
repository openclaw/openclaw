import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectFiles } from "./collector.js";

// collectFiles imports resolveConfigPathCandidate, resolveStateDir, DEFAULT_CRON_STORE_PATH
// at module scope. We mock them to control paths in tests.
// vi.resetModules() is needed before each vi.doMock + dynamic import combo to
// ensure the entire module graph (collector → paths, collector → cron/store)
// picks up the fresh mocks instead of cached module references.

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-collector-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  tempDirs.length = 0;
});

/**
 * Build a fake state directory with the given structure.
 */
async function buildStateDir(baseDir: string): Promise<string> {
  const stateDir = path.join(baseDir, ".openclaw");

  // Config
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({
      gateway: { auth: { token: "secret-token-123" } },
      models: { primary: "anthropic/claude-4" },
      channels: { telegram: { botToken: "tg-bot-token-xxx" } },
    }),
  );

  // Workspace / agent dir
  const agentDir = path.join(stateDir, "agents", "default", "agent");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, "SOUL.md"), "# Soul\nI am helpful.");
  await fs.writeFile(path.join(agentDir, "MEMORY.md"), "# Memory\nUser prefers dark mode.");
  await fs.mkdir(path.join(agentDir, "memory"), { recursive: true });
  await fs.writeFile(path.join(agentDir, "memory", "facts.json"), "[]");

  // Sessions
  await fs.writeFile(path.join(agentDir, "sessions.json"), JSON.stringify({ sessions: [] }));

  // Skills
  await fs.mkdir(path.join(stateDir, "skills", "my-skill"), {
    recursive: true,
  });
  await fs.writeFile(path.join(stateDir, "skills", "my-skill", "index.ts"), "export default {};");

  // Approvals
  await fs.writeFile(path.join(stateDir, "exec-approvals.json"), JSON.stringify({ approvals: [] }));

  // Pairing
  await fs.mkdir(path.join(stateDir, "pairing"), { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "pairing", "allowlist.json"),
    JSON.stringify({ allowed: [] }),
  );

  return stateDir;
}

describe("backup/collector", () => {
  it("collects config with secrets redacted", async () => {
    const base = await makeTempDir();
    const stateDir = await buildStateDir(base);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const configPath = path.join(stateDir, "openclaw.json");

    // Mock the config paths module to point to our temp dir

    const files = await collectFiles({
      components: ["config"],
      stateDir,
      configPath: path.join(stateDir, "openclaw.json"),
    });
    expect(files.length).toBeGreaterThanOrEqual(1);

    const configFile = files.find((f) => f.archivePath === "config/openclaw.json");
    expect(configFile).toBeDefined();
    // Content should have secrets redacted
    expect(configFile!.content).toBeDefined();
    const parsed = JSON.parse(configFile!.content!);
    expect(parsed.gateway.auth.token).toBe("***REDACTED***");
    expect(parsed.channels.telegram.botToken).toBe("***REDACTED***");
    // Non-sensitive values preserved
    expect(parsed.models.primary).toBe("anthropic/claude-4");
  });

  it("collects workspace files", async () => {
    const base = await makeTempDir();
    const stateDir = await buildStateDir(base);

    const files = await collectFiles({
      components: ["workspace"],
      stateDir,
      agentDir: path.join(stateDir, "agents", "default", "agent"),
    });
    const paths = files.map((f) => f.archivePath.replace(/\\/g, "/"));
    expect(paths).toContain("workspace/SOUL.md");
    expect(paths).toContain("workspace/MEMORY.md");
    expect(paths.some((p) => p.startsWith("workspace/memory/"))).toBe(true);
  });

  it("collects sessions", async () => {
    const base = await makeTempDir();
    const stateDir = await buildStateDir(base);

    const files = await collectFiles({
      components: ["sessions"],
      stateDir,
      agentDir: path.join(stateDir, "agents", "default", "agent"),
    });
    const paths = files.map((f) => f.archivePath);
    expect(paths).toContain("sessions/sessions.json");
  });

  it("collects skills directory recursively", async () => {
    const base = await makeTempDir();
    const stateDir = await buildStateDir(base);

    const files = await collectFiles({ components: ["skills"], stateDir });
    const paths = files.map((f) => f.archivePath.replace(/\\/g, "/"));
    expect(paths.some((p) => p.includes("skills/my-skill/index.ts"))).toBe(true);
  });

  it("collects approvals", async () => {
    const base = await makeTempDir();
    const stateDir = await buildStateDir(base);

    const files = await collectFiles({ components: ["approvals"], stateDir });
    const paths = files.map((f) => f.archivePath);
    expect(paths).toContain("approvals/exec-approvals.json");
  });

  it("collects pairing directory", async () => {
    const base = await makeTempDir();
    const stateDir = await buildStateDir(base);

    const files = await collectFiles({ components: ["pairing"], stateDir });
    const paths = files.map((f) => f.archivePath.replace(/\\/g, "/"));
    expect(paths.some((p) => p.includes("pairing/allowlist.json"))).toBe(true);
  });

  it("uses CORE_BACKUP_COMPONENTS by default", async () => {
    const base = await makeTempDir();
    const stateDir = await buildStateDir(base);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const configPath = path.join(stateDir, "openclaw.json");

    const files = await collectFiles({
      stateDir,
      configPath: path.join(stateDir, "openclaw.json"),
      cronStorePath: path.join(stateDir, "cron", "jobs.json"),
      agentDir: path.join(stateDir, "agents", "default", "agent"),
    });
    const archivePaths = files.map((f) => f.archivePath.replace(/\\/g, "/"));
    // Core = config, workspace, cron, skills
    expect(archivePaths.some((p) => p.startsWith("config/"))).toBe(true);
    expect(archivePaths.some((p) => p.startsWith("workspace/"))).toBe(true);
    expect(archivePaths.some((p) => p.startsWith("skills/"))).toBe(true);
    // Non-core should NOT be included
    expect(archivePaths.some((p) => p.startsWith("sessions/"))).toBe(false);
    expect(archivePaths.some((p) => p.startsWith("approvals/"))).toBe(false);
    expect(archivePaths.some((p) => p.startsWith("pairing/"))).toBe(false);
  });

  it("returns empty array when state dir does not exist", async () => {
    const nonexistent = path.join(os.tmpdir(), `openclaw-nonexistent-${Date.now()}`);

    // Mock DEFAULT_CRON_STORE_PATH so it doesn't pick up real user data

    const files = await collectFiles({
      stateDir: nonexistent,
      configPath: path.join(nonexistent, "openclaw.json"),
      cronStorePath: path.join(nonexistent, "cron", "jobs.json"),
      agentDir: path.join(nonexistent, "agents", "default", "agent"),
    });
    expect(files).toEqual([]);
  });
});

describe("stripSecrets", () => {
  it("redacts known sensitive keys", async () => {
    const base = await makeTempDir();
    const stateDir = path.join(base, ".openclaw");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        nested: {
          apiKey: "sk-123",
          apiSecret: "sec-456",
          password: "hunter2",
          accessKeyId: "AKIA...",
          secretAccessKey: "wJalr...",
          normalKey: "keep-this",
        },
      }),
    );

    const files = await collectFiles({
      components: ["config"],
      stateDir,
      configPath: path.join(stateDir, "openclaw.json"),
    });
    const configFile = files.find((f) => f.archivePath === "config/openclaw.json");
    const parsed = JSON.parse(configFile!.content!);
    expect(parsed.nested.apiKey).toBe("***REDACTED***");
    expect(parsed.nested.apiSecret).toBe("***REDACTED***");
    expect(parsed.nested.password).toBe("***REDACTED***");
    expect(parsed.nested.accessKeyId).toBe("***REDACTED***");
    expect(parsed.nested.secretAccessKey).toBe("***REDACTED***");
    expect(parsed.nested.normalKey).toBe("keep-this");
  });

  it("redacts secrets in deeply nested arrays of objects", async () => {
    const base = await makeTempDir();
    const stateDir = path.join(base, ".openclaw");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        channels: {
          telegram: { botToken: "tg-xxx" },
          slack: { botToken: "xoxb-yyy", appToken: "xapp-zzz" },
        },
        providers: [
          { name: "anthropic", apiKey: "sk-ant-secret" },
          {
            name: "openai",
            apiKey: "sk-openai-secret",
            nested: { secret: "deep" },
          },
        ],
      }),
    );
    const files = await collectFiles({
      components: ["config"],
      stateDir,
      configPath: path.join(stateDir, "openclaw.json"),
    });
    const parsed = JSON.parse(files[0].content!);

    // Channel tokens redacted
    expect(parsed.channels.telegram.botToken).toBe("***REDACTED***");
    expect(parsed.channels.slack.botToken).toBe("***REDACTED***");
    expect(parsed.channels.slack.appToken).toBe("***REDACTED***");
    // Array items redacted
    expect(parsed.providers[0].apiKey).toBe("***REDACTED***");
    expect(parsed.providers[1].apiKey).toBe("***REDACTED***");
    expect(parsed.providers[1].nested.secret).toBe("***REDACTED***");
    // Non-sensitive preserved
    expect(parsed.providers[0].name).toBe("anthropic");
  });

  it("preserves non-string values even for sensitive key names", async () => {
    const base = await makeTempDir();
    const stateDir = path.join(base, ".openclaw");
    await fs.mkdir(stateDir, { recursive: true });
    // edge case: token as boolean, password as number (should NOT be redacted)
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        features: {
          token: true,
          password: 42,
          apiKey: null,
          secret: ["array"],
        },
      }),
    );
    const files = await collectFiles({
      components: ["config"],
      stateDir,
      configPath: path.join(stateDir, "openclaw.json"),
    });
    const parsed = JSON.parse(files[0].content!);

    // Non-string sensitive keys preserved as-is
    expect(parsed.features.token).toBe(true);
    expect(parsed.features.password).toBe(42);
    expect(parsed.features.apiKey).toBeNull();
    expect(parsed.features.secret).toEqual(["array"]);
  });
});

describe("collector edge cases", () => {
  it("collects workspace with custom agentDir", async () => {
    const base = await makeTempDir();
    const stateDir = path.join(base, ".openclaw");
    const customAgent = path.join(base, "custom-agent");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(customAgent, { recursive: true });
    await fs.writeFile(path.join(customAgent, "SOUL.md"), "# Custom Agent Soul");
    await fs.writeFile(path.join(customAgent, "MEMORY.md"), "# Custom Memory");
    // File not in allowList should be excluded
    await fs.writeFile(path.join(customAgent, "random.txt"), "should be excluded");
    const files = await collectFiles({
      components: ["workspace"],
      stateDir,
      agentDir: customAgent,
    });
    const paths = files.map((f) => f.archivePath.replace(/\\/g, "/"));
    expect(paths).toContain("workspace/SOUL.md");
    expect(paths).toContain("workspace/MEMORY.md");
    // random.txt is not in the allowList
    expect(paths.some((p) => p.includes("random.txt"))).toBe(false);
  });

  it("collects ALL_BACKUP_COMPONENTS when specified", async () => {
    const base = await makeTempDir();
    const stateDir = await buildStateDir(base);
    const { ALL_BACKUP_COMPONENTS } = await import("./types.js");

    const files = await collectFiles({
      components: [...ALL_BACKUP_COMPONENTS],
      stateDir,
      configPath: path.join(stateDir, "openclaw.json"),
      cronStorePath: path.join(stateDir, "cron", "jobs.json"),
      agentDir: path.join(stateDir, "agents", "default", "agent"),
    });
    const paths = files.map((f) => f.archivePath.replace(/\\/g, "/"));

    // Every component should have at least one file
    expect(paths.some((p) => p.startsWith("config/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("workspace/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("skills/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("sessions/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("approvals/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("pairing/"))).toBe(true);
  });

  it("handles malformed JSON config gracefully (skips)", async () => {
    const base = await makeTempDir();
    const stateDir = path.join(base, ".openclaw");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, "openclaw.json"), "NOT VALID JSON {{{");
    // Should not throw — collector catches and skips
    const files = await collectFiles({
      components: ["config"],
      stateDir,
      configPath: path.join(stateDir, "openclaw.json"),
    });
    expect(files).toEqual([]);
  });
});
