import {
  readConfigFileSnapshotForWrite,
  writeConfigFile,
  loadConfig,
} from "../../config/config.js";
import { validateConfigObjectWithPlugins } from "../../config/validation.js";
import {
  resolveAgentGender,
  getAgentDefaultVoice,
  getAgentBackupVoices,
  CARTESIA_FEMALE_VOICES,
  CARTESIA_MALE_VOICES,
} from "../../tts/agent-voice.js";
import { resolveControlPlaneActor, formatControlPlaneActor } from "../control-plane-audit.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const voiceConfigHandlers: GatewayRequestHandlers = {
  /**
   * Get voice configuration for all agents (or a single agent).
   * Returns default voice, current override, gender, and backup options.
   */
  "voice-config.get": ({ params, respond }) => {
    try {
      const cfg = loadConfig();
      const agentsList = cfg.agents?.list ?? [];
      const filterAgentId =
        typeof params.agentId === "string" ? params.agentId.trim() : undefined;

      const agents = agentsList
        .filter((a) => !filterAgentId || a.id.toLowerCase() === filterAgentId.toLowerCase())
        .map((a) => {
          const defaultVoice = getAgentDefaultVoice(a.id);
          const backupVoices = getAgentBackupVoices(a.id);
          const override = a.tts?.cartesiaVoiceId ?? null;
          const activeVoiceId = override ?? defaultVoice?.voiceId ?? null;
          const allVoices = [...CARTESIA_FEMALE_VOICES, ...CARTESIA_MALE_VOICES];
          const activeLabel = allVoices.find((v) => v.id === activeVoiceId)?.label ?? "Unknown";

          return {
            id: a.id,
            name: a.name ?? a.id,
            gender: defaultVoice?.gender ?? resolveAgentGender(a.id) ?? null,
            defaultVoiceId: defaultVoice?.voiceId ?? null,
            defaultVoiceLabel: defaultVoice?.label ?? null,
            activeVoiceId,
            activeVoiceLabel: activeLabel,
            hasOverride: override !== null,
            backupVoices,
          };
        });

      respond(true, { agents });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  /**
   * Set or clear a per-agent Cartesia voice override.
   * Patches agents.list[i].tts.cartesiaVoiceId in openclaw.json.
   */
  "voice-config.agent-set": async ({ params, respond, client, context }) => {
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "agentId (string) required"));
      return;
    }

    const shouldClear = params.clear === true;
    const cartesiaVoiceId =
      typeof params.cartesiaVoiceId === "string" ? params.cartesiaVoiceId.trim() : undefined;

    if (!shouldClear && !cartesiaVoiceId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "provide cartesiaVoiceId or clear=true"),
      );
      return;
    }

    try {
      const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
      if (!snapshot.valid) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid config; fix before patching"));
        return;
      }

      const config = { ...(snapshot.config as Record<string, unknown>) };
      const agents = { ...((config.agents ?? {}) as Record<string, unknown>) };
      const list = Array.isArray(agents.list)
        ? (agents.list as Array<Record<string, unknown>>).map((e) => ({ ...e }))
        : [];

      const agentIndex = list.findIndex(
        (entry) => typeof entry.id === "string" && entry.id.toLowerCase() === agentId.toLowerCase(),
      );

      if (agentIndex < 0) {
        if (!shouldClear) {
          list.push({ id: agentId, tts: { cartesiaVoiceId } });
        }
      } else if (shouldClear) {
        delete list[agentIndex].tts;
      } else {
        list[agentIndex].tts = { cartesiaVoiceId };
      }

      config.agents = { ...agents, list };
      const validated = validateConfigObjectWithPlugins(config);
      if (!validated.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "config validation failed after patch"));
        return;
      }

      const actor = resolveControlPlaneActor(client as Parameters<typeof resolveControlPlaneActor>[0]);
      context?.logGateway?.info(
        `voice-config.agent-set write agent=${agentId} voice=${cartesiaVoiceId ?? "cleared"} ${formatControlPlaneActor(actor)}`,
      );
      await writeConfigFile(validated.config, writeOptions);

      const defaultVoice = getAgentDefaultVoice(agentId);
      const allVoices = [...CARTESIA_FEMALE_VOICES, ...CARTESIA_MALE_VOICES];
      const effectiveId = shouldClear ? defaultVoice?.voiceId : cartesiaVoiceId;
      const effectiveLabel = allVoices.find((v) => v.id === effectiveId)?.label ?? "Unknown";

      respond(true, {
        ok: true,
        agentId,
        activeVoiceId: effectiveId ?? null,
        activeVoiceLabel: effectiveLabel,
        hasOverride: !shouldClear,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
