import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  type AuthProfileStore,
  ensureAuthProfileStore,
  listProfilesForProvider,
  setAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import type { RuntimeEnv } from "../../runtime.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { shortenHomePath } from "../../utils.js";
import { loadModelsConfig } from "./load-config.js";
import { resolveKnownAgentId } from "./shared.js";

function resolveTargetAgent(
  cfg: Awaited<ReturnType<typeof loadModelsConfig>>,
  raw?: string,
): {
  agentId: string;
  agentDir: string;
} {
  const agentId = resolveKnownAgentId({ cfg, rawAgentId: raw }) ?? resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, agentId);
  return { agentId, agentDir };
}

function describeOrder(store: AuthProfileStore, provider: string): string[] {
  const providerKey = normalizeProviderId(provider);
  const order = store.order?.[providerKey];
  return Array.isArray(order) ? order : [];
}

async function resolveAuthOrderContext(
  opts: { provider: string; agent?: string },
  runtime: RuntimeEnv,
) {
  const rawProvider = opts.provider?.trim();
  if (!rawProvider) {
    throw new Error("Missing --provider.");
  }
  const provider = normalizeProviderId(rawProvider);
  const cfg = await loadModelsConfig({ commandName: "models auth-order", runtime });
  const { agentId, agentDir } = resolveTargetAgent(cfg, opts.agent);
  return { cfg, agentId, agentDir, provider };
}

export async function modelsAuthOrderGetCommand(
  opts: { provider: string; agent?: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const { agentId, agentDir, provider } = await resolveAuthOrderContext(opts, runtime);
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  const order = describeOrder(store, provider);

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          agentId,
          agentDir,
          provider,
          authStorePath: shortenHomePath(`${agentDir}/auth-profiles.json`),
          order: order.length > 0 ? order : null,
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Provider: ${provider}`);
  runtime.log(`Auth file: ${shortenHomePath(`${agentDir}/auth-profiles.json`)}`);
  runtime.log(order.length > 0 ? `Order override: ${order.join(", ")}` : "Order override: (none)");
}

export async function modelsAuthOrderClearCommand(
  opts: { provider: string; agent?: string },
  runtime: RuntimeEnv,
) {
  const { agentId, agentDir, provider } = await resolveAuthOrderContext(opts, runtime);
  const updated = await setAuthProfileOrder({
    agentDir,
    provider,
    order: null,
  });
  if (!updated) {
    throw new Error("Failed to update auth-profiles.json (lock busy?).");
  }

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Provider: ${provider}`);
  runtime.log("Cleared per-agent order override.");
}

export async function modelsAuthOrderSetCommand(
  opts: { provider: string; agent?: string; order: string[] },
  runtime: RuntimeEnv,
) {
  const { agentId, agentDir, provider } = await resolveAuthOrderContext(opts, runtime);

  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  const providerKey = provider;
  const requested = normalizeStringEntries(opts.order ?? []);
  if (requested.length === 0) {
    throw new Error("Missing profile ids. Provide one or more profile ids.");
  }

  for (const profileId of requested) {
    const cred = store.profiles[profileId];
    if (!cred) {
      throw new Error(`Auth profile "${profileId}" not found in ${agentDir}.`);
    }
    if (normalizeProviderId(cred.provider) !== providerKey) {
      throw new Error(`Auth profile "${profileId}" is for ${cred.provider}, not ${provider}.`);
    }
  }

  const updated = await setAuthProfileOrder({
    agentDir,
    provider,
    order: requested,
  });
  if (!updated) {
    throw new Error("Failed to update auth-profiles.json (lock busy?).");
  }

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Provider: ${provider}`);
  runtime.log(`Order override: ${describeOrder(updated, provider).join(", ")}`);
}

export async function modelsAuthListCommand(
  opts: { provider: string; agent?: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const { agentId, agentDir, provider } = await resolveAuthOrderContext(opts, runtime);
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const profiles = listProfilesForProvider(store, provider).toSorted((a, b) => a.localeCompare(b));
  const explicitOrder = describeOrder(store, provider);
  const fallbackCurrent = profiles[0] ?? null;
  const current = explicitOrder[0] ?? fallbackCurrent;
  const ordered =
    explicitOrder.length > 0
      ? [...explicitOrder, ...profiles.filter((id) => !explicitOrder.includes(id))]
      : profiles;

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          agentId,
          provider,
          current,
          profiles: ordered,
          explicitOrder: explicitOrder.length > 0 ? explicitOrder : null,
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Provider: ${provider}`);
  runtime.log(`Current: ${current ?? "(none)"}`);
  runtime.log(`Profiles: ${ordered.length > 0 ? ordered.join(", ") : "(none)"}`);
}

export async function modelsAuthSetDefaultCommand(
  opts: { provider: string; profile: string; agent?: string },
  runtime: RuntimeEnv,
) {
  const { agentId, agentDir, provider } = await resolveAuthOrderContext(opts, runtime);
  const profile = opts.profile?.trim();
  if (!profile) {
    throw new Error("Missing --profile.");
  }

  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const existing = listProfilesForProvider(store, provider);
  if (!existing.includes(profile)) {
    throw new Error(`Auth profile "${profile}" not found for provider ${provider}.`);
  }
  const nextOrder = [profile, ...existing.filter((id) => id !== profile)];
  const updated = await setAuthProfileOrder({ agentDir, provider, order: nextOrder });
  if (!updated) {
    throw new Error("Failed to update auth-profiles.json (lock busy?).");
  }

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Provider: ${provider}`);
  runtime.log(`Default profile set: ${profile}`);
}
