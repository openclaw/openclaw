import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { saveAuthProfileStore } from "../agents/auth-profiles.js";
import { clearConfigCache } from "../config/config.js";
import { modelsListCommand } from "./models/list.list-command.js";

const ENV_KEYS = [
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENROUTER_API_KEY",
] as const;

function captureEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await fs.stat(pathname);
    return true;
  } catch {
    return false;
  }
}

describe("models list auth-profile sync", () => {
  it("marks models available when auth exists only in auth-profiles.json", async () => {
    const env = captureEnv();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-models-list-auth-sync-"));

    try {
      const stateDir = path.join(root, "state");
      const agentDir = path.join(stateDir, "agents", "main", "agent");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(configPath, "{}\n", "utf8");

      process.env.OPENCLAW_STATE_DIR = stateDir;
      process.env.OPENCLAW_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      delete process.env.OPENROUTER_API_KEY;

      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "openrouter:default": {
              type: "api_key",
              provider: "openrouter",
              key: "sk-or-v1-regression-test",
            },
          },
        },
        agentDir,
      );

      const authPath = path.join(agentDir, "auth.json");
      expect(await pathExists(authPath)).toBe(false);

      clearConfigCache();
      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
      };

      await modelsListCommand({ all: true, json: true }, runtime as never);

      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.log).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
        models?: Array<{ key?: string; available?: boolean }>;
      };
      const openrouter = payload.models?.find((model) =>
        String(model.key ?? "").startsWith("openrouter/"),
      );
      expect(openrouter).toBeDefined();
      expect(openrouter?.available).toBe(true);
      expect(await pathExists(authPath)).toBe(true);
    } finally {
      clearConfigCache();
      restoreEnv(env);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
