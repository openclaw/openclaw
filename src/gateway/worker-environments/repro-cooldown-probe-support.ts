import fs from "node:fs/promises";
import path from "node:path";
import { updateAuthProfileStoreWithLock } from "../../agents/auth-profiles/store-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export const PROBE_PROOF_MODEL = "gpt-probe-fixture";

export function probeProofAgentDir(root: string, agentId: string): string {
  return path.join(root, "state", "agents", agentId, "agent");
}

export function createProbeProofConfig(params: {
  agentId: string;
  agentDir: string;
  profileId: string;
  workspaceDir: string;
  sessionStorePath: string;
  endpoint: string;
}): OpenClawConfig {
  const model = PROBE_PROOF_MODEL;
  return {
    session: { store: params.sessionStorePath },
    agents: {
      entries: { [params.agentId]: { agentDir: params.agentDir, workspace: params.workspaceDir } },
      defaults: {
        skipBootstrap: true,
        model: { primary: `openai/${model}`, fallbacks: [] },
        models: {
          [`openai/${model}`]: { agentRuntime: { id: "openclaw" } },
          "openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } },
        },
      },
    },
    auth: { order: { openai: [params.profileId] } },
    models: {
      providers: {
        openai: {
          api: "openai-completions",
          baseUrl: params.endpoint,
          apiKey: "synthetic-loopback-key",
          models: [model, "gpt-5.6-luna"].map((id) => ({
            id,
            name: id,
            api: "openai-completions" as const,
            reasoning: false,
            input: ["text"] as const,
            contextWindow: 16_000,
            maxTokens: 512,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          })),
        },
      },
    },
    plugins: { slots: { memory: "none" } },
    skills: { load: { watch: false } },
    tools: { deny: ["*"] },
  };
}

export async function writeProbeProofCooldown(params: {
  root: string;
  agentId: string;
  profileId: string;
}): Promise<void> {
  const agentDir = probeProofAgentDir(params.root, params.agentId);
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ retry: { provider: { maxRetries: 0 } } }),
  );
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
    updater(store) {
      store.profiles[params.profileId] = {
        type: "api_key",
        provider: "openai",
        key: "synthetic-loopback-key",
      };
      store.usageStats = {
        ...store.usageStats,
        [params.profileId]: {
          cooldownUntil: Date.now() + 120_000,
          cooldownReason: "rate_limit",
          cooldownModel: PROBE_PROOF_MODEL,
        },
      };
      return true;
    },
  });
  if (!updated) {
    throw new Error("Unable to write isolated probe-proof auth profile");
  }
}
