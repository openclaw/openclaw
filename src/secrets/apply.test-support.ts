import fs from "node:fs/promises";
import path from "node:path";
import { createAuthProfileStoreFixture } from "../agents/auth-profiles/credential-fixtures.test-support.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";

export const OPENAI_API_KEY_ENV_REF = {
  source: "env",
  provider: "default",
  id: "OPENAI_API_KEY",
} as const;

export type ApplyFixture = {
  rootDir: string;
  stateDir: string;
  configPath: string;
  agentDir: string;
  authStorePath: string;
  authJsonPath: string;
  envPath: string;
  env: NodeJS.ProcessEnv;
};

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  if (path.basename(filePath) === "openclaw-agent.sqlite") {
    saveAuthProfileStore(value as AuthProfileStore, path.dirname(filePath), {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
    return;
  }
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readAuthStore(fixture: ApplyFixture): Promise<AuthProfileStore> {
  const { loadPersistedAuthProfileStore } = await import("../agents/auth-profiles/persisted.js");
  return loadPersistedAuthProfileStore(fixture.agentDir) ?? { version: 1, profiles: {} };
}

export function createOpenAiProviderConfig(apiKey: unknown = "sk-openai-plaintext") {
  return {
    baseUrl: "https://api.openai.com/v1",
    api: "openai-completions",
    apiKey,
    models: [{ id: "gpt-5", name: "gpt-5" }],
  };
}

function buildFixturePaths(rootDir: string) {
  const stateDir = path.join(rootDir, ".openclaw");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  return {
    rootDir,
    stateDir,
    configPath: path.join(stateDir, "openclaw.json"),
    agentDir,
    authStorePath: resolveAuthProfileDatabasePath(agentDir),
    authJsonPath: path.join(agentDir, "auth.json"),
    envPath: path.join(stateDir, ".env"),
  };
}

export async function createApplyFixture(rootDir: string): Promise<ApplyFixture> {
  const paths = buildFixturePaths(rootDir);
  await fs.mkdir(paths.agentDir, { recursive: true });
  return {
    ...paths,
    env: {
      OPENCLAW_STATE_DIR: paths.stateDir,
      OPENCLAW_CONFIG_PATH: paths.configPath,
      OPENAI_API_KEY: "sk-live-env", // pragma: allowlist secret
    },
  };
}

export async function seedDefaultApplyFixture(fixture: ApplyFixture): Promise<void> {
  await writeJsonFile(fixture.configPath, {
    models: {
      providers: {
        openai: createOpenAiProviderConfig(),
      },
    },
  });
  await writeJsonFile(
    fixture.authStorePath,
    createAuthProfileStoreFixture({
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key: "sk-ope...text", // pragma: allowlist secret
        keyRef: OPENAI_API_KEY_ENV_REF,
      },
    }),
  );
  await writeJsonFile(fixture.authJsonPath, {
    openai: {
      type: "api_key",
      key: "sk-openai-plaintext", // pragma: allowlist secret
    },
  });
  await fs.writeFile(
    fixture.envPath,
    "OPENAI_API_KEY=sk-openai-plaintext\nUNRELATED=value\n", // pragma: allowlist secret
    "utf8",
  );
}
