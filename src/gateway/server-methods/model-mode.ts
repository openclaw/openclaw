import {
  applyAgentBrainTierPatch,
  applyGlobalBrainTierPatch,
} from "../../agents/brain-config-patch.js";
import {
  resolveBrainProfileForMode,
  type NormalizedBrainTierConfig,
} from "../../agents/brain-profiles.js";
import {
  loadModelTierConfig,
  saveModelTierConfig,
  isValidModelTierMode,
  MODEL_TIER_LABELS,
  MODEL_TIER_COST,
  MODEL_TIER_COLORS,
  type ModelTierConfig,
  type ModelTierMode,
} from "../../agents/model-tiers.js";
import { readConfigFileSnapshotForWrite, writeConfigFile } from "../../config/config.js";
import { validateConfigObjectWithPlugins } from "../../config/validation.js";
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
          (["economy", "baller", "einstein"] as const).map((mode) => {
            const resolved = resolveBrainProfileForMode(tierConfig, mode);
            return [
              mode,
              {
                label: MODEL_TIER_LABELS[mode],
                model: resolved.model,
                modelRef: resolved.modelRef,
                profileId: resolved.profileId,
                provider: resolved.provider,
                auth: resolved.auth,
                billing: resolved.billing,
                commercialSafe: resolved.commercialSafe,
                cost: MODEL_TIER_COST[mode],
                color: MODEL_TIER_COLORS[mode],
              },
            ];
          }),
        ),
        tierRouting: tierConfig.tierRouting,
        brainProfiles: Object.fromEntries(
          Object.entries(tierConfig.brainProfiles).map(([id, profile]) => [
            id,
            {
              id,
              label: profile.label,
              provider: profile.provider,
              model: profile.model,
              modelRef: profile.modelRef,
              auth: profile.auth,
              billing: profile.billing,
              commercialSafe: profile.commercialSafe,
              notes: profile.notes,
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
    tierConfig.globalMode = mode;
    saveModelTierConfig(tierConfig);
    const resolved = resolveBrainProfileForMode(tierConfig, mode);

    // Patch agents.defaults.model AND all agent entries in openclaw.json
    const writeResult = await writeGlobalTierChange(mode, tierConfig, client, context);
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
        model: resolved.model,
        modelRef: resolved.modelRef,
        profileId: resolved.profileId,
        provider: resolved.provider,
        auth: resolved.auth,
        billing: resolved.billing,
        label: MODEL_TIER_LABELS[mode],
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
      tierConfig.agentOverrides[agentId] = mode;
    }
    saveModelTierConfig(tierConfig);

    // Patch the agent's model in openclaw.json
    const writeResult = await writeAgentModelPatch(agentId, mode, tierConfig, client, context);
    if (!writeResult.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, writeResult.error));
      return;
    }

    const effectiveMode = tierConfig.agentOverrides[agentId] ?? tierConfig.globalMode;
    const resolved = resolveBrainProfileForMode(tierConfig, effectiveMode);

    // No gateway restart — see comment in model-mode.set above.
    respond(
      true,
      {
        ok: true,
        agentId,
        mode: mode === "inherit" ? "inherit" : mode,
        effectiveMode,
        effectiveModel: resolved.modelRef,
        profileId: resolved.profileId,
        provider: resolved.provider,
        auth: resolved.auth,
        billing: resolved.billing,
      },
      undefined,
    );
  },
};

type WriteResult = { ok: true; actor: string } | { ok: false; error: string };

/**
 * Apply a merge-patch to openclaw.json, validate, and write.
 * Does NOT schedule a restart — caller handles that.
 */
/**
 * Patch a specific agent's model in openclaw.json.
 */
async function writeAgentModelPatch(
  agentId: string,
  mode: ModelTierMode | "inherit",
  tierConfig: ModelTierConfig,
  client: unknown,
  context: { logGateway: { info: (msg: string) => void } },
): Promise<WriteResult> {
  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  if (!snapshot.valid) {
    return { ok: false, error: "invalid config; fix before patching" };
  }

  const config = applyAgentBrainTierPatch(
    snapshot.config as Record<string, unknown>,
    agentId,
    mode,
    tierConfig as NormalizedBrainTierConfig,
  );
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
  tierConfig: ModelTierConfig,
  client: unknown,
  context: { logGateway: { info: (msg: string) => void } },
): Promise<WriteResult> {
  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  if (!snapshot.valid) {
    return { ok: false, error: "invalid config; fix before patching" };
  }

  const config = applyGlobalBrainTierPatch(
    snapshot.config as Record<string, unknown>,
    mode,
    tierConfig as NormalizedBrainTierConfig,
  );

  const validated = validateConfigObjectWithPlugins(config);
  if (!validated.ok) {
    return { ok: false, error: "config validation failed" };
  }

  const actor = resolveControlPlaneActor(client as Parameters<typeof resolveControlPlaneActor>[0]);
  const list = Array.isArray((config.agents as Record<string, unknown> | undefined)?.list)
    ? ((config.agents as Record<string, unknown>).list as unknown[])
    : [];
  context?.logGateway?.info(
    `model-mode.set write globalMode=${mode} agents=${list.length} ${formatControlPlaneActor(actor)}`,
  );
  await writeConfigFile(validated.config, writeOptions);
  return { ok: true, actor: actor.actor ?? "unknown" };
}
