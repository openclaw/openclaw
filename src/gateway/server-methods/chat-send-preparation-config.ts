import { resolveAgentEntry } from "../../agents/agent-scope-config.js";
import {
  modelFallbackOverrideFromAvailability,
  resolveModelFallbackAvailability,
} from "../../agents/model-selection-config.js";
import {
  findNormalizedProviderValue,
  parseModelRef,
} from "../../agents/model-selection-normalize.js";
import { resolveConfiguredModelPolicyAllow } from "../../agents/model-selection-shared.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.read.js";
import { resolveSessionModelRef } from "../session-utils.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";

// These inputs prepare model/runtime selection, native restrictions, command/retry
// semantics, and creator defaults. Sharing authorization rechecks live policy;
// unrelated logging and UI publications do not invalidate a prepared send.
// Plugin-owned settings belong to the admitted runtime generation; core plugin
// admission policy still affects preparation and must remain current.
export function chatSendPreparationConfig(
  cfg: OpenClawConfig,
  agentId: string,
  entry?: SessionEntry,
  request?: Pick<NormalizedChatSendRequest, "explicitOrigin">,
  sessionKey?: string,
) {
  const defaults = cfg.agents?.defaults;
  const agent = resolveAgentEntry(cfg, agentId);
  const selected = resolveSessionModelRef(cfg, entry, agentId);
  const { refs, repairConfigPath } = resolveConfiguredModelPolicyAllow({ cfg, agentId });
  const fallbacks =
    modelFallbackOverrideFromAvailability(
      resolveModelFallbackAvailability({
        cfg,
        agentId,
        sessionKey,
        selectedModel: selected,
        hasSessionModelOverride: Boolean(entry?.modelOverride),
        modelOverrideSource:
          entry?.modelOverrideSource === "default" ? undefined : entry?.modelOverrideSource,
        modelSelectionLocked: entry?.modelSelectionLocked,
      }),
    ) ?? [];
  const modelRefs = [
    ...(selected ? [selected] : []),
    ...fallbacks.flatMap((model) => {
      // Without a primary no turn runs, so its fallbacks need no provider config.
      const parsed = selected && parseModelRef(model, selected.provider);
      return parsed ? [parsed] : [];
    }),
  ];
  const providers = Object.fromEntries(
    [...new Set(modelRefs.map(({ provider }) => provider))].map((id) => {
      const provider = findNormalizedProviderValue(cfg.models?.providers, id);
      return [
        id,
        provider
          ? {
              ...provider,
              models: provider.models?.filter(({ id: model }) =>
                modelRefs.some((ref) => ref.provider === id && ref.model === model),
              ),
            }
          : undefined,
      ];
    }),
  );
  const channels = [
    ...new Set(
      [
        "webchat",
        request?.explicitOrigin?.originatingChannel,
        sessionDeliveryChannel(entry),
      ].filter((channel): channel is string => Boolean(channel)),
    ),
  ];
  return {
    defaultModel: defaults?.model,
    agentModel: agent?.model,
    defaultModels: defaults?.models,
    agentModels: agent?.models,
    // Canonical alias owner survives migration; empty allowlists remain unrestricted.
    modelPolicy: { refs, owner: refs.length > 0 ? repairConfigPath : null },
    runtime: agent?.runtime,
    models: { mode: cfg.models?.mode, providers },
    auth: cfg.auth,
    workspace: agent?.workspace ?? defaults?.workspace,
    agentDir: agent?.agentDir,
    timeoutSeconds: defaults?.timeoutSeconds,
    defaultSandbox: defaults?.sandbox,
    agentSandbox: agent?.sandbox,
    tools: cfg.tools,
    agentTools: agent?.tools,
    plugins: {
      enabled: cfg.plugins?.enabled,
      allow: cfg.plugins?.allow,
      deny: cfg.plugins?.deny,
      load: cfg.plugins?.load,
      slots: cfg.plugins?.slots,
      entries: Object.fromEntries(
        Object.entries(cfg.plugins?.entries ?? {}).map(
          ([id, { enabled, hooks, subagent, llm }]) => [id, { enabled, hooks, subagent, llm }],
        ),
      ),
    },
    channels: {
      defaults: cfg.channels?.defaults,
      selected: Object.fromEntries(channels.map((channel) => [channel, cfg.channels?.[channel]])),
    },
    roles: cfg.gateway?.roles,
    nodeCommands: cfg.gateway?.nodes?.commands,
    commands: cfg.commands,
    sendPolicy: cfg.session?.sendPolicy,
    reset: cfg.session?.reset,
    resetByType: cfg.session?.resetByType,
    resetByChannel: cfg.session?.resetByChannel,
  };
}
