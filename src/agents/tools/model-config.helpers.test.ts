import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { hasProviderAuthForTool } from "./model-config.helpers.js";

async function withTempAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tool-auth-"));
  try {
    return await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

async function writeAuthProfiles(agentDir: string, profiles: unknown) {
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "auth-profiles.json"),
    `${JSON.stringify(profiles, null, 2)}\n`,
    "utf8",
  );
}

describe("hasProviderAuthForTool", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts config-backed custom provider auth", () => {
    const cfg = {
      models: {
        providers: {
          hatchery: {
            baseUrl: "https://example.com/v1",
            apiKey: "sk-configured", // pragma: allowlist secret
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    expect(hasProviderAuthForTool({ provider: "hatchery", cfg })).toBe(true);
  });

  it("keeps auth-store profiles as valid tool auth", () => {
    expect(
      hasProviderAuthForTool({
        provider: "hatchery",
        authStore: {
          version: 1,
          profiles: {
            "hatchery:default": {
              provider: "hatchery",
              type: "api_key",
              key: "sk-profile", // pragma: allowlist secret
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("rejects aws-sdk auth because tool execution requires an API key string", () => {
    const cfg = {
      models: {
        providers: {
          "amazon-bedrock": {
            baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
            auth: "aws-sdk",
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    expect(hasProviderAuthForTool({ provider: "amazon-bedrock", cfg })).toBe(false);
  });

  it("rejects implicit amazon-bedrock aws-sdk auth for tool preflight", () => {
    expect(hasProviderAuthForTool({ provider: "amazon-bedrock", cfg: {} })).toBe(false);
  });

  it("keeps agent-local amazon-bedrock API key profiles before implicit aws-sdk rejection", async () => {
    await withTempAgentDir(async (agentDir) => {
      await writeAuthProfiles(agentDir, {
        version: 1,
        profiles: {
          "amazon-bedrock:default": {
            provider: "amazon-bedrock",
            type: "api_key",
            key: "sk-profile", // pragma: allowlist secret
          },
        },
      });

      const cfg = {
        models: {
          providers: {
            "amazon-bedrock": {
              baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
              models: [],
            },
          },
        },
      } as OpenClawConfig;

      expect(hasProviderAuthForTool({ provider: "amazon-bedrock", cfg, agentDir })).toBe(true);
    });
  });

  it("keeps agent-local API key profiles even when amazon-bedrock config defaults to aws-sdk", async () => {
    await withTempAgentDir(async (agentDir) => {
      await writeAuthProfiles(agentDir, {
        version: 1,
        profiles: {
          "amazon-bedrock:default": {
            provider: "amazon-bedrock",
            type: "api_key",
            key: "sk-profile", // pragma: allowlist secret
          },
        },
      });

      const cfg = {
        models: {
          providers: {
            "amazon-bedrock": {
              baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
              auth: "aws-sdk",
              models: [],
            },
          },
        },
      } as OpenClawConfig;

      expect(hasProviderAuthForTool({ provider: "amazon-bedrock", cfg, agentDir })).toBe(true);
    });
  });

  it("rejects providers without config, env, or profile auth", () => {
    expect(hasProviderAuthForTool({ provider: "unconfigured-provider" })).toBe(false);
  });
});
