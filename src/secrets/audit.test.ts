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
  let envPath = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-audit-"));
    stateDir = path.join(rootDir, ".openclaw");
    configPath = path.join(stateDir, "openclaw.json");
    authStorePath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
    envPath = path.join(stateDir, ".env");
    env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENAI_API_KEY: "env-openai-key",
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
});
