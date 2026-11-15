import { normalizeChatType } from "../channels/chat-type.js";
import { conversationIdentityFromSessionEntry } from "../config/sessions/conversation-identity.js";
/** Session-only tool gates; loaded lazily so agent (config-only) queries stay light. */
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getSessionEntryAsync } from "../plugin-sdk/session-store-runtime-internal.js";
import {
  deliveryContextFromSession,
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
  sessionDeliveryRoute,
} from "../utils/delivery-context.read.js";
import { resolveCliBackendConfig } from "./cli-backends.js";
import { detectNodeClaudePlacement } from "./cli-runner/prepare-claude.js";
import { selectAgentHarness } from "./harness/selection.js";
import { agentHarnessExposesOpenClawTools } from "./harness/tool-surface.js";
import {
  isCliRuntimeAliasForProvider,
  resolveCliRuntimeExecutionProvider,
} from "./model-runtime-aliases.js";
import { supportsModelTools } from "./model-tool-support.js";
import { resolveSandboxRuntimeStatusAsync } from "./sandbox/runtime-status.js";
import { classifyToolAgainstSandboxToolPolicy } from "./sandbox/tool-policy.js";
import { resolveSessionModelRef } from "./session-model-ref.js";
import type { ToolAvailabilityBlock } from "./tool-availability-explanation.js";
import { resolveConfiguredModelCompat } from "./tools-effective-inventory.js";

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

/** Reads one session's model, harness and sandbox gates for `explainToolAvailability`. */
export async function prepareSessionToolGates(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}) {
  const { config, agentId, sessionKey } = params;
  const sessionEntry = await getSessionEntryAsync({ agentId, sessionKey });
  const sandboxRuntime = await resolveSandboxRuntimeStatusAsync({
    cfg: config,
    agentId,
    sessionKey,
  });
  const model = resolveSessionModelRef(config, sessionEntry, agentId);
  const runBlock = resolveRunToolSurfaceBlock({
    config,
    agentId,
    sessionKey,
    provider: model.provider,
    model: model.model,
    sessionEntry,
  });
  const delivery = deliveryContextFromSession(sessionEntry);
  // Same precedence as the reply route a real turn resolves from this session.
  const chatType = normalizeChatType(
    sessionDeliveryRoute(sessionEntry)?.target?.chatType ??
      sessionEntry?.chatType ??
      sessionDeliveryOrigin(sessionEntry)?.chatType,
  );
  const identity =
    sessionEntry && chatType ? conversationIdentityFromSessionEntry(sessionEntry) : null;
  return {
    model,
    // Group, direct and account tool policy match the session's canonical delivery route.
    conversation: {
      messageProvider: sessionDeliveryChannel(sessionEntry),
      agentAccountId: delivery?.accountId,
      chatType,
      conversationId: identity?.peerId,
      groupId: sessionEntry?.groupId,
      groupChannel: sessionEntry?.groupChannel,
      groupSpace: sessionEntry?.space,
    },
    sandboxed: sandboxRuntime.sandboxed,
    runBlock,
    sandboxBlock: (toolName: string) =>
      sandboxRuntime.sandboxed ? describeSandboxPolicyBlock(sandboxRuntime, toolName) : undefined,
  };
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
