import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { resetConfigRuntimeState, type OpenClawConfig } from "./config.js";

export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  resetConfigRuntimeState();
  try {
    return await withTempHomeBase(fn, { prefix: "openclaw-config-" });
  } finally {
    resetConfigRuntimeState();
  }
}

export async function writeOpenClawConfig(home: string, config: unknown): Promise<string> {
  const configPath = path.join(home, ".nexus-agent", "nexus-agent.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  return configPath;
}

export async function writeStateDirDotEnv(
  content: string,
  params?: {
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
  },
): Promise<{ dotEnvPath: string; stateDir: string }> {
  const stateDir = params?.stateDir ?? params?.env?.NEXUS_STATE_DIR?.trim();
  if (!stateDir) {
    throw new Error("Expected NEXUS_STATE_DIR or explicit stateDir for .env test setup");
  }
  const dotEnvPath = path.join(stateDir, ".env");
  await fs.mkdir(path.dirname(dotEnvPath), { recursive: true });
  await fs.writeFile(dotEnvPath, content, "utf-8");
  return { dotEnvPath, stateDir };
}

export async function withTempHomeConfig<T>(
  config: unknown,
  fn: (params: { home: string; configPath: string }) => Promise<T>,
): Promise<T> {
  return withTempHome(async (home) => {
    const configPath = await writeOpenClawConfig(home, config);
    return fn({ home, configPath });
  });
}

/**
 * Helper to test env var overrides. Saves/restores env vars for a callback.
 */
export async function withEnvOverride<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

export function buildWebSearchProviderConfig(params: {
  provider: NonNullable<
    NonNullable<NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>["search"]>["provider"]
  >;
  enabled?: boolean;
  providerConfig?: Record<string, unknown>;
}): Record<string, unknown> {
  const search: Record<string, unknown> = { provider: params.provider };
  if (params.enabled !== undefined) {
    search.enabled = params.enabled;
  }
  const pluginId =
    params.provider === "gemini"
      ? "google"
      : params.provider === "grok"
        ? "xai"
        : params.provider === "kimi"
          ? "moonshot"
          : params.provider;
  return {
    tools: {
      web: {
        search,
      },
    },
    ...(params.providerConfig
      ? {
          plugins: {
            entries: {
              [pluginId]: {
                config: {
                  webSearch: params.providerConfig,
                },
              },
            },
          },
        }
      : {}),
  };
}
