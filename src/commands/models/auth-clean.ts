import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { ensureAuthProfileStore } from "../../agents/auth-profiles.js";
import {
  loadAgentLocalAuthProfileStore,
  updateAuthProfileStoreWithLock,
} from "../../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import type { MediaToolsConfig, MediaUnderstandingModelConfig } from "../../config/types.tools.js";
import type { RuntimeEnv } from "../../runtime.js";
import { shortenHomePath } from "../../utils.js";
import { loadModelsConfig } from "./load-config.js";
import { resolveKnownAgentId } from "./shared.js";

/**
 * Collect all auth profile ids referenced in tools.media config
 * (top-level models array + per-media-type image/audio/video models).
 * These are consumed by resolveProviderExecutionAuth and must not be pruned.
 */
function collectMediaProfileIds(cfg: Awaited<ReturnType<typeof loadModelsConfig>>): Set<string> {
  const ids = new Set<string>();

  function addFromModels(models: MediaUnderstandingModelConfig[] | undefined): void {
    for (const m of models ?? []) {
      if (m.profile) {
        ids.add(m.profile);
      }
      if (m.preferredProfile) {
        ids.add(m.preferredProfile);
      }
    }
  }

  // Scan top-level tools.media if present.
  const media = cfg.tools?.media;
  if (media) {
    addFromModels(media.models);
    addFromModels(media.image?.models);
    addFromModels(media.audio?.models);
    addFromModels(media.video?.models);
  }

  // Always scan per-agent tool overrides, even when cfg.tools.media is absent.
  // Agent-level overrides may reference profiles not present at the top level;
  // skipping them would cause those profiles to be treated as stale and wrongly pruned.
  for (const agent of cfg.agents?.list ?? []) {
    const agentMedia = (agent as { tools?: { media?: MediaToolsConfig } }).tools?.media;
    if (!agentMedia) {
      continue;
    }
    addFromModels(agentMedia.models);
    addFromModels(agentMedia.image?.models);
    addFromModels(agentMedia.audio?.models);
    addFromModels(agentMedia.video?.models);
  }

  return ids;
}

/**
 * Sanitize a profile ID string for safe output in terminal/log messages.
 * Strips ANSI/VT escape sequences and newlines to prevent terminal injection
 * (log forging) via maliciously crafted profile IDs.
 */
function sanitizeProfileId(id: string): string {
  // eslint-disable-next-line no-control-regex
  return id.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/[\r\n]/g, "");
}

/**
 * Remove stale profiles from auth-profiles.json that are no longer present in
 * openclaw.json auth.profiles, auth.order, or tools.media model entries.
 * Prevents ghost profiles (e.g. anthropic:manual, anthropic:user-me.com) from
 * accumulating and silently corrupting auth order.
 *
 * Fixes: https://github.com/openclaw/openclaw/issues/41634
 */
export async function modelsAuthCleanCommand(
  opts: { agent?: string; dryRun?: boolean; json?: boolean },
  runtime: RuntimeEnv,
): Promise<void> {
  const cfg = await loadModelsConfig({ commandName: "models auth clean", runtime });
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const agentId = resolveKnownAgentId({ cfg, rawAgentId: opts.agent }) ?? defaultAgentId;
  const agentDir = resolveAgentDir(cfg, agentId);
  const authStorePath = shortenHomePath(`${agentDir}/auth-profiles.json`);

  // For non-default agents, ensureAuthProfileStore returns a merged (main + agent-local)
  // view. toRemove must be derived from the agent-local-only profile set because the
  // write via updateAuthProfileStoreWithLock targets only the agent-local file. Profiles
  // that exist exclusively in the main store must never appear in toRemove.
  const isDefaultAgent = agentId === defaultAgentId;

  // Collect profile ids that are explicitly configured: union of auth.profiles keys,
  // ids referenced in auth.order, and ids pinned in tools.media model entries.
  // All three sets represent actively-used credentials that must not be pruned.
  const configuredProfiles = new Set<string>(
    Object.keys(cfg.auth?.profiles ?? {})
      .map((id) => id.trim())
      .filter(Boolean),
  );
  for (const ids of Object.values(cfg.auth?.order ?? {})) {
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (typeof id === "string" && id.trim()) {
          configuredProfiles.add(id.trim());
        }
      }
    }
  }
  for (const id of collectMediaProfileIds(cfg)) {
    configuredProfiles.add(id);
  }

  const storeLoadOpts = { allowKeychainPrompt: false, readOnly: opts.dryRun === true };
  const store = isDefaultAgent
    ? ensureAuthProfileStore(agentDir, storeLoadOpts)
    : loadAgentLocalAuthProfileStore(agentDir, storeLoadOpts);

  // Also keep profiles referenced in store.order (per-agent overrides set via
  // 'models auth order set'). These are not reflected in cfg.auth.order or
  // cfg.auth.profiles, so they would be incorrectly treated as stale without
  // this step.
  const storeOrder = store.order;
  if (storeOrder) {
    for (const ids of Object.values(storeOrder)) {
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (typeof id === "string" && id.trim()) {
            configuredProfiles.add(id.trim());
          }
        }
      }
    }
  }

  const storeProfileIds = Object.keys(store.profiles);

  const toRemove = storeProfileIds.filter((id) => !configuredProfiles.has(id));
  const toKeep = storeProfileIds.filter((id) => configuredProfiles.has(id));

  // Safety guard: refuse to wipe everything when openclaw.json has no auth
  // config at all (e.g. profiles and order both absent/empty). This avoids
  // accidentally nuking a store-only setup. Require --dry-run to inspect.
  if (configuredProfiles.size === 0 && storeProfileIds.length > 0) {
    if (opts.dryRun) {
      if (opts.json) {
        runtime.log(
          JSON.stringify(
            {
              warning:
                "No profiles configured in openclaw.json auth.profiles or auth.order. All store profiles would be removed. Pass --force to proceed.",
              storeProfiles: storeProfileIds,
              dryRun: true,
            },
            null,
            2,
          ),
        );
      } else {
        runtime.log(
          "Warning: openclaw.json has no configured profiles. All store profiles would be removed.",
        );
        runtime.log(`In store: ${storeProfileIds.map(sanitizeProfileId).join(", ")}`);
        runtime.log("(dry run -- no changes written)");
      }
      return;
    }
    throw new Error(
      "openclaw.json has no configured auth profiles (auth.profiles and auth.order are both empty). " +
        "Run with --dry-run to inspect, or add profiles to openclaw.json before cleaning.",
    );
  }

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
    if (opts.dryRun || toRemove.length === 0) {
      return;
    }
  } else {
    runtime.log(`Agent:      ${agentId}`);
    runtime.log(`Auth file:  ${authStorePath}`);
    runtime.log(
      `Configured: ${[...configuredProfiles].map(sanitizeProfileId).join(", ") || "(none)"}`,
    );
    runtime.log(`In store:   ${storeProfileIds.map(sanitizeProfileId).join(", ") || "(none)"}`);
  }

  if (toRemove.length === 0) {
    if (!opts.json) {
      runtime.log("Nothing to clean up.");
    }
    return;
  }

  if (!opts.json) {
    runtime.log(`\nProfiles to remove (${toRemove.length}):`);
    for (const id of toRemove) {
      runtime.log(`  - ${sanitizeProfileId(id)}`);
    }
    runtime.log(`Profiles to keep (${toKeep.length}):`);
    for (const id of toKeep) {
      runtime.log(`  + ${sanitizeProfileId(id)}`);
    }
  }

  if (opts.dryRun) {
    if (!opts.json) {
      runtime.log("\n(dry run -- no changes written)");
    }
    return;
  }

  // Track actual removals inside the lock (concurrent gateway writes may have
  // already cleaned some ids between our initial read and lock acquisition).
  let actualRemoved = 0;

  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    // For non-default agents the write target is the agent-local file only.
    // Setting agentLocalOnly ensures the store loaded inside the lock is the
    // agent-local view (not the merged main+agent view returned by
    // ensureAuthProfileStore), which prevents main-store profiles from being
    // written into the agent-local file (credential scope bleed).
    agentLocalOnly: !isDefaultAgent,
    updater: (freshStore: AuthProfileStore) => {
      let mutated = false;

      // Remove stale profiles
      for (const id of toRemove) {
        if (id in freshStore.profiles) {
          delete freshStore.profiles[id];
          actualRemoved++;
          mutated = true;
        }
      }

      // Prune removed ids from the order map; delete the key entirely when
      // the filtered list becomes empty (an empty array overrides config with
      // no candidates, which breaks provider auth resolution).
      const order = freshStore.order;
      if (order) {
        for (const provider of Object.keys(order)) {
          const existing = order[provider];
          if (Array.isArray(existing)) {
            const filtered = existing.filter((id) => !toRemove.includes(id));
            if (filtered.length !== existing.length) {
              mutated = true;
              if (filtered.length > 0) {
                order[provider] = filtered;
              } else {
                delete order[provider];
              }
            }
          }
        }
        if (Object.keys(order).length === 0) {
          delete freshStore.order;
        }
      }

      // Prune removed ids from usageStats
      if (freshStore.usageStats) {
        for (const id of toRemove) {
          if (id in freshStore.usageStats) {
            delete freshStore.usageStats[id];
            mutated = true;
          }
        }
      }

      // Prune removed ids from lastGood (provider -> profileId map)
      if (freshStore.lastGood) {
        for (const [provider, profileId] of Object.entries(freshStore.lastGood)) {
          if (toRemove.includes(profileId)) {
            delete freshStore.lastGood[provider];
            mutated = true;
          }
        }
      }

      return mutated;
    },
  });

  if (!updated) {
    throw new Error("Failed to update auth-profiles.json (lock busy).");
  }

  if (opts.json) {
    runtime.log(JSON.stringify({ ok: true, removed: actualRemoved }, null, 2));
  } else {
    runtime.log(`\nRemoved ${actualRemoved} stale profile(s). Restart the gateway to apply.`);
  }
}
