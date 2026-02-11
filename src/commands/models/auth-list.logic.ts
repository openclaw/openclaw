import { resolveOpenClawAgentDir } from "../../agents/agent-paths.js";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import {
  type AuthProfileStore,
  ensureAuthProfileStore,
  resolveAuthStorePathForDisplay,
} from "../../agents/auth-profiles.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { loadConfig } from "../../config/config.js";
import { shortenHomePath } from "../../utils.js";
import { type ProfileDisplayInfo, resolveProfileDisplayInfos } from "./list.auth-overview.js";
import { resolveKnownAgentId } from "./shared.js";

function collectAllProviders(store: AuthProfileStore): string[] {
  const providers = new Set<string>();
  for (const cred of Object.values(store.profiles)) {
    if (cred.provider) {
      providers.add(normalizeProviderId(cred.provider));
    }
  }
  return Array.from(providers).toSorted((a, b) => a.localeCompare(b));
}

export type ModelsAuthListOptions = {
  provider?: string;
  agent?: string;
};

export type ModelsAuthListResult = {
  agentId?: string;
  agentDir: string;
  authStorePath: string;
  profiles: ProfileDisplayInfo[];
};

export async function modelsAuthListLogic(
  opts: ModelsAuthListOptions,
): Promise<ModelsAuthListResult> {
  const cfg = loadConfig();
  const agentId = resolveKnownAgentId({ cfg, rawAgentId: opts.agent });
  const agentDir = agentId ? resolveAgentDir(cfg, agentId) : resolveOpenClawAgentDir();
  const store = ensureAuthProfileStore(agentDir);
  const authStorePath = shortenHomePath(resolveAuthStorePathForDisplay(agentDir));

  const targetProviders = opts.provider
    ? [normalizeProviderId(opts.provider.trim())]
    : collectAllProviders(store);

  const profiles: ProfileDisplayInfo[] = [];
  for (const provider of targetProviders) {
    const infos = resolveProfileDisplayInfos({ provider, cfg, store });
    profiles.push(...infos);
  }

  return {
    agentId,
    agentDir,
    authStorePath,
    profiles,
  };
}
