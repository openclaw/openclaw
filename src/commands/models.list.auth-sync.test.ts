import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AuthProfileStore,
  resolveApiKeyForProfile,
  saveAuthProfileStore,
} from "../agents/auth-profiles.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { withEnvAsync } from "../test-utils/env.js";
import { toModelRow } from "./models/list.registry.js";

const OPENROUTER_MODEL = {
  provider: "openrouter",
  id: "openai/gpt-5.4",
  name: "GPT-5.4 via OpenRouter",
  api: "openai-chat-completions",
  baseUrl: "https://openrouter.ai/api/v1",
  input: ["text"],
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const;

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await fs.stat(pathname);
    return true;
  } catch {
    return false;
  }
}

type AuthSyncFixture = {
  root: string;
  stateDir: string;
  agentDir: string;
  configPath: string;
  authPath: string;
};

async function withAuthSyncFixture(run: (fixture: AuthSyncFixture) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-models-list-auth-sync-"));
  try {
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const configPath = path.join(stateDir, "openclaw.json");
    const authPath = path.join(agentDir, "auth.json");

    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(configPath, "{}\n", "utf8");

    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_AGENT_DIR: agentDir,
        PI_CODING_AGENT_DIR: agentDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENROUTER_API_KEY: undefined,
      },
      async () => {
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        await run({ root, stateDir, agentDir, configPath, authPath });
      },
    );
  } finally {
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("models list auth-profile sync", () => {
  it("marks models available when auth exists only in auth-profiles.json", async () => {
    await withAuthSyncFixture(async ({ agentDir, authPath }) => {
      const authStore: AuthProfileStore = {
        version: 1,
        profiles: {
          "openrouter:default": {
            type: "api_key",
            provider: "openrouter",
            key: "sk-or-v1-regression-test",
          },
        },
      };
      saveAuthProfileStore(authStore, agentDir);

      expect(await pathExists(authPath)).toBe(false);

      const row = toModelRow({
        model: OPENROUTER_MODEL as never,
        key: "openrouter/openai/gpt-5.4",
        tags: [],
        cfg: {},
        authStore,
      });
      expect(row.available).toBe(true);
      expect(await pathExists(authPath)).toBe(false);
    });
  });

  it("does not persist blank auth-profile credentials", async () => {
    await withAuthSyncFixture(async ({ agentDir, authPath }) => {
      const authStore: AuthProfileStore = {
        version: 1,
        profiles: {
          "openrouter:default": {
            type: "api_key",
            provider: "openrouter",
            key: "   ",
          },
        },
      };
      saveAuthProfileStore(authStore, agentDir);

      await expect(
        resolveApiKeyForProfile({
          cfg: {},
          store: authStore,
          profileId: "openrouter:default",
          agentDir,
        }),
      ).resolves.toBeNull();
      if (await pathExists(authPath)) {
        const parsed = JSON.parse(await fs.readFile(authPath, "utf8")) as Record<
          string,
          { type?: string; key?: string }
        >;
        const openrouterKey = parsed.openrouter?.key;
        if (openrouterKey !== undefined) {
          expect(openrouterKey.trim().length).toBeGreaterThan(0);
        }
      }
    });
  });
});
