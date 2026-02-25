import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rollbackSecretsMigration, runSecretsMigration } from "./migrate.js";

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
      secrets: { providers: Record<string, { source: string; path: string }> };
    };
    expect(migratedConfig.models.providers.openai.apiKey).toEqual({
      source: "file",
      provider: "default",
      id: "/providers/openai/apiKey",
    });
    expect(migratedConfig.skills.entries["review-pr"].apiKey).toEqual({
      source: "file",
      provider: "default",
      id: "/skills/entries/review-pr/apiKey",
    });
    expect(migratedConfig.channels.googlechat.serviceAccount).toBeUndefined();
    expect(migratedConfig.channels.googlechat.serviceAccountRef).toEqual({
      source: "file",
      provider: "default",
      id: "/channels/googlechat/serviceAccount",
    });
    expect(migratedConfig.secrets.providers.default.source).toBe("file");

    const migratedAuth = JSON.parse(await fs.readFile(authStorePath, "utf8")) as {
      profiles: { "openai:default": { key?: string; keyRef?: unknown } };
    };
    expect(migratedAuth.profiles["openai:default"].key).toBeUndefined();
    expect(migratedAuth.profiles["openai:default"].keyRef).toEqual({
      source: "file",
      provider: "default",
      id: "/auth-profiles/main/openai:default/key",
    });

    const migratedEnv = await fs.readFile(envPath, "utf8");
    expect(migratedEnv).not.toContain("sk-openai-plaintext");
    expect(migratedEnv).toContain("SKILL_KEY=sk-skill-plaintext");
    expect(migratedEnv).toContain("UNRELATED=value");

    const secretsPath = path.join(stateDir, "secrets.json");
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

  it("uses a unique backup id when multiple writes happen in the same second", async () => {
    const now = new Date("2026-02-22T00:00:00.000Z");
    const first = await runSecretsMigration({ env, write: true, now });
    await rollbackSecretsMigration({ env, backupId: first.backupId! });

    const second = await runSecretsMigration({ env, write: true, now });

    expect(first.backupId).toBeTruthy();
    expect(second.backupId).toBeTruthy();
    expect(second.backupId).not.toBe(first.backupId);
  });

  it("reuses configured file provider aliases", async () => {
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          secrets: {
            providers: {
              teamfile: {
                source: "file",
                path: "~/.openclaw/team-secrets.json",
                mode: "jsonPointer",
              },
            },
            defaults: {
              file: "teamfile",
            },
          },
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                apiKey: "sk-openai-plaintext",
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

    await runSecretsMigration({ env, write: true });
    const migratedConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      models: { providers: { openai: { apiKey: unknown } } };
    };
    expect(migratedConfig.models.providers.openai.apiKey).toEqual({
      source: "file",
      provider: "teamfile",
      id: "/providers/openai/apiKey",
    });
  });

  it("keeps .env values when scrub-env is disabled", async () => {
    await runSecretsMigration({ env, write: true, scrubEnv: false });
    const migratedEnv = await fs.readFile(envPath, "utf8");
    expect(migratedEnv).toContain("OPENAI_API_KEY=sk-openai-plaintext");
  });
});
