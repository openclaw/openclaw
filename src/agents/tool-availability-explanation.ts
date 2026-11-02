import type { SessionEntry } from "../config/sessions/types.js";
/**
 * Explains whether named tools reach a run, and which stage removes them.
 *
 * Policy stages replay the final effective tool-policy composition that agent
 * sessions use, with probe tools that carry plugin ownership metadata. Run stages
 * (harness, model, sandbox) explain session-level gates around that policy. This
 * owner reports facts and generic remedies; callers word feature-specific advice.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getSessionEntryAsync } from "../plugin-sdk/session-store-runtime-internal.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  listAgentEntriesWithSource,
  resolveAgentConfig,
  resolveDefaultAgentId,
  resolveSessionAgentIds,
} from "./agent-scope.js";
import { resolveCliBackendConfig } from "./cli-backends.js";
import { detectNodeClaudePlacement } from "./cli-runner/prepare-claude.js";
import {
  prepareConversationCapabilityProfile,
  type ResolvedConversationCapabilityProfile,
} from "./conversation-capability-profile.js";
import { applyFinalEffectiveToolPolicy } from "./embedded-agent-runner/effective-tool-policy.js";
import { selectAgentHarness } from "./harness/selection.js";
import { agentHarnessExposesOpenClawTools } from "./harness/tool-surface.js";
import {
  isCliRuntimeAliasForProvider,
  resolveCliRuntimeExecutionProvider,
} from "./model-runtime-aliases.js";
import { supportsModelTools } from "./model-tool-support.js";
import { resolveProviderToolPolicyEntry } from "./provider-tool-policy.js";
import { resolveSandboxConfigForAgent } from "./sandbox/config.js";
import { resolveSandboxRuntimeStatusAsync } from "./sandbox/runtime-status.js";
import { classifyToolAgainstSandboxToolPolicy } from "./sandbox/tool-policy.js";
import { resolveSessionModelRef } from "./session-model-ref.js";
import { createToolPolicyMatcher } from "./tool-policy-match.js";
import type { ToolPolicyFilterEvent } from "./tool-policy-pipeline.js";
import { resolveConfiguredModelCompat } from "./tools-effective-inventory.js";
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
 * Explains a run-level gate that hides every OpenClaw tool: a harness or CLI backend
 * that does not expose OpenClaw tools, or a model without tool support.
 */
export function resolveRunToolSurfaceBlock(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  provider: string;
  model: string;
  sessionEntry?: Pick<
    SessionEntry,
    "agentRuntimeOverride" | "authProfileOverride" | "execHost" | "execNode"
  >;
}): Omit<ToolAvailabilityBlock, "source"> | undefined {
  const entry = params.sessionEntry;
  const runtimeOverride = entry?.agentRuntimeOverride;
  const cliProvider = isCliRuntimeAliasForProvider({
    provider: params.provider,
    runtime: runtimeOverride,
    cfg: params.config,
  })
    ? runtimeOverride
    : resolveCliRuntimeExecutionProvider({
        provider: params.provider,
        cfg: params.config,
        agentId: params.agentId,
        modelId: params.model,
        authProfileId: entry?.authProfileOverride,
      });
  if (cliProvider) {
    const cliBackend = resolveCliBackendConfig(cliProvider, params.config, {
      agentId: params.agentId,
    });
    if (!cliBackend?.bundleMcp) {
      return {
        stage: "harness",
        detail: `The ${cliProvider} CLI backend does not expose OpenClaw tools.`,
        fix: "Use a model route that runs on the OpenClaw harness, or a CLI backend with bundled MCP.",
      };
    }
    if (
      detectNodeClaudePlacement({
        backendId: cliBackend.id,
        execHost: entry?.execHost,
        execNode: entry?.execNode,
      })
    ) {
      return {
        stage: "harness",
        detail: `The ${cliProvider} CLI backend runs on a paired node, where OpenClaw tools are not exposed.`,
        fix: "Run this session on the Gateway host.",
      };
    }
  } else {
    const harness = selectAgentHarness({
      provider: params.provider,
      modelId: params.model,
      config: params.config,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    });
    if (!agentHarnessExposesOpenClawTools(harness.id)) {
      return {
        stage: "harness",
        detail: `The ${harness.id} harness does not expose OpenClaw tools.`,
        fix: "Use a model route that runs on the OpenClaw harness.",
      };
    }
  }
  const modelCompat = resolveConfiguredModelCompat({
    cfg: params.config,
    modelProvider: params.provider,
    modelId: params.model,
  });
  if (modelCompat && !supportsModelTools({ compat: modelCompat })) {
    return {
      stage: "model",
      detail: `${params.provider}/${params.model} does not support tools.`,
      fix: "Select a model with tool support.",
    };
  }
  return undefined;
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
  let sessionEntry: SessionEntry | undefined;
  let runBlock: ToolAvailabilityBlock | undefined;
  let sandboxRuntime: Awaited<ReturnType<typeof resolveSandboxRuntimeStatusAsync>> | undefined;
  if (sessionKey) {
    sessionEntry = await getSessionEntryAsync({ agentId, sessionKey });
    sandboxRuntime = await resolveSandboxRuntimeStatusAsync({ cfg: config, agentId, sessionKey });
    sandbox.sandboxed = sandboxRuntime.sandboxed;
  }
  const model = resolveSessionModelRef(config, sessionEntry, agentId);
  if (sessionKey) {
    runBlock = resolveRunToolSurfaceBlock({
      config,
      agentId,
      sessionKey,
      provider: model.provider,
      model: model.model,
      sessionEntry,
    });
  }
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
    if (runBlock) {
      return { name: entry.name, available: false, block: runBlock };
    }
    const sandboxBlock = sandboxRuntime?.sandboxed
      ? describeSandboxPolicyBlock(sandboxRuntime, entry.name)
      : undefined;
    return sandboxBlock ? { name: entry.name, available: false, block: sandboxBlock } : entry;
  });
  return { agentId, sandbox, tools };
}

function describeSandboxPolicyBlock(
  runtime: Awaited<ReturnType<typeof resolveSandboxRuntimeStatusAsync>>,
  toolName: string,
): ToolAvailabilityBlock | undefined {
  const { blockedByDeny, blockedByAllow } = classifyToolAgainstSandboxToolPolicy(
    toolName,
    runtime.toolPolicy,
  );
  if (!blockedByDeny && !blockedByAllow) {
    return undefined;
  }
  const tool = JSON.stringify(toolName);
  const source = blockedByDeny ? runtime.toolPolicy.sources.deny : runtime.toolPolicy.sources.allow;
  return {
    stage: "sandbox",
    source: source.key,
    detail: `Sandbox tool policy (mode=${runtime.mode}) ${blockedByDeny ? "denies" : "does not allow"} ${tool} via ${source.key}.`,
    fix: blockedByDeny ? `Remove ${tool} from ${source.key}.` : `Add ${tool} to ${source.key}.`,
  };
}
