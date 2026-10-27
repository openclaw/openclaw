import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
  createOAuthRefreshCredential,
} from "../agents/auth-profiles/credential-fixtures.test-support.js";
import {
  readPersistedAuthProfileStateRaw,
  readPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
} from "../agents/auth-profiles/sqlite.js";
import * as authStore from "../agents/auth-profiles/store-runtime.js";
import type {
  AuthProfileSecretsStore,
  AuthProfileState,
  AuthProfileStore,
} from "../agents/auth-profiles/types.js";

export const OPENAI_API_KEY_ENV_REF = {
  source: "env",
  provider: "default",
  id: "OPENAI_API_KEY",
} as const;

export type ApplyFixture = Awaited<ReturnType<typeof createApplyFixture>>;
const PLAINTEXT_KEY = "sk-openai-plaintext"; // pragma: allowlist secret

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  if (path.basename(filePath) === "openclaw-agent.sqlite") {
    authStore.saveAuthProfileStore(value as AuthProfileStore, path.dirname(filePath), {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
  } else {
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
}

export async function readAuthStore(fixture: ApplyFixture): Promise<AuthProfileStore> {
  const { loadPersistedAuthProfileStore } = await import("../agents/auth-profiles/persisted.js");
  return loadPersistedAuthProfileStore(fixture.agentDir) ?? { version: 1, profiles: {} };
}

export function createOpenAiProviderConfig(apiKey: unknown = PLAINTEXT_KEY) {
  return {
    baseUrl: "https://api.openai.com/v1",
    api: "openai-completions",
    apiKey,
    models: [{ id: "gpt-5", name: "gpt-5" }],
  };
}

export async function createApplyFixture(rootDir: string) {
  const stateDir = path.join(rootDir, ".openclaw");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const configPath = path.join(stateDir, "openclaw.json");
  const env: NodeJS.ProcessEnv = {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENAI_API_KEY: "sk-live-env", // pragma: allowlist secret
  };
  await fs.mkdir(agentDir, { recursive: true });
  return {
    rootDir,
    stateDir,
    configPath,
    agentDir,
    authStorePath: resolveAuthProfileDatabasePath(agentDir),
    authJsonPath: path.join(agentDir, "auth.json"),
    envPath: path.join(stateDir, ".env"),
    env,
  };
}

export async function seedDefaultApplyFixture(fixture: ApplyFixture): Promise<void> {
  const { configPath, authStorePath, authJsonPath, envPath } = fixture;
  const openai = createOpenAiProviderConfig();
  const profile = {
    ...createApiKeyCredential("openai", "sk-ope...text"), // pragma: allowlist secret
    keyRef: OPENAI_API_KEY_ENV_REF,
  };
  await writeJsonFile(configPath, { models: { providers: { openai } } });
  await writeJsonFile(authStorePath, createAuthProfileStoreFixture({ "openai:default": profile }));
  await writeJsonFile(authJsonPath, { openai: { type: "api_key", key: PLAINTEXT_KEY } });
  await fs.writeFile(envPath, `OPENAI_API_KEY=${PLAINTEXT_KEY}\nUNRELATED=value\n`, "utf8");
}

export function mutateAuthStoreBeforeNextPublication(
  agentDir: string,
  concurrentMutation: "credentials" | "state",
): void {
  const method = "saveAuthProfileStoreIfPersistenceSnapshotMatches";
  const save = authStore[method];
  vi.spyOn(authStore, method).mockImplementationOnce((params) => {
    const committed = save(params);
    const publish = committed.publishRuntimeSnapshots;
    committed.publishRuntimeSnapshots = () => {
      // Mutate after commit, before ownership capture; rollback must retain this newer writer.
      const concurrentStore: AuthProfileStore = {
        ...(readPersistedAuthProfileStoreRaw(agentDir) as AuthProfileSecretsStore),
        ...(readPersistedAuthProfileStateRaw(agentDir) as AuthProfileState | null),
      };
      if (concurrentMutation === "credentials") {
        concurrentStore.profiles["openai:oauth"] = createOAuthRefreshCredential({
          access: "oauth-concurrent",
          refresh: "refresh-concurrent",
          expires: Date.now() + 120_000,
        });
      } else {
        concurrentStore.order = { openai: ["openai:oauth", "openai:default"] };
      }
      authStore.saveAuthProfileStore(concurrentStore, agentDir, { syncExternalCli: false });
      return publish();
    };
    return committed;
  });
}
