import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  resolvePrimaryStringValue,
} from "@openclaw/normalization-core/string-coerce";
import {
  normalizeBindingConfig,
  normalizeMode,
  normalizeText,
  toConfiguredAcpBindingRecord,
} from "../../acp/persistent-bindings.types.js";
import { resolveAgentConfig, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { parseModelRef } from "../../agents/model-selection-normalize.js";
import { resolveConfiguredThinkingDefault } from "../../agents/model-thinking-default.js";
import { listConfiguredBindings } from "../../config/bindings.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getPluginRegistryForContext } from "../../plugins/runtime/gateway-request-scope.js";
import { pickFirstExistingAgentId } from "../../routing/resolve-route.js";
import type { CompiledConfiguredBinding } from "./binding-types.js";
import { getLoadedChannelPluginEntryById } from "./registry-loaded.js";
import type { ChannelId } from "./types.public.js";

export function resolveCompiledBindingRegistry(cfg: OpenClawConfig) {
  const rulesByChannel = new Map<ChannelId, CompiledConfiguredBinding[]>();

  for (const binding of listConfiguredBindings(cfg)) {
    // Ordinary routing bindings share the config array but have no stateful target.
    // Reject them before consulting the loaded channel registry on request-time route lookups.
    if (binding.type !== "acp") {
      continue;
    }
    const bindingConversationId = normalizeOptionalString(binding.match?.peer?.id);
    if (!bindingConversationId) {
      continue;
    }

    const channel = normalizeOptionalLowercaseString(binding.match.channel);
    if (!channel) {
      continue;
    }
    // Candidate validation and admitted routing compile against their exact owner.
    const plugin = getLoadedChannelPluginEntryById(
      channel,
      getPluginRegistryForContext() ?? undefined,
    )?.plugin;
    const provider = plugin?.bindings;
    if (!plugin || !provider?.compileConfiguredBinding || !provider.matchInboundConversation) {
      continue;
    }
    const channelId = plugin.id;
    const target = provider.compileConfiguredBinding({
      binding,
      conversationId: bindingConversationId,
    });
    if (!target) {
      continue;
    }

    const agentId = pickFirstExistingAgentId(cfg, binding.agentId ?? "main");
    // Binding config overrides ACP runtime defaults; unset fields remain harness-owned.
    const agent = resolveAgentConfig(cfg, agentId);
    const runtimeDefaults = agent?.runtime?.type === "acp" ? agent.runtime.acp : undefined;
    const acpAgentId = normalizeText(runtimeDefaults?.agent);
    const bindingOverrides = normalizeBindingConfig(binding.acp);
    const mode = normalizeMode(bindingOverrides.mode ?? normalizeText(runtimeDefaults?.mode));
    // Every ACP binding uses its owner's explicit model, regardless of the owner's runtime type.
    const model = resolvePrimaryStringValue(agent?.model);
    const modelRef = model ? parseModelRef(model, "") : null;
    const thinking =
      agent?.thinkingDefault ??
      (modelRef
        ? resolveConfiguredThinkingDefault({ cfg, ...modelRef })
        : cfg.agents?.defaults?.thinkingDefault);
    // Unconfigured workspaces stay unset so ACP can choose its normal default.
    const cwd =
      bindingOverrides.cwd ??
      normalizeText(runtimeDefaults?.cwd) ??
      (normalizeText(agent?.workspace) || normalizeText(cfg.agents?.defaults?.workspace)
        ? resolveAgentWorkspaceDir(cfg, agentId)
        : undefined);
    const backend = bindingOverrides.backend ?? normalizeText(runtimeDefaults?.backend);
    const rule: CompiledConfiguredBinding = {
      channel: channelId,
      accountPattern: normalizeOptionalString(binding.match.accountId),
      binding,
      bindingConversationId,
      target,
      agentId,
      provider,
      targetFactory: {
        driverId: "acp",
        materialize: ({ accountId, conversation }) => {
          // Wildcard bindings get a stable session key only after the conversation is known.
          const record = toConfiguredAcpBindingRecord({
            channel: channelId,
            accountId,
            conversationId: conversation.conversationId,
            parentConversationId: conversation.parentConversationId,
            agentId,
            acpAgentId,
            mode,
            model,
            thinking,
            cwd,
            backend,
            label: bindingOverrides.label,
          });
          return {
            record,
            statefulTarget: {
              kind: "stateful",
              driverId: "acp",
              sessionKey: record.targetSessionKey,
              agentId,
              ...(bindingOverrides.label ? { label: bindingOverrides.label } : {}),
            },
          };
        },
      },
    };
    const rules = rulesByChannel.get(rule.channel) ?? [];
    rules.push(rule);
    rulesByChannel.set(rule.channel, rules);
  }

  return rulesByChannel;
}
