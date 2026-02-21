import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runExecMock = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runExec: runExecMock,
}));

const { rollbackSecretsMigration, runSecretsMigration } = await import("./migrate.js");

describe("secrets migrate", () => {
  let baseDir = "";
  let stateDir = "";
  let configPath = "";
  let env: NodeJS.ProcessEnv;
  let authStorePath = "";
  let envPath = "";

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-migrate-"));
    stateDir = path.join(baseDir, ".openclaw");
    configPath = path.join(stateDir, "openclaw.json");
    authStorePath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
    envPath = path.join(stateDir, ".env");
    env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
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
                apiKey: "sk-openai-plaintext",
                models: [{ id: "gpt-5", name: "gpt-5" }],
              },
            },
          },
          skills: {
            entries: {
              "review-pr": {
                enabled: true,
                apiKey: "sk-skill-plaintext",
              },
            },
          },
          channels: {
            googlechat: {
              serviceAccount: '{"type":"service_account","client_email":"bot@example.com"}',
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
              key: "sk-profile-plaintext",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await fs.writeFile(
      envPath,
      "OPENAI_API_KEY=sk-openai-plaintext\nSKILL_KEY=sk-skill-plaintext\nUNRELATED=value\n",
      "utf8",
    );

    runExecMock.mockReset();
    runExecMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "--encrypt") {
        const outputPath = args[args.indexOf("--output") + 1];
        const inputPath = args.at(-1);
        if (!outputPath || !inputPath) {
          throw new Error("missing sops encrypt paths");
        }
        await fs.copyFile(inputPath, outputPath);
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "--decrypt") {
        const sourcePath = args.at(-1);
        if (!sourcePath) {
          throw new Error("missing sops decrypt source");
        }
        const raw = await fs.readFile(sourcePath, "utf8");
        return { stdout: raw, stderr: "" };
      }
      throw new Error(`unexpected sops invocation: ${args.join(" ")}`);
    });
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("reports a dry-run without mutating files", async () => {
    const beforeConfig = await fs.readFile(configPath, "utf8");
    const beforeAuthStore = await fs.readFile(authStorePath, "utf8");

    const result = await runSecretsMigration({ env });

    expect(result.mode).toBe("dry-run");
    expect(result.changed).toBe(true);
    expect(result.counters.secretsWritten).toBeGreaterThanOrEqual(3);

    expect(await fs.readFile(configPath, "utf8")).toBe(beforeConfig);
    expect(await fs.readFile(authStorePath, "utf8")).toBe(beforeAuthStore);
  });

  it("migrates plaintext to file-backed refs and can rollback", async () => {
    const applyResult = await runSecretsMigration({ env, write: true });

    expect(applyResult.mode).toBe("write");
    expect(applyResult.changed).toBe(true);
    expect(applyResult.backupId).toBeTruthy();

    const migratedConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      models: { providers: { openai: { apiKey: unknown } } };
      skills: { entries: { "review-pr": { apiKey: unknown } } };
      channels: { googlechat: { serviceAccount?: unknown; serviceAccountRef?: unknown } };
      secrets: { sources: { file: { type: string; path: string } } };
    };
    expect(migratedConfig.models.providers.openai.apiKey).toEqual({
      source: "file",
      id: "/providers/openai/apiKey",
    });
    expect(migratedConfig.skills.entries["review-pr"].apiKey).toEqual({
      source: "file",
      id: "/skills/entries/review-pr/apiKey",
    });
    expect(migratedConfig.channels.googlechat.serviceAccount).toBeUndefined();
    expect(migratedConfig.channels.googlechat.serviceAccountRef).toEqual({
      source: "file",
      id: "/channels/googlechat/serviceAccount",
    });
    expect(migratedConfig.secrets.sources.file.type).toBe("sops");

    const migratedAuth = JSON.parse(await fs.readFile(authStorePath, "utf8")) as {
      profiles: { "openai:default": { key?: string; keyRef?: unknown } };
    };
    expect(migratedAuth.profiles["openai:default"].key).toBeUndefined();
    expect(migratedAuth.profiles["openai:default"].keyRef).toEqual({
      source: "file",
      id: "/auth-profiles/main/openai:default/key",
    });

    const migratedEnv = await fs.readFile(envPath, "utf8");
    expect(migratedEnv).not.toContain("sk-openai-plaintext");
    expect(migratedEnv).not.toContain("sk-skill-plaintext");
    expect(migratedEnv).toContain("UNRELATED=value");

    const secretsPath = path.join(stateDir, "secrets.enc.json");
    const secretsPayload = JSON.parse(await fs.readFile(secretsPath, "utf8")) as {
      providers: { openai: { apiKey: string } };
      skills: { entries: { "review-pr": { apiKey: string } } };
      channels: { googlechat: { serviceAccount: string } };
      "auth-profiles": { main: { "openai:default": { key: string } } };
    };
    expect(secretsPayload.providers.openai.apiKey).toBe("sk-openai-plaintext");
    expect(secretsPayload.skills.entries["review-pr"].apiKey).toBe("sk-skill-plaintext");
    expect(secretsPayload.channels.googlechat.serviceAccount).toContain("service_account");
    expect(secretsPayload["auth-profiles"].main["openai:default"].key).toBe("sk-profile-plaintext");

    const rollbackResult = await rollbackSecretsMigration({ env, backupId: applyResult.backupId! });
    expect(rollbackResult.restoredFiles).toBeGreaterThan(0);

    const rolledBackConfig = await fs.readFile(configPath, "utf8");
    expect(rolledBackConfig).toContain("sk-openai-plaintext");
    expect(rolledBackConfig).toContain("sk-skill-plaintext");

    const rolledBackAuth = await fs.readFile(authStorePath, "utf8");
    expect(rolledBackAuth).toContain("sk-profile-plaintext");

    await expect(fs.stat(secretsPath)).rejects.toThrow();
    const rolledBackEnv = await fs.readFile(envPath, "utf8");
    expect(rolledBackEnv).toContain("OPENAI_API_KEY=sk-openai-plaintext");
  });
});
