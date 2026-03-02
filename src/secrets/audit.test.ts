import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSecretsAudit } from "./audit.js";

type AuditFixture = {
  rootDir: string;
  stateDir: string;
  configPath: string;
  authStorePath: string;
  authJsonPath: string;
  envPath: string;
  env: NodeJS.ProcessEnv;
};

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolveRuntimePathEnv(): string {
  if (typeof process.env.PATH === "string" && process.env.PATH.trim().length > 0) {
    return process.env.PATH;
  }
  return "/usr/bin:/bin";
}

function hasFinding(
  report: Awaited<ReturnType<typeof runSecretsAudit>>,
  predicate: (entry: { code: string; file: string }) => boolean,
): boolean {
  return report.findings.some((entry) => predicate(entry as { code: string; file: string }));
}

async function createAuditFixture(): Promise<AuditFixture> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-audit-"));
  const stateDir = path.join(rootDir, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  const authStorePath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
  const authJsonPath = path.join(stateDir, "agents", "main", "agent", "auth.json");
  const envPath = path.join(stateDir, ".env");

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(path.dirname(authStorePath), { recursive: true });

  return {
    rootDir,
    stateDir,
    configPath,
    authStorePath,
    authJsonPath,
    envPath,
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENAI_API_KEY: "env-openai-key",
      PATH: resolveRuntimePathEnv(),
    },
  };
}

async function seedAuditFixture(fixture: AuditFixture): Promise<void> {
  const seededProvider = {
    openai: {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-completions",
      apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      models: [{ id: "gpt-5", name: "gpt-5" }],
    },
  };
  const seededProfiles = new Map<string, Record<string, string>>([
    [
      "openai:default",
      {
        type: "api_key",
        provider: "openai",
        key: "sk-openai-plaintext",
      },
    ],
  ]);
  await writeJsonFile(fixture.configPath, {
    models: { providers: seededProvider },
  });
  await writeJsonFile(fixture.authStorePath, {
    version: 1,
    profiles: Object.fromEntries(seededProfiles),
  });
  await fs.writeFile(fixture.envPath, "OPENAI_API_KEY=sk-openai-plaintext\n", "utf8");
}

describe("secrets audit", () => {
  let fixture: AuditFixture;

  beforeEach(async () => {
    fixture = await createAuditFixture();
    await seedAuditFixture(fixture);
  });

  afterEach(async () => {
    await fs.rm(fixture.rootDir, { recursive: true, force: true });
  });

  it("reports plaintext + shadowing findings", async () => {
    const report = await runSecretsAudit({ env: fixture.env });
    expect(report.status).toBe("findings");
    expect(report.summary.plaintextCount).toBeGreaterThan(0);
    expect(report.summary.shadowedRefCount).toBeGreaterThan(0);
    expect(hasFinding(report, (entry) => entry.code === "REF_SHADOWED")).toBe(true);
    expect(hasFinding(report, (entry) => entry.code === "PLAINTEXT_FOUND")).toBe(true);
  });

  it("does not mutate legacy auth.json during audit", async () => {
    await fs.rm(fixture.authStorePath, { force: true });
    await writeJsonFile(fixture.authJsonPath, {
      openai: {
        type: "api_key",
        key: "sk-legacy-auth-json",
      },
    });

    const report = await runSecretsAudit({ env: fixture.env });
    expect(hasFinding(report, (entry) => entry.code === "LEGACY_RESIDUE")).toBe(true);
    await expect(fs.stat(fixture.authJsonPath)).resolves.toBeTruthy();
    await expect(fs.stat(fixture.authStorePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports malformed sidecar JSON as findings instead of crashing", async () => {
    await fs.writeFile(fixture.authStorePath, "{invalid-json", "utf8");
    await fs.writeFile(fixture.authJsonPath, "{invalid-json", "utf8");

    const report = await runSecretsAudit({ env: fixture.env });
    expect(hasFinding(report, (entry) => entry.file === fixture.authStorePath)).toBe(true);
    expect(hasFinding(report, (entry) => entry.file === fixture.authJsonPath)).toBe(true);
    expect(hasFinding(report, (entry) => entry.code === "REF_UNRESOLVED")).toBe(true);
  });

  it("batches ref resolution per provider during audit", async () => {
    if (process.platform === "win32") {
      return;
    }
    const execLogPath = path.join(fixture.rootDir, "exec-calls.log");
    const execScriptPath = path.join(fixture.rootDir, "resolver.mjs");
    await fs.writeFile(
      execScriptPath,
      [
        `#!${process.execPath}`,
        "import fs from 'node:fs';",
        "const req = JSON.parse(fs.readFileSync(0, 'utf8'));",
        `fs.appendFileSync(${JSON.stringify(execLogPath)}, 'x\\n');`,
        "const values = Object.fromEntries((req.ids ?? []).map((id) => [id, `value:${id}`]));",
        "process.stdout.write(JSON.stringify({ protocolVersion: 1, values }));",
      ].join("\n"),
      { encoding: "utf8", mode: 0o700 },
    );

    await writeJsonFile(fixture.configPath, {
      secrets: {
        providers: {
          execmain: {
            source: "exec",
            command: execScriptPath,
            jsonOnly: true,
            timeoutMs: 20_000,
            noOutputTimeoutMs: 10_000,
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
            apiKey: { source: "exec", provider: "execmain", id: "providers/openai/apiKey" },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
          moonshot: {
            baseUrl: "https://api.moonshot.cn/v1",
            api: "openai-completions",
            apiKey: { source: "exec", provider: "execmain", id: "providers/moonshot/apiKey" },
            models: [{ id: "moonshot-v1-8k", name: "moonshot-v1-8k" }],
          },
        },
      },
    });
    await fs.rm(fixture.authStorePath, { force: true });
    await fs.writeFile(fixture.envPath, "", "utf8");

    const report = await runSecretsAudit({ env: fixture.env });
    expect(report.summary.unresolvedRefCount).toBe(0);

    const callLog = await fs.readFile(execLogPath, "utf8");
    const callCount = callLog.split("\n").filter((line) => line.trim().length > 0).length;
    expect(callCount).toBe(1);
  });
});
