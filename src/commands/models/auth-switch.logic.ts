import { resolveOpenClawAgentDir } from "../../agents/agent-paths.js";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import {
  type AuthProfileStore,
  ensureAuthProfileStore,
  listProfilesForProvider,
  setAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { loadConfig } from "../../config/config.js";
import { resolveProfileDisplayInfos, type ProfileDisplayInfo } from "./list.auth-overview.js";
import { resolveKnownAgentId } from "./shared.js";

export type AuthSwitchContext = {
  cfg: ReturnType<typeof loadConfig>;
  agentDir: string;
  store: AuthProfileStore;
  provider: string;
};

export function getAuthSwitchContext(opts: {
  provider: string;
  agent?: string;
}): AuthSwitchContext {
  const cfg = loadConfig();
  const provider = normalizeProviderId(opts.provider.trim());
  const agentId = resolveKnownAgentId({ cfg, rawAgentId: opts.agent });
  const agentDir = agentId ? resolveAgentDir(cfg, agentId) : resolveOpenClawAgentDir();
  const store = ensureAuthProfileStore(agentDir);
  return { cfg, agentDir, store, provider };
}

export function getSwitchableProfiles(ctx: AuthSwitchContext): {
  profileIds: string[];
  displayInfos: ProfileDisplayInfo[];
} {
  const profileIds = listProfilesForProvider(ctx.store, ctx.provider);
  const displayInfos = resolveProfileDisplayInfos({
    provider: ctx.provider,
    cfg: ctx.cfg,
    store: ctx.store,
  });
  return { profileIds, displayInfos };
}

export async function performAuthSwitch(
  ctx: AuthSwitchContext,
  targetProfileId: string,
): Promise<void> {
  const profileIds = listProfilesForProvider(ctx.store, ctx.provider);

  if (!profileIds.includes(targetProfileId)) {
    throw new Error(
      `Auth profile "${targetProfileId}" not found for provider "${ctx.provider}". Available: ${profileIds.join(", ")}`,
    );
  }

  // Build new order: selected profile first, then remaining profiles
  const newOrder = [targetProfileId, ...profileIds.filter((id) => id !== targetProfileId)];

  const updated = await setAuthProfileOrder({
    agentDir: ctx.agentDir,
    provider: ctx.provider,
    order: newOrder,
  });

  if (!updated) {
    throw new Error("Failed to update auth-profiles.json (lock busy?).");
  }
}
