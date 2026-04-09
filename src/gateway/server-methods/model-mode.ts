import {
  readConfigFileSnapshotForWrite,
  writeConfigFile,
} from "../../config/config.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import { validateConfigObjectWithPlugins } from "../../config/validation.js";
import {
  loadModelTierConfig,
  saveModelTierConfig,
  isValidModelTierMode,
  getProviderModelForTier,
  MODEL_TIER_MAP,
  MODEL_TIER_LABELS,
  MODEL_TIER_COST,
  MODEL_TIER_COLORS,
  type ModelTierMode,
} from "../../agents/model-tiers.js";
import { resolveControlPlaneActor, formatControlPlaneActor } from "../control-plane-audit.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const modelModeHandlers: GatewayRequestHandlers = {
  /**
   * Get current model tier configuration.
   */
  "model-mode.get": ({ respond }) => {
    const tierConfig = loadModelTierConfig();
    respond(
      true,
      {
        globalMode: tierConfig.globalMode,
        agentOverrides: tierConfig.agentOverrides,
        tiers: Object.fromEntries(
          (["economy", "baller", "einstein"] as const).map((mode) => [
            mode,
            {
              label: MODEL_TIER_LABELS[mode],
              model: MODEL_TIER_MAP[mode],
              cost: MODEL_TIER_COST[mode],
              color: MODEL_TIER_COLORS[mode],
            },
          ]),
        ),
      },
      undefined,
    );
  },

  /**
   * Set the global model tier mode.
   * Updates tier state file + patches agents.defaults.model in openclaw.json.
   */
  "model-mode.set": async ({ params, respond, client, context }) => {
    const mode = params.mode;
    if (!isValidModelTierMode(mode)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid mode: expected "economy", "baller", or "einstein"`,
        ),
      );
      return;
    }

    // Update tier state file
    const tierConfig = loadModelTierConfig();
    tierConfig.globalMode = mode as ModelTierMode;
    saveModelTierConfig(tierConfig);

    // Patch agents.defaults.model AND all agent entries in openclaw.json
    const writeResult = await writeGlobalTierChange(
      mode as ModelTierMode,
      tierConfig,
      client,
      context,
    );
    if (!writeResult.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, writeResult.error));
      return;
    }

    // No gateway restart — model refs are read per-request, so the new
    // tier takes effect on the next agent invocation. Restarting would
    // drop every WebSocket (including Mission Control chat iframes) and
    // spawn a fresh PowerShell window on Windows — unacceptable UX for
    // something that should feel instantaneous.
    respond(
      true,
      {
        ok: true,
        globalMode: mode,
        model: MODEL_TIER_MAP[mode as ModelTierMode],
        label: MODEL_TIER_LABELS[mode as ModelTierMode],
      },
      undefined,
    );
  },

  /**
   * Set or clear a per-agent model tier override.
   */
  "model-mode.agent-set": async ({ params, respond, client, context }) => {
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
    if (!agentId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agentId (string) required"),
      );
      return;
    }
    const mode = params.mode;
    if (mode !== "inherit" && !isValidModelTierMode(mode)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid mode: expected "economy", "baller", "einstein", or "inherit"`,
        ),
      );
      return;
    }

    // Update tier state file
    const tierConfig = loadModelTierConfig();
    if (mode === "inherit") {
      delete tierConfig.agentOverrides[agentId];
    } else {
      tierConfig.agentOverrides[agentId] = mode as ModelTierMode;
    }
    saveModelTierConfig(tierConfig);

    // Patch the agent's model in openclaw.json
    const writeResult = await writeAgentModelPatch(
      agentId,
      mode as ModelTierMode | "inherit",
      tierConfig,
      client,
      context,
    );
    if (!writeResult.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, writeResult.error));
      return;
    }

    const effectiveMode = tierConfig.agentOverrides[agentId] ?? tierConfig.globalMode;

    // No gateway restart — see comment in model-mode.set above.
    respond(
      true,
      {
        ok: true,
        agentId,
        mode: mode === "inherit" ? "inherit" : mode,
        effectiveMode,
        effectiveModel: MODEL_TIER_MAP[effectiveMode],
      },
      undefined,
    );
  },
};

type WriteResult =
  | { ok: true; actor: string }
  | { ok: false; error: string };

/**
 * Apply a merge-patch to openclaw.json, validate, and write.
 * Does NOT schedule a restart — caller handles that.
 */
async function writeConfigPatch(
  patch: Record<string, unknown>,
  client: unknown,
  context: { logGateway: { info: (msg: string) => void } },
  method: string,
): Promise<WriteResult> {
  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  if (!snapshot.valid) {
    return { ok: false, error: "invalid config; fix before patching" };
  }
  const merged = applyMergePatch(snapshot.config, patch, { mergeObjectArraysById: true });
  const validated = validateConfigObjectWithPlugins(merged);
  if (!validated.ok) {
    return { ok: false, error: "config validation failed" };
  }
  const actor = resolveControlPlaneActor(client as Parameters<typeof resolveControlPlaneActor>[0]);
  context?.logGateway?.info(
    `${method} write ${formatControlPlaneActor(actor)} reason=${method}`,
  );
  await writeConfigFile(validated.config, writeOptions);
  return { ok: true, actor: actor.actor ?? "unknown" };
}

/**
 * Patch a specific agent's model in openclaw.json.
 */
async function writeAgentModelPatch(
  agentId: string,
  mode: ModelTierMode | "inherit",
  tierConfig: { globalMode: ModelTierMode },
  client: unknown,
  context: { logGateway: { info: (msg: string) => void } },
): Promise<WriteResult> {
  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  if (!snapshot.valid) {
    return { ok: false, error: "invalid config; fix before patching" };
  }

  const config = { ...(snapshot.config as Record<string, unknown>) };
  const agents = { ...((config.agents ?? {}) as Record<string, unknown>) };
  const list = Array.isArray(agents.list)
    ? (agents.list as Array<Record<string, unknown>>).map((e) => ({ ...e }))
    : [];

  const agentIndex = list.findIndex(
    (entry) => typeof entry.id === "string" && entry.id.toLowerCase() === agentId.toLowerCase(),
  );

  if (mode === "inherit") {
    if (agentIndex >= 0) {
      delete list[agentIndex].model;
    }
  } else {
    const modelRef = getProviderModelForTier(mode);
    if (agentIndex >= 0) {
      const entry = list[agentIndex];
      if (entry.model && typeof entry.model === "object" && !Array.isArray(entry.model)) {
        entry.model = { ...(entry.model as Record<string, unknown>), primary: modelRef };
      } else {
        entry.model = modelRef;
      }
    } else {
      list.push({ id: agentId, model: modelRef });
    }
  }

  config.agents = { ...agents, list };
  const validated = validateConfigObjectWithPlugins(config);
  const configToWrite = validated.ok ? validated.config : config;

  const actor = resolveControlPlaneActor(client as Parameters<typeof resolveControlPlaneActor>[0]);
  context?.logGateway?.info(
    `model-mode.agent-set write agent=${agentId} mode=${mode} ${formatControlPlaneActor(actor)}`,
  );
  await writeConfigFile(configToWrite, writeOptions);
  return { ok: true, actor: actor.actor ?? "unknown" };
}

/**
 * Set global tier: update agents.defaults.model AND update every agent
 * in agents.list that doesn't have a per-agent tier override.
 * Agents with tier overrides get their override's model instead.
 */
async function writeGlobalTierChange(
  mode: ModelTierMode,
  tierConfig: { globalMode: ModelTierMode; agentOverrides: Record<string, ModelTierMode> },
  client: unknown,
  context: { logGateway: { info: (msg: string) => void } },
): Promise<WriteResult> {
  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  if (!snapshot.valid) {
    return { ok: false, error: "invalid config; fix before patching" };
  }

  const config = { ...(snapshot.config as Record<string, unknown>) };
  const agents = { ...((config.agents ?? {}) as Record<string, unknown>) };
  const defaults = { ...((agents.defaults ?? {}) as Record<string, unknown>) };

  // Set the global default
  const globalModelRef = getProviderModelForTier(mode);
  defaults.model = globalModelRef;
  agents.defaults = defaults;

  // Update every agent in the list
  const list = Array.isArray(agents.list)
    ? (agents.list as Array<Record<string, unknown>>).map((e) => ({ ...e }))
    : [];

  for (const entry of list) {
    const agentId = typeof entry.id === "string" ? entry.id : "";
    if (!agentId) continue;

    // If this agent has a per-agent tier override, use that tier's model
    const agentTierOverride = tierConfig.agentOverrides[agentId];
    const agentModel = agentTierOverride
      ? getProviderModelForTier(agentTierOverride)
      : globalModelRef;

    // Update the model, preserving fallbacks if present
    if (entry.model && typeof entry.model === "object" && !Array.isArray(entry.model)) {
      entry.model = { ...(entry.model as Record<string, unknown>), primary: agentModel };
    } else {
      entry.model = agentModel;
    }
  }

  agents.list = list;
  config.agents = agents;

  const validated = validateConfigObjectWithPlugins(config);
  if (!validated.ok) {
    return { ok: false, error: "config validation failed" };
  }

  const actor = resolveControlPlaneActor(client as Parameters<typeof resolveControlPlaneActor>[0]);
  context?.logGateway?.info(
    `model-mode.set write globalMode=${mode} agents=${list.length} ${formatControlPlaneActor(actor)}`,
  );
  await writeConfigFile(validated.config, writeOptions);
  return { ok: true, actor: actor.actor ?? "unknown" };
}
