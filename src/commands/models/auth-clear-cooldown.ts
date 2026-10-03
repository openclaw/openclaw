/** Command for clearing persisted cooldown state after an early provider recovery. */
import { clearAuthProfileCooldown, ensureAuthProfileStore } from "../../agents/auth-profiles.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { quoteCliArg } from "../../cli/quote-cli-arg.js";
import type { RuntimeEnv } from "../../runtime.js";
import { refreshRunningGatewayAuthState } from "./auth-refresh.js";
import { loadModelsConfig } from "./load-config.js";
import { resolveModelsTargetAgent } from "./shared.js";

/** Clears cooldown, block, and disable windows for one saved profile without touching credentials. */
export async function modelsAuthClearCooldownCommand(
  opts: { profileId: string; agent?: string },
  runtime: RuntimeEnv,
): Promise<void> {
  const profileId = opts.profileId.trim();
  const cfg = await loadModelsConfig({ commandName: "models auth clear-cooldown", runtime });
  const { agentId, agentDir } = resolveModelsTargetAgent(cfg, opts.agent, { kind: "mutation" });
  const store = ensureAuthProfileStore(agentDir);
  if (!Object.hasOwn(store.profiles, profileId)) {
    throw new Error(
      `Auth profile "${profileId}" not found. Run ${formatCliCommand("openclaw models auth list")} to see saved profiles.`,
    );
  }
  // One owner-routed write: inherited profiles persist health only in their owning store.
  if (!(await clearAuthProfileCooldown({ store, profileId, agentDir }))) {
    // The retry must reach the same store, so keep the requested agent and quote the id.
    const agentOption = opts.agent ? ` --agent ${quoteCliArg(opts.agent)}` : "";
    const retry = formatCliCommand(
      `openclaw models auth clear-cooldown ${quoteCliArg(profileId)}${agentOption}`,
    );
    throw new Error(
      `Failed to update auth state; the auth state lock may be busy. Wait a moment and rerun ${retry}.`,
    );
  }

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Cleared cooldown state for auth profile "${profileId}".`);
  runtime.log(
    "The next request re-checks the provider and records a new cooldown if the failure still applies.",
  );
  await refreshRunningGatewayAuthState(agentId, "update", runtime);
}
