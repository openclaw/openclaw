import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSecretsAudit } from "./audit.js";

describe("secrets audit", () => {
  let rootDir = "";
  let stateDir = "";
  let configPath = "";
  let authStorePath = "";
  let authJsonPath = "";
  let envPath = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-audit-"));
    stateDir = path.join(rootDir, ".openclaw");
    configPath = path.join(stateDir, "openclaw.json");
    authStorePath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
    authJsonPath = path.join(stateDir, "agents", "main", "agent", "auth.json");
    envPath = path.join(stateDir, ".env");
    env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENAI_API_KEY: "env-openai-key",
      ...(typeof process.env.PATH === "string" && process.env.PATH.trim().length > 0
        ? { PATH: process.env.PATH }
        : { PATH: "/usr/bin:/bin" }),
    };

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.mkdir(path.dirname(authStorePath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                api: "openai-completions",
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                models: [{ id: "gpt-5", name: "gpt-5" }],
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      authStorePath,
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              key: "sk-openai-plaintext",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(envPath, "OPENAI_API_KEY=sk-openai-plaintext\n", "utf8");
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("reports plaintext + shadowing findings", async () => {
    const report = await runSecretsAudit({ env });
    expect(report.status).toBe("findings");
    expect(report.summary.plaintextCount).toBeGreaterThan(0);
    expect(report.summary.shadowedRefCount).toBeGreaterThan(0);
    expect(report.findings.some((entry) => entry.code === "REF_SHADOWED")).toBe(true);
    expect(report.findings.some((entry) => entry.code === "PLAINTEXT_FOUND")).toBe(true);
  });

  it("does not mutate legacy auth.json during audit", async () => {
    await fs.rm(authStorePath, { force: true });
    await fs.writeFile(
      authJsonPath,
      `${JSON.stringify(
        {
          openai: {
            type: "api_key",
            key: "sk-legacy-auth-json",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const report = await runSecretsAudit({ env });
    expect(report.findings.some((entry) => entry.code === "LEGACY_RESIDUE")).toBe(true);
    await expect(fs.stat(authJsonPath)).resolves.toBeTruthy();
    await expect(fs.stat(authStorePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports malformed sidecar JSON as findings instead of crashing", async () => {
    await fs.writeFile(authStorePath, "{invalid-json", "utf8");
    await fs.writeFile(authJsonPath, "{invalid-json", "utf8");

    const report = await runSecretsAudit({ env });
    expect(report.findings.some((entry) => entry.file === authStorePath)).toBe(true);
    expect(report.findings.some((entry) => entry.file === authJsonPath)).toBe(true);
    expect(report.findings.some((entry) => entry.code === "REF_UNRESOLVED")).toBe(true);
  });

  it("batches ref resolution per provider during audit", async () => {
    if (process.platform === "win32") {
      return;
    }
    const execLogPath = path.join(rootDir, "exec-calls.log");
    const execScriptPath = path.join(rootDir, "resolver.mjs");
    await fs.writeFile(
      execScriptPath,
      [
        "#!/usr/bin/env node",
        "import fs from 'node:fs';",
        "const req = JSON.parse(fs.readFileSync(0, 'utf8'));",
        `fs.appendFileSync(${JSON.stringify(execLogPath)}, 'x\\n');`,
        "const values = Object.fromEntries((req.ids ?? []).map((id) => [id, `value:${id}`]));",
        "process.stdout.write(JSON.stringify({ protocolVersion: 1, values }));",
      ].join("\n"),
      { encoding: "utf8", mode: 0o700 },
    );

    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          secrets: {
            providers: {
              execmain: {
                source: "exec",
                command: execScriptPath,
                jsonOnly: true,
                passEnv: ["PATH"],
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
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.rm(authStorePath, { force: true });
    await fs.writeFile(envPath, "", "utf8");

    const report = await runSecretsAudit({ env });
    expect(report.summary.unresolvedRefCount).toBe(0);

    const callLog = await fs.readFile(execLogPath, "utf8");
    const callCount = callLog.split("\n").filter((line) => line.trim().length > 0).length;
    expect(callCount).toBe(1);
  });
});
