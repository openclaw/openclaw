/**
 * Explains whether named tools reach a run, and which stage removes them.
 *
 * Policy stages replay the final effective tool-policy composition that agent
 * sessions use, with probe tools that carry plugin ownership metadata. Run stages
 * (harness, model, sandbox) explain session-level gates around that policy. This
 * owner reports facts and generic remedies; callers word feature-specific advice.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  listAgentEntriesWithSource,
  resolveAgentConfig,
  resolveDefaultAgentId,
  resolveSessionAgentIds,
} from "./agent-scope.js";
import {
  prepareConversationCapabilityProfile,
  type ResolvedConversationCapabilityProfile,
} from "./conversation-capability-profile.js";
import { applyFinalEffectiveToolPolicy } from "./embedded-agent-runner/effective-tool-policy.js";
import { resolveProviderToolPolicyEntry } from "./provider-tool-policy.js";
import { resolveSandboxConfigForAgent } from "./sandbox/config.js";
import { resolveSessionModelRef } from "./session-model-ref.js";
import { createToolPolicyMatcher } from "./tool-policy-match.js";
import type { ToolPolicyFilterEvent } from "./tool-policy-pipeline.js";
import type { AnyAgentTool } from "./tools/common.js";

/** The stage that removed a tool, in the order an operator should address them. */
export type ToolAvailabilityStage =
  | "deny"
  | "harness"
  | "model"
  | "sandbox"
  | "profile"
  | "provider-policy"
  | "allowlist"
  | "session";

export type ToolAvailabilityBlock = {
  stage: ToolAvailabilityStage;
  /** The config path (or session policy label) that removed the tool, when one exists. */
  source?: string;
  detail: string;
  fix: string;
};

export type ToolAvailability =
  | { name: string; available: true }
  | { name: string; available: false; block: ToolAvailabilityBlock };

export type ToolAvailabilitySandbox = {
  mode: "off" | "non-main" | "all";
  /** Config path that sets the agent's sandbox mode. */
  source: string;
  /** Present for session queries: whether that session runs sandboxed. */
  sandboxed?: boolean;
};

export type ToolAvailabilityReport = {
  agentId: string;
  sandbox: ToolAvailabilitySandbox;
  tools: ToolAvailability[];
};

export type ExplainToolAvailabilityParams = {
  config: OpenClawConfig;
  agentId?: string;
  /** Adds session gates: the session's model, harness and sandbox. */
  sessionKey?: string;
  toolNames: readonly string[];
  /** Owner of the tools, so plugin-ID and group:plugins entries match; omit for core tools. */
  pluginId?: string;
};

function findAgentPath(config: OpenClawConfig, agentId: string): string | undefined {
  const listed = listAgentEntriesWithSource(config).find(
    ({ entry }) => normalizeAgentId(entry.id) === agentId,
  );
  if (!listed) {
    return undefined;
  }
  // An id-less legacy list row keeps its indexed path so remedies never name agents.entries.undefined.
  return listed.source.kind === "entries"
    ? `agents.entries.${listed.source.key}`
    : typeof listed.entry.id === "string" && listed.entry.id.length > 0
      ? `agents.entries.${listed.entry.id}`
      : `agents.list[${listed.source.index}]`;
}

function describeSandbox(config: OpenClawConfig, agentId: string): ToolAvailabilitySandbox {
  const agentPath = findAgentPath(config, agentId);
  const ownsMode = Boolean(resolveAgentConfig(config, agentId)?.sandbox?.mode);
  return {
    mode: resolveSandboxConfigForAgent(config, agentId).mode,
    source: ownsMode && agentPath ? `${agentPath}.sandbox.mode` : "agents.defaults.sandbox.mode",
  };
}

function probeTool(name: string, pluginId: string | undefined): AnyAgentTool {
  const probe = {
    name,
    label: name,
    description: "Tool availability probe.",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: {} }),
  } as AnyAgentTool;
  if (pluginId) {
    setPluginToolMeta(probe, { pluginId, optional: false });
  }
  return probe;
}

// A profile grant goes to the narrowest scope that already owns an alsoAllow list
// (an agent list replaces the inherited one), else next to the profile itself.
function profileGrantOwner(
  config: OpenClawConfig,
  profile: ResolvedConversationCapabilityProfile,
  provider: boolean,
  profilePath: string | undefined,
): string | undefined {
  const { sources } = profile.policy;
  const agentTools = profile.agentId
    ? resolveAgentConfig(config, profile.agentId)?.tools
    : undefined;
  const lookup = { modelProvider: profile.model.provider, modelId: profile.model.id };
  const scopes: { alsoAllow?: unknown; path?: string }[] = provider
    ? [
        {
          alsoAllow: resolveProviderToolPolicyEntry({
            byProvider: agentTools?.byProvider,
            ...lookup,
          })?.policy.alsoAllow,
          path: sources.agentProvider?.path,
        },
        {
          alsoAllow: resolveProviderToolPolicyEntry({
            byProvider: config.tools?.byProvider,
            ...lookup,
          })?.policy.alsoAllow,
          path: sources.globalProvider?.path,
        },
      ]
    : [
        { alsoAllow: agentTools?.alsoAllow, path: sources.agent?.path },
        { alsoAllow: config.tools?.alsoAllow, path: "tools" },
      ];
  const owner = scopes.find((scope) => scope.path && Array.isArray(scope.alsoAllow))?.path;
  return owner ?? profilePath?.replace(/\.profile$/, "");
}

function describePolicyBlock(params: {
  config: OpenClawConfig;
  profile: ResolvedConversationCapabilityProfile;
  event: ToolPolicyFilterEvent;
  denied: boolean;
  toolName: string;
}): ToolAvailabilityBlock {
  const { step } = params.event;
  const { sources } = params.profile.policy;
  const tool = JSON.stringify(params.toolName);
  const source = step.source;
  if (params.denied) {
    const path = source?.kind === "config" && source.path ? `${source.path}.deny` : step.label;
    return {
      stage: "deny",
      source: path,
      detail: `${path} denies ${tool}.`,
      fix: `Remove the entry matching ${tool} from ${path}.`,
    };
  }
  if (source && (source === sources.profile || source === sources.providerProfile)) {
    const provider = source === sources.providerProfile;
    const path = source.path ?? (provider ? "tools.byProvider.profile" : "tools.profile");
    const grantOwner = profileGrantOwner(params.config, params.profile, provider, source.path);
    return {
      stage: provider ? "provider-policy" : "profile",
      source: path,
      detail: `${path}: ${JSON.stringify(source.profile ?? "unknown")} does not include ${tool}.`,
      fix: grantOwner
        ? `Add ${grantOwner}.alsoAllow: [${tool}].`
        : `Add ${tool} to the alsoAllow list that applies to ${path}.`,
    };
  }
  if (source?.kind === "config" && source.path) {
    const path = `${source.path}.allow`;
    const provider = source === sources.globalProvider || source === sources.agentProvider;
    return {
      stage: provider ? "provider-policy" : "allowlist",
      source: path,
      detail: `${path} does not include ${tool}.`,
      fix: `Add ${tool} to ${path}.`,
    };
  }
  return {
    stage: "session",
    source: step.label,
    detail: `${step.label} does not include ${tool}.`,
    fix: `Allow ${tool} in ${step.label} for this conversation.`,
  };
}

/**
 * Replays the final tool-policy composition for `toolNames`. An explicit deny wins
 * over an earlier profile exclusion: it records an intentional opt-out.
 */
export function explainToolPolicyAvailability(params: {
  config: OpenClawConfig;
  conversationCapabilityProfile: ResolvedConversationCapabilityProfile;
  toolNames: readonly string[];
  pluginId?: string;
}): ToolAvailability[] {
  const blocks = new Map<string, { event: ToolPolicyFilterEvent; denied: boolean }>();
  const kept = applyFinalEffectiveToolPolicy({
    bundledTools: params.toolNames.map((name) => probeTool(name, params.pluginId)),
    config: params.config,
    conversationCapabilityProfile: params.conversationCapabilityProfile,
    warn: () => {},
    onFilter: (event) => {
      const permits = createToolPolicyMatcher(event.policy);
      const notDenied = createToolPolicyMatcher({ deny: event.policy.deny });
      for (const name of params.toolNames) {
        if (permits(name) || blocks.get(name)?.denied) {
          continue;
        }
        const denied = !notDenied(name);
        if (denied || !blocks.has(name)) {
          blocks.set(name, { event, denied });
        }
      }
    },
  });
  const keptNames = new Set(kept.map((tool) => tool.name));
  return params.toolNames.map((name): ToolAvailability => {
    const block = blocks.get(name);
    if (keptNames.has(name) || !block) {
      return { name, available: true };
    }
    return {
      name,
      available: false,
      block: describePolicyBlock({
        config: params.config,
        profile: params.conversationCapabilityProfile,
        ...block,
        toolName: name,
      }),
    };
  });
}

/**
 * Explains tool availability for an agent, or for one session when `sessionKey` is set.
 * Agent queries cover configured policy; session queries add the session's model,
 * harness and sandbox gates.
 */
export async function explainToolAvailability(
  params: ExplainToolAvailabilityParams,
): Promise<ToolAvailabilityReport> {
  const { config, sessionKey } = params;
  const agentId = normalizeAgentId(
    sessionKey
      ? resolveSessionAgentIds({ config, agentId: params.agentId, sessionKey }).sessionAgentId
      : (params.agentId ?? resolveDefaultAgentId(config)),
  );
  const sandbox = describeSandbox(config, agentId);
  // Session gates load harness, CLI-backend and sandbox runtime modules; agent
  // (config-only) queries such as Doctor never import them.
  const gates = sessionKey
    ? await (
        await import("./tool-availability-session-gates.runtime.js")
      ).prepareSessionToolGates({ config, agentId, sessionKey })
    : undefined;
  if (gates) {
    sandbox.sandboxed = gates.sandboxed;
  }
  const model = gates?.model ?? resolveSessionModelRef(config, undefined, agentId);
  const profile = await prepareConversationCapabilityProfile({
    config,
    agentId,
    sessionKey,
    modelProvider: model.provider,
    modelId: model.model,
  });
  const policy = explainToolPolicyAvailability({
    config,
    conversationCapabilityProfile: profile,
    toolNames: params.toolNames,
    pluginId: params.pluginId,
  });
  const tools = policy.map((entry): ToolAvailability => {
    if (!entry.available && entry.block.stage === "deny") {
      return entry;
    }
    const block = gates?.runBlock ?? gates?.sandboxBlock(entry.name);
    return block ? { name: entry.name, available: false, block } : entry;
  });
  return { agentId, sandbox, tools };
}
