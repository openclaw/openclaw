import fs from "node:fs/promises";
import path from "node:path";

import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { discoverAuthStorage } from "@mariozechner/pi-coding-agent";

import { resolveClawdisAgentDir } from "../agents/agent-paths.js";
import type { ClawdisConfig } from "../config/config.js";
import { CONFIG_DIR } from "../utils.js";

export async function writeOAuthCredentials(
  provider: "anthropic",
  creds: OAuthCredentials,
): Promise<void> {
  const dir = path.join(CONFIG_DIR, "credentials");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, "oauth.json");
  let storage: Record<string, OAuthCredentials> = {};
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, OAuthCredentials>;
    if (parsed && typeof parsed === "object") storage = parsed;
  } catch {
    // ignore
  }
  storage[provider] = creds;
  await fs.writeFile(filePath, `${JSON.stringify(storage, null, 2)}\n`, "utf8");
  await fs.chmod(filePath, 0o600);
}

export async function setAnthropicApiKey(key: string) {
  const agentDir = resolveClawdisAgentDir();
  const authStorage = discoverAuthStorage(agentDir);
  authStorage.set("anthropic", { type: "api_key", key });
}

export function applyMinimaxConfig(cfg: ClawdisConfig): ClawdisConfig {
  const allowed = new Set(cfg.agent?.allowedModels ?? []);
  allowed.add("anthropic/claude-opus-4-5");
  allowed.add("lmstudio/minimax-m2.1-gs32");

  const aliases = { ...(cfg.agent?.modelAliases ?? {}) };
  if (!aliases.Opus) aliases.Opus = "anthropic/claude-opus-4-5";
  if (!aliases.Minimax) aliases.Minimax = "lmstudio/minimax-m2.1-gs32";

  const providers = { ...(cfg.models?.providers ?? {}) };
  if (!providers.lmstudio) {
    providers.lmstudio = {
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "lmstudio",
      api: "openai-responses",
      models: [
        {
          id: "minimax-m2.1-gs32",
          name: "MiniMax M2.1 GS32",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 196608,
          maxTokens: 8192,
        },
      ],
    };
  }

  return {
    ...cfg,
    agent: {
      ...cfg.agent,
      model: "Minimax",
      allowedModels: Array.from(allowed),
      modelAliases: aliases,
    },
    models: {
      mode: cfg.models?.mode ?? "merge",
      providers,
    },
  };
}
