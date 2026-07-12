/** Turn-scoped authorization for model-visible protected tools. */
import { createHash } from "node:crypto";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import { copyPluginToolMeta } from "../plugins/tools.js";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../security/dangerous-tools.js";
import { copyBeforeToolCallHookMarker } from "./before-tool-call-metadata.js";
import { copyChannelAgentToolMeta } from "./channel-tools.js";
import type { AnyAgentTool } from "./tools/common.js";

export const TOOL_ACCESS_POLICY_CUSTOM_TYPE = "openclaw.tool-access-policy";
export const TOOL_ACCESS_DENIED_CODE = "TOOL_ACCESS_DENIED";

export type ToolAccessPolicySenderClass = "owner" | "trusted_internal" | "non_owner" | "unknown";
export type ToolAccessPolicyReason =
  | "authorized_owner"
  | "authorized_internal"
  | "ambient_room_event"
  | "non_owner_sender"
  | "unknown_sender";

export type ToolAccessPolicy = {
  version: string;
  allowedToolNames: readonly string[];
  deniedToolNames: readonly string[];
  eventKind: InboundEventKind | "unknown";
  senderClass: ToolAccessPolicySenderClass;
  reason: ToolAccessPolicyReason;
};

export type ToolAccessPolicyCustomMessage = {
  customType: typeof TOOL_ACCESS_POLICY_CUSTOM_TYPE;
  content: string;
  display: false;
  details: {
    source: "openclaw-tool-access-policy";
    policyVersion: string;
    toolAccessPolicyCarrier: true;
  };
};

const PROTECTED_TOOL_NAMES = [...GATEWAY_OWNER_ONLY_CORE_TOOLS].toSorted();
const TRUSTED_INTERNAL_TRIGGERS = new Set(["cron", "heartbeat", "memory"]);

function resolveSenderClass(params: {
  senderIsOwner: boolean | undefined;
  hasSenderIdentity: boolean | undefined;
  trigger: string | undefined;
}): ToolAccessPolicySenderClass {
  if (params.senderIsOwner === true) {
    return "owner";
  }
  if (
    params.hasSenderIdentity !== true &&
    params.trigger &&
    TRUSTED_INTERNAL_TRIGGERS.has(params.trigger)
  ) {
    return "trusted_internal";
  }
  if (params.senderIsOwner === false) {
    return "non_owner";
  }
  return "unknown";
}

function resolvePolicyReason(params: {
  eventKind: ToolAccessPolicy["eventKind"];
  senderClass: ToolAccessPolicySenderClass;
}): ToolAccessPolicyReason {
  if (params.eventKind === "room_event") {
    return "ambient_room_event";
  }
  if (params.senderClass === "non_owner") {
    return "non_owner_sender";
  }
  if (params.senderClass === "unknown") {
    return "unknown_sender";
  }
  return params.senderClass === "trusted_internal" ? "authorized_internal" : "authorized_owner";
}

/** Resolve the authoritative protected-tool policy from trusted turn facts. */
export function resolveToolAccessPolicy(params: {
  senderIsOwner?: boolean;
  hasSenderIdentity?: boolean;
  inboundEventKind?: InboundEventKind;
  trigger?: string;
}): ToolAccessPolicy {
  const eventKind = params.inboundEventKind ?? "unknown";
  const senderClass = resolveSenderClass({
    senderIsOwner: params.senderIsOwner,
    hasSenderIdentity: params.hasSenderIdentity,
    trigger: params.trigger,
  });
  const reason = resolvePolicyReason({ eventKind, senderClass });
  const denied = reason !== "authorized_owner" && reason !== "authorized_internal";
  const allowedToolNames = denied ? [] : PROTECTED_TOOL_NAMES;
  const deniedToolNames = denied ? PROTECTED_TOOL_NAMES : [];
  const digestSource = JSON.stringify({
    allowedToolNames,
    deniedToolNames,
    eventKind,
    senderClass,
    reason,
  });
  const version = `tap-${createHash("sha256").update(digestSource).digest("hex").slice(0, 12)}`;
  return {
    version,
    allowedToolNames,
    deniedToolNames,
    eventKind,
    senderClass,
    reason,
  };
}

function renderToolList(toolNames: readonly string[]): string[] {
  return toolNames.length > 0 ? toolNames.map((name) => `- ${name}`) : ["- none"];
}

/** Serialize a complete trusted snapshot; never serialize sender ids or other private facts. */
export function buildToolAccessPolicySnapshot(policy: ToolAccessPolicy): string {
  return [
    "[OpenClaw runtime tool policy]",
    `Policy version: ${policy.version}`,
    `Event kind: ${policy.eventKind}`,
    `Sender class: ${policy.senderClass}`,
    "",
    "Protected tools allowed by this turn policy:",
    ...renderToolList(policy.allowedToolNames),
    "",
    "Protected tools unavailable this turn:",
    ...renderToolList(policy.deniedToolNames),
    "",
    "The runtime rejects unavailable tool calls before execution. Do not retry a non-retryable denial during this turn.",
  ].join("\n");
}

export function buildToolAccessPolicyCustomMessage(
  policy: ToolAccessPolicy,
): ToolAccessPolicyCustomMessage {
  return {
    customType: TOOL_ACCESS_POLICY_CUSTOM_TYPE,
    content: buildToolAccessPolicySnapshot(policy),
    display: false,
    details: {
      source: "openclaw-tool-access-policy",
      policyVersion: policy.version,
      toolAccessPolicyCarrier: true,
    },
  };
}

function buildDeniedMessage(toolName: string, policy: ToolAccessPolicy): string {
  if (policy.reason === "ambient_room_event") {
    return `${toolName} is unavailable during this room event`;
  }
  if (policy.reason === "non_owner_sender") {
    return `${toolName} is unavailable for this sender`;
  }
  return `${toolName} is unavailable because sender authorization is unknown`;
}

export function buildToolAccessDeniedResult(toolName: string, policy: ToolAccessPolicy) {
  const error = {
    code: TOOL_ACCESS_DENIED_CODE,
    tool: toolName,
    policy_version: policy.version,
    event_kind: policy.eventKind,
    reason: policy.reason,
    retryable: false,
    message: buildDeniedMessage(toolName, policy),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error }) }],
    details: {
      status: "blocked" as const,
      deniedReason: "tool-access-policy",
      error,
    },
  };
}

/** Wrap a protected tool with a hard authorization check before hooks or side effects run. */
export function wrapToolWithToolAccessPolicy(
  tool: AnyAgentTool,
  policy: ToolAccessPolicy,
): AnyAgentTool {
  if (!PROTECTED_TOOL_NAMES.includes(tool.name as (typeof PROTECTED_TOOL_NAMES)[number])) {
    return tool;
  }
  if (!policy.deniedToolNames.includes(tool.name)) {
    return tool;
  }
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async () => buildToolAccessDeniedResult(tool.name, policy),
  };
  copyPluginToolMeta(tool, wrappedTool);
  copyChannelAgentToolMeta(tool as never, wrappedTool as never);
  copyBeforeToolCallHookMarker(tool, wrappedTool);
  return wrappedTool;
}
