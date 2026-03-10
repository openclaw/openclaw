import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  ensureAuthProfileStore,
  updateAuthProfileStoreWithLock,
} from "../../agents/auth-profiles.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import type { RuntimeEnv } from "../../runtime.js";
import { shortenHomePath } from "../../utils.js";
import { loadModelsConfig } from "./load-config.js";
import { resolveKnownAgentId } from "./shared.js";

/**
 * Remove stale profiles from auth-profiles.json that are no longer present in
 * openclaw.json auth.profiles. Prevents ghost profiles (e.g. anthropic:manual,
 * anthropic:user-me.com) from accumulating and silently corrupting auth order.
 *
 * Fixes: https://github.com/openclaw/openclaw/issues/41634
 */
export async function modelsAuthCleanCommand(
  opts: { agent?: string; dryRun?: boolean; json?: boolean },
  runtime: RuntimeEnv,
): Promise<void> {
  const cfg = await loadModelsConfig({ commandName: "models auth clean", runtime });
  const agentId = resolveKnownAgentId({ cfg, rawAgentId: opts.agent }) ?? resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, agentId);
  const authStorePath = shortenHomePath(`${agentDir}/auth-profiles.json`);

  // Collect profile ids that are explicitly configured in openclaw.json auth.profiles
  const configuredProfiles = new Set<string>(
    Object.keys(cfg.auth?.profiles ?? {}).map((id) => id.trim()).filter(Boolean),
  );

  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const storeProfileIds = Object.keys(store.profiles);

  const toRemove = storeProfileIds.filter((id) => !configuredProfiles.has(id));
  const toKeep = storeProfileIds.filter((id) => configuredProfiles.has(id));

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          agentId,
          agentDir,
          authStorePath,
          configuredProfiles: [...configuredProfiles],
          storeProfiles: storeProfileIds,
          toRemove,
          toKeep,
          dryRun: opts.dryRun ?? false,
        },
        null,
        2,
      ),
    );
    if (opts.dryRun || toRemove.length === 0) return;
  } else {
    runtime.log(`Agent:      ${agentId}`);
    runtime.log(`Auth file:  ${authStorePath}`);
    runtime.log(`Configured: ${[...configuredProfiles].join(", ") || "(none)"}`);
    runtime.log(`In store:   ${storeProfileIds.join(", ") || "(none)"}`);
  }

  if (toRemove.length === 0) {
    if (!opts.json) runtime.log("Nothing to clean up.");
    return;
  }

  if (!opts.json) {
    runtime.log(`\nProfiles to remove (${toRemove.length}):`);
    for (const id of toRemove) runtime.log(`  - ${id}`);
    runtime.log(`Profiles to keep (${toKeep.length}):`);
    for (const id of toKeep) runtime.log(`  + ${id}`);
  }

  if (opts.dryRun) {
    if (!opts.json) runtime.log("\n(dry run -- no changes written)");
    return;
  }

  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      let removed = 0;
      for (const id of toRemove) {
        if (id in freshStore.profiles) {
          delete freshStore.profiles[id];
          removed++;
        }
      }
      // Drop removed ids from the order array as well
      for (const provider of Object.keys(freshStore.order ?? {})) {
        const existing = freshStore.order[provider];
        if (Array.isArray(existing)) {
          freshStore.order[provider] = existing.filter((id) => !toRemove.includes(id));
        }
      }
      // Drop removed ids from usageStats
      for (const id of toRemove) {
        delete freshStore.usageStats?.[id];
      }
      return removed > 0;
    },
  });

  if (!updated) {
    throw new Error("Failed to update auth-profiles.json (lock busy or no changes needed).");
  }

  if (!opts.json) {
    runtime.log(`\nRemoved ${toRemove.length} stale profile(s). Restart the gateway to apply.`);
  }
}
