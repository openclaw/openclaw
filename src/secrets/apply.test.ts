import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSecretsApply } from "./apply.js";
import type { SecretsApplyPlan } from "./plan.js";

function stripVolatileConfigMeta(input: string): Record<string, unknown> {
  const parsed = JSON.parse(input) as Record<string, unknown>;
  const meta =
    parsed.meta && typeof parsed.meta === "object" && !Array.isArray(parsed.meta)
      ? { ...(parsed.meta as Record<string, unknown>) }
      : undefined;
  if (meta && "lastTouchedAt" in meta) {
    delete meta.lastTouchedAt;
  }
  if (meta) {
    parsed.meta = meta;
  }
  return parsed;
}

describe("secrets apply", () => {
  let rootDir = "";
  let stateDir = "";
  let configPath = "";
  let authStorePath = "";
  let authJsonPath = "";
  let envPath = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-apply-"));
    stateDir = path.join(rootDir, ".openclaw");
    configPath = path.join(stateDir, "openclaw.json");
    authStorePath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
    authJsonPath = path.join(stateDir, "agents", "main", "agent", "auth.json");
    envPath = path.join(stateDir, ".env");
    env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENAI_API_KEY: "sk-live-env",
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

    await fs.writeFile(
      authJsonPath,
      `${JSON.stringify(
        {
          openai: {
            type: "api_key",
            key: "sk-openai-plaintext",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(envPath, "OPENAI_API_KEY=sk-openai-plaintext\nUNRELATED=value\n", "utf8");
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("preflights and applies one-way scrub without plaintext backups", async () => {
    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "models.providers.apiKey",
          path: "models.providers.openai.apiKey",
          providerId: "openai",
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      ],
      options: {
        scrubEnv: true,
        scrubAuthProfilesForProviderTargets: true,
        scrubLegacyAuthJson: true,
      },
    };

    const dryRun = await runSecretsApply({ plan, env, write: false });
    expect(dryRun.mode).toBe("dry-run");
    expect(dryRun.changed).toBe(true);

    const applied = await runSecretsApply({ plan, env, write: true });
    expect(applied.mode).toBe("write");
    expect(applied.changed).toBe(true);

    const nextConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      models: { providers: { openai: { apiKey: unknown } } };
    };
    expect(nextConfig.models.providers.openai.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });

    const nextAuthStore = JSON.parse(await fs.readFile(authStorePath, "utf8")) as {
      profiles: { "openai:default": { key?: string; keyRef?: unknown } };
    };
    expect(nextAuthStore.profiles["openai:default"].key).toBeUndefined();
    expect(nextAuthStore.profiles["openai:default"].keyRef).toBeUndefined();

    const nextAuthJson = JSON.parse(await fs.readFile(authJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(nextAuthJson.openai).toBeUndefined();

    const nextEnv = await fs.readFile(envPath, "utf8");
    expect(nextEnv).not.toContain("sk-openai-plaintext");
    expect(nextEnv).toContain("UNRELATED=value");
  });

  it("is idempotent on repeated write applies", async () => {
    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "models.providers.apiKey",
          path: "models.providers.openai.apiKey",
          providerId: "openai",
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      ],
      options: {
        scrubEnv: true,
        scrubAuthProfilesForProviderTargets: true,
        scrubLegacyAuthJson: true,
      },
    };

    const first = await runSecretsApply({ plan, env, write: true });
    expect(first.changed).toBe(true);
    const configAfterFirst = await fs.readFile(configPath, "utf8");
    const authStoreAfterFirst = await fs.readFile(authStorePath, "utf8");
    const authJsonAfterFirst = await fs.readFile(authJsonPath, "utf8");
    const envAfterFirst = await fs.readFile(envPath, "utf8");

    // Second apply should be a true no-op and avoid file writes entirely.
    await fs.chmod(configPath, 0o400);
    await fs.chmod(authStorePath, 0o400);

    const second = await runSecretsApply({ plan, env, write: true });
    expect(second.mode).toBe("write");
    const configAfterSecond = await fs.readFile(configPath, "utf8");
    expect(stripVolatileConfigMeta(configAfterSecond)).toEqual(
      stripVolatileConfigMeta(configAfterFirst),
    );
    await expect(fs.readFile(authStorePath, "utf8")).resolves.toBe(authStoreAfterFirst);
    await expect(fs.readFile(authJsonPath, "utf8")).resolves.toBe(authJsonAfterFirst);
    await expect(fs.readFile(envPath, "utf8")).resolves.toBe(envAfterFirst);
  });

  it("applies targets safely when map keys contain dots", async () => {
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          models: {
            providers: {
              "openai.dev": {
                baseUrl: "https://api.openai.com/v1",
                api: "openai-completions",
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

    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "models.providers.apiKey",
          path: "models.providers.openai.dev.apiKey",
          pathSegments: ["models", "providers", "openai.dev", "apiKey"],
          providerId: "openai.dev",
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      ],
      options: {
        scrubEnv: false,
        scrubAuthProfilesForProviderTargets: false,
        scrubLegacyAuthJson: false,
      },
    };

    const result = await runSecretsApply({ plan, env, write: true });
    expect(result.changed).toBe(true);

    const nextConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      models?: {
        providers?: Record<string, { apiKey?: unknown }>;
      };
    };
    expect(nextConfig.models?.providers?.["openai.dev"]?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });
    expect(nextConfig.models?.providers?.openai).toBeUndefined();
  });

  it("migrates skills entries apiKey targets alongside provider api keys", async () => {
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                api: "openai-completions",
                apiKey: "sk-openai-plaintext",
                models: [{ id: "gpt-5", name: "gpt-5" }],
              },
            },
          },
          skills: {
            entries: {
              "qa-secret-test": {
                enabled: true,
                apiKey: "sk-skill-plaintext",
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "models.providers.apiKey",
          path: "models.providers.openai.apiKey",
          pathSegments: ["models", "providers", "openai", "apiKey"],
          providerId: "openai",
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
        {
          type: "skills.entries.apiKey",
          path: "skills.entries.qa-secret-test.apiKey",
          pathSegments: ["skills", "entries", "qa-secret-test", "apiKey"],
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      ],
      options: {
        scrubEnv: true,
        scrubAuthProfilesForProviderTargets: true,
        scrubLegacyAuthJson: true,
      },
    };

    const result = await runSecretsApply({ plan, env, write: true });
    expect(result.changed).toBe(true);

    const nextConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      models: { providers: { openai: { apiKey: unknown } } };
      skills: { entries: { "qa-secret-test": { apiKey: unknown } } };
    };
    expect(nextConfig.models.providers.openai.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });
    expect(nextConfig.skills.entries["qa-secret-test"].apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });

    const rawConfig = await fs.readFile(configPath, "utf8");
    expect(rawConfig).not.toContain("sk-openai-plaintext");
    expect(rawConfig).not.toContain("sk-skill-plaintext");
  });

  it("rejects plan targets that do not match allowed secret-bearing paths", async () => {
    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "models.providers.apiKey",
          path: "models.providers.openai.baseUrl",
          pathSegments: ["models", "providers", "openai", "baseUrl"],
          providerId: "openai",
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      ],
    };

    await expect(runSecretsApply({ plan, env, write: false })).rejects.toThrow(
      "Invalid plan target path",
    );
  });

  it("rejects plan targets with forbidden prototype-like path segments", async () => {
    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      targets: [
        {
          type: "skills.entries.apiKey",
          path: "skills.entries.__proto__.apiKey",
          pathSegments: ["skills", "entries", "__proto__", "apiKey"],
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      ],
    };

    await expect(runSecretsApply({ plan, env, write: false })).rejects.toThrow(
      "Invalid plan target path",
    );
  });

  it("applies provider upserts and deletes from plan", async () => {
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          secrets: {
            providers: {
              envmain: { source: "env" },
              fileold: { source: "file", path: "/tmp/old-secrets.json", mode: "json" },
            },
          },
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                api: "openai-completions",
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

    const plan: SecretsApplyPlan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "manual",
      providerUpserts: {
        filemain: {
          source: "file",
          path: "/tmp/new-secrets.json",
          mode: "json",
        },
      },
      providerDeletes: ["fileold"],
      targets: [],
    };

    const result = await runSecretsApply({ plan, env, write: true });
    expect(result.changed).toBe(true);

    const nextConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      secrets?: {
        providers?: Record<string, unknown>;
      };
    };
    expect(nextConfig.secrets?.providers?.fileold).toBeUndefined();
    expect(nextConfig.secrets?.providers?.filemain).toEqual({
      source: "file",
      path: "/tmp/new-secrets.json",
      mode: "json",
    });
  });
});
