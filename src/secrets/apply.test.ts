import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSecretsApply } from "./apply.js";
import type { SecretsApplyPlan } from "./plan.js";

const OPENAI_API_KEY_ENV_REF = {
  source: "env",
  provider: "default",
  id: "OPENAI_API_KEY",
} as const;

type ApplyFixture = {
  rootDir: string;
  stateDir: string;
  configPath: string;
  authStorePath: string;
  authJsonPath: string;
  envPath: string;
  env: NodeJS.ProcessEnv;
};

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

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createOpenAiProviderConfig(apiKey: unknown = "sk-openai-plaintext") {
  return {
    baseUrl: "https://api.openai.com/v1",
    api: "openai-completions",
    apiKey,
    models: [{ id: "gpt-5", name: "gpt-5" }],
  };
}

function buildFixturePaths(rootDir: string) {
  const stateDir = path.join(rootDir, ".openclaw");
  return {
    rootDir,
    stateDir,
    configPath: path.join(stateDir, "openclaw.json"),
    authStorePath: path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"),
    authJsonPath: path.join(stateDir, "agents", "main", "agent", "auth.json"),
    envPath: path.join(stateDir, ".env"),
  };
}

async function createApplyFixture(): Promise<ApplyFixture> {
  const paths = buildFixturePaths(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-apply-")),
  );
  await fs.mkdir(path.dirname(paths.configPath), { recursive: true });
  await fs.mkdir(path.dirname(paths.authStorePath), { recursive: true });
  return {
    ...paths,
    env: {
      OPENCLAW_STATE_DIR: paths.stateDir,
      OPENCLAW_CONFIG_PATH: paths.configPath,
      OPENAI_API_KEY: "sk-live-env",
    },
  };
}

async function seedDefaultApplyFixture(fixture: ApplyFixture): Promise<void> {
  await writeJsonFile(fixture.configPath, {
    models: {
      providers: {
        openai: createOpenAiProviderConfig(),
      },
    },
  });
  await writeJsonFile(fixture.authStorePath, {
    version: 1,
    profiles: {
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key: "sk-openai-plaintext",
      },
    },
  });
  await writeJsonFile(fixture.authJsonPath, {
    openai: {
      type: "api_key",
      key: "sk-openai-plaintext",
    },
  });
  await fs.writeFile(
    fixture.envPath,
    "OPENAI_API_KEY=sk-openai-plaintext\nUNRELATED=value\n",
    "utf8",
  );
}

async function applyPlanAndReadConfig<T>(
  fixture: ApplyFixture,
  plan: SecretsApplyPlan,
): Promise<T> {
  const result = await runSecretsApply({ plan, env: fixture.env, write: true });
  expect(result.changed).toBe(true);
  return JSON.parse(await fs.readFile(fixture.configPath, "utf8")) as T;
}

async function expectInvalidTargetPath(
  fixture: ApplyFixture,
  target: SecretsApplyPlan["targets"][number],
): Promise<void> {
  const plan = createPlan({ targets: [target] });
  await expect(runSecretsApply({ plan, env: fixture.env, write: false })).rejects.toThrow(
    "Invalid plan target path",
  );
}

function createPlan(params: {
  targets: SecretsApplyPlan["targets"];
  options?: SecretsApplyPlan["options"];
  providerUpserts?: SecretsApplyPlan["providerUpserts"];
  providerDeletes?: SecretsApplyPlan["providerDeletes"];
}): SecretsApplyPlan {
  return {
    version: 1,
    protocolVersion: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: "manual",
    targets: params.targets,
    ...(params.options ? { options: params.options } : {}),
    ...(params.providerUpserts ? { providerUpserts: params.providerUpserts } : {}),
    ...(params.providerDeletes ? { providerDeletes: params.providerDeletes } : {}),
  };
}

function createOpenAiProviderTarget(params?: {
  path?: string;
  pathSegments?: string[];
  providerId?: string;
}): SecretsApplyPlan["targets"][number] {
  return {
    type: "models.providers.apiKey",
    path: params?.path ?? "models.providers.openai.apiKey",
    ...(params?.pathSegments ? { pathSegments: params.pathSegments } : {}),
    providerId: params?.providerId ?? "openai",
    ref: OPENAI_API_KEY_ENV_REF,
  };
}

function createOneWayScrubOptions(): NonNullable<SecretsApplyPlan["options"]> {
  return {
    scrubEnv: true,
    scrubAuthProfilesForProviderTargets: true,
    scrubLegacyAuthJson: true,
  };
}

describe("secrets apply", () => {
  let fixture: ApplyFixture;

  beforeEach(async () => {
    fixture = await createApplyFixture();
    await seedDefaultApplyFixture(fixture);
  });

  afterEach(async () => {
    await fs.rm(fixture.rootDir, { recursive: true, force: true });
  });

  it("preflights and applies one-way scrub without plaintext backups", async () => {
    const plan = createPlan({
      targets: [createOpenAiProviderTarget()],
      options: createOneWayScrubOptions(),
    });

    const dryRun = await runSecretsApply({ plan, env: fixture.env, write: false });
    expect(dryRun.mode).toBe("dry-run");
    expect(dryRun.changed).toBe(true);

    const applied = await runSecretsApply({ plan, env: fixture.env, write: true });
    expect(applied.mode).toBe("write");
    expect(applied.changed).toBe(true);

    const nextConfig = JSON.parse(await fs.readFile(fixture.configPath, "utf8")) as {
      models: { providers: { openai: { apiKey: unknown } } };
    };
    expect(nextConfig.models.providers.openai.apiKey).toEqual(OPENAI_API_KEY_ENV_REF);

    const nextAuthStore = JSON.parse(await fs.readFile(fixture.authStorePath, "utf8")) as {
      profiles: { "openai:default": { key?: string; keyRef?: unknown } };
    };
    expect(nextAuthStore.profiles["openai:default"].key).toBeUndefined();
    expect(nextAuthStore.profiles["openai:default"].keyRef).toBeUndefined();

    const nextAuthJson = JSON.parse(await fs.readFile(fixture.authJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(nextAuthJson.openai).toBeUndefined();

    const nextEnv = await fs.readFile(fixture.envPath, "utf8");
    expect(nextEnv).not.toContain("sk-openai-plaintext");
    expect(nextEnv).toContain("UNRELATED=value");
  });

  it("is idempotent on repeated write applies", async () => {
    const plan = createPlan({
      targets: [createOpenAiProviderTarget()],
      options: createOneWayScrubOptions(),
    });

    const first = await runSecretsApply({ plan, env: fixture.env, write: true });
    expect(first.changed).toBe(true);
    const configAfterFirst = await fs.readFile(fixture.configPath, "utf8");
    const authStoreAfterFirst = await fs.readFile(fixture.authStorePath, "utf8");
    const authJsonAfterFirst = await fs.readFile(fixture.authJsonPath, "utf8");
    const envAfterFirst = await fs.readFile(fixture.envPath, "utf8");

    await fs.chmod(fixture.configPath, 0o400);
    await fs.chmod(fixture.authStorePath, 0o400);

    const second = await runSecretsApply({ plan, env: fixture.env, write: true });
    expect(second.mode).toBe("write");
    const configAfterSecond = await fs.readFile(fixture.configPath, "utf8");
    expect(stripVolatileConfigMeta(configAfterSecond)).toEqual(
      stripVolatileConfigMeta(configAfterFirst),
    );
    await expect(fs.readFile(fixture.authStorePath, "utf8")).resolves.toBe(authStoreAfterFirst);
    await expect(fs.readFile(fixture.authJsonPath, "utf8")).resolves.toBe(authJsonAfterFirst);
    await expect(fs.readFile(fixture.envPath, "utf8")).resolves.toBe(envAfterFirst);
  });

  it("applies targets safely when map keys contain dots", async () => {
    await writeJsonFile(fixture.configPath, {
      models: {
        providers: {
          "openai.dev": createOpenAiProviderConfig(),
        },
      },
    });

    const plan = createPlan({
      targets: [
        createOpenAiProviderTarget({
          path: "models.providers.openai.dev.apiKey",
          pathSegments: ["models", "providers", "openai.dev", "apiKey"],
          providerId: "openai.dev",
        }),
      ],
      options: {
        scrubEnv: false,
        scrubAuthProfilesForProviderTargets: false,
        scrubLegacyAuthJson: false,
      },
    });

    const nextConfig = await applyPlanAndReadConfig<{
      models?: {
        providers?: Record<string, { apiKey?: unknown }>;
      };
    }>(fixture, plan);
    expect(nextConfig.models?.providers?.["openai.dev"]?.apiKey).toEqual(OPENAI_API_KEY_ENV_REF);
    expect(nextConfig.models?.providers?.openai).toBeUndefined();
  });

  it("migrates skills entries apiKey targets alongside provider api keys", async () => {
    await writeJsonFile(fixture.configPath, {
      models: {
        providers: {
          openai: createOpenAiProviderConfig(),
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
    });

    const plan = createPlan({
      targets: [
        createOpenAiProviderTarget({ pathSegments: ["models", "providers", "openai", "apiKey"] }),
        {
          type: "skills.entries.apiKey",
          path: "skills.entries.qa-secret-test.apiKey",
          pathSegments: ["skills", "entries", "qa-secret-test", "apiKey"],
          ref: OPENAI_API_KEY_ENV_REF,
        },
      ],
      options: createOneWayScrubOptions(),
    });

    const nextConfig = await applyPlanAndReadConfig<{
      models: { providers: { openai: { apiKey: unknown } } };
      skills: { entries: { "qa-secret-test": { apiKey: unknown } } };
    }>(fixture, plan);
    expect(nextConfig.models.providers.openai.apiKey).toEqual(OPENAI_API_KEY_ENV_REF);
    expect(nextConfig.skills.entries["qa-secret-test"].apiKey).toEqual(OPENAI_API_KEY_ENV_REF);

    const rawConfig = await fs.readFile(fixture.configPath, "utf8");
    expect(rawConfig).not.toContain("sk-openai-plaintext");
    expect(rawConfig).not.toContain("sk-skill-plaintext");
  });

  it.each([
    createOpenAiProviderTarget({
      path: "models.providers.openai.baseUrl",
      pathSegments: ["models", "providers", "openai", "baseUrl"],
    }),
    {
      type: "skills.entries.apiKey",
      path: "skills.entries.__proto__.apiKey",
      pathSegments: ["skills", "entries", "__proto__", "apiKey"],
      ref: OPENAI_API_KEY_ENV_REF,
    } satisfies SecretsApplyPlan["targets"][number],
  ])("rejects invalid target path: %s", async (target) => {
    await expectInvalidTargetPath(fixture, target);
  });

  it("applies provider upserts and deletes from plan", async () => {
    await writeJsonFile(fixture.configPath, {
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
    });

    const plan = createPlan({
      providerUpserts: {
        filemain: {
          source: "file",
          path: "/tmp/new-secrets.json",
          mode: "json",
        },
      },
      providerDeletes: ["fileold"],
      targets: [],
    });

    const nextConfig = await applyPlanAndReadConfig<{
      secrets?: {
        providers?: Record<string, unknown>;
      };
    }>(fixture, plan);
    expect(nextConfig.secrets?.providers?.fileold).toBeUndefined();
    expect(nextConfig.secrets?.providers?.filemain).toEqual({
      source: "file",
      path: "/tmp/new-secrets.json",
      mode: "json",
    });
  });
});
