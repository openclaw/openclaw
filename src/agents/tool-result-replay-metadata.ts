import type { AgentMessage } from "@mariozechner/pi-agent-core";

export const STALE_TOOL_RESULT_REPLAY_THRESHOLD_MS = 60 * 60 * 1000;

type ReplayDiagnosticType =
  | "openclaw.plugins_list"
  | "openclaw.status"
  | "openclaw.config_snapshot"
  | "openclaw.plugin_path_probe";

type ToolResultReplayPolicyMeta = {
  transient: true;
  diagnosticType: ReplayDiagnosticType;
  /** Command string (exec/bash) or file path (read) used to identify the specific target. */
  diagnosticTarget?: string;
  taggedAt: number;
  persistedAt?: number;
  sourceTool: string;
};

type OpenClawReplayMetaEnvelope = {
  __openclaw?: Record<string, unknown> & {
    transient?: boolean;
    diagnosticType?: string;
    diagnosticTarget?: string;
    taggedAt?: number;
    persistedAt?: number;
    sourceTool?: string;
    replayOmitted?: boolean;
  };
};

const pendingToolResultReplayMeta = new Map<string, ToolResultReplayPolicyMeta>();

export function resolveToolResultReplaySessionKey(params: {
  sessionKey?: string;
  sessionId?: string;
}): string | undefined {
  return trimString(params.sessionKey) ?? trimString(params.sessionId);
}

function buildPendingKey(sessionKey: string, toolCallId: string): string {
  return `${sessionKey}:${toolCallId}`;
}

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function matchExecDiagnosticType(command: string): ReplayDiagnosticType | null {
  if (/^\s*openclaw\s+plugins\s+list(?:\s|$)/iu.test(command)) {
    return "openclaw.plugins_list";
  }
  if (/^\s*openclaw\s+status(?:\s|$)/iu.test(command)) {
    return "openclaw.status";
  }
  if (/^\s*openclaw\s+config\s+get(?:\s|$)/iu.test(command)) {
    return "openclaw.config_snapshot";
  }
  if (
    /\bcat\s+"[^"]*openclaw\.json"/iu.test(command) ||
    /\bcat\s+'[^']*openclaw\.json'/iu.test(command) ||
    /\bcat\s+[^"'`\s]*openclaw\.json(?:\s|$)/iu.test(command) ||
    /\bcat\s+"[^"]*extensions[\\/][^"]+[\\/]package\.json"/iu.test(command) ||
    /\bcat\s+'[^']*extensions[\\/][^']+[\\/]package\.json'/iu.test(command) ||
    /\bcat\s+[^"'`\s]*extensions[\\/][^/"'`\\\s]+[\\/]package\.json(?:\s|$)/iu.test(command)
  ) {
    return /openclaw\.json/iu.test(command)
      ? "openclaw.config_snapshot"
      : "openclaw.plugin_path_probe";
  }
  return null;
}

function matchReadDiagnosticType(filePath: string): ReplayDiagnosticType | null {
  if (/openclaw\.json$/iu.test(filePath)) {
    return "openclaw.config_snapshot";
  }
  if (/extensions[\\/][^/\\]+[\\/]package\.json$/iu.test(filePath)) {
    return "openclaw.plugin_path_probe";
  }
  return null;
}

export function detectToolResultReplayPolicyMeta(params: {
  toolName: string;
  args: unknown;
  taggedAt?: number;
}): ToolResultReplayPolicyMeta | null {
  const toolName = params.toolName.trim().toLowerCase();
  const taggedAt = params.taggedAt ?? Date.now();
  const record =
    params.args && typeof params.args === "object"
      ? (params.args as Record<string, unknown>)
      : undefined;

  if (toolName === "exec" || toolName === "bash") {
    const command = trimString(record?.command);
    if (!command) {
      return null;
    }
    const diagnosticType = matchExecDiagnosticType(command);
    if (!diagnosticType) {
      return null;
    }
    return {
      transient: true,
      diagnosticType,
      diagnosticTarget: command,
      taggedAt,
      sourceTool: toolName,
    };
  }

  if (toolName === "read") {
    const filePath = trimString(record?.path) ?? trimString(record?.file_path);
    if (!filePath) {
      return null;
    }
    const diagnosticType = matchReadDiagnosticType(filePath);
    if (!diagnosticType) {
      return null;
    }
    return {
      transient: true,
      diagnosticType,
      diagnosticTarget: filePath,
      taggedAt,
      sourceTool: toolName,
    };
  }

  return null;
}

export function recordPendingToolResultReplayMetadata(params: {
  sessionKey?: string;
  sessionId?: string;
  toolCallId?: string;
  toolName: string;
  args: unknown;
  taggedAt?: number;
}): void {
  const sessionKey = resolveToolResultReplaySessionKey(params);
  const toolCallId = trimString(params.toolCallId);
  if (!sessionKey || !toolCallId) {
    return;
  }
  const meta = detectToolResultReplayPolicyMeta({
    toolName: params.toolName,
    args: params.args,
    taggedAt: params.taggedAt,
  });
  if (!meta) {
    return;
  }
  pendingToolResultReplayMeta.set(buildPendingKey(sessionKey, toolCallId), meta);
}

export function consumePendingToolResultReplayMetadata(params: {
  sessionKey?: string;
  sessionId?: string;
  toolCallId?: string;
}): ToolResultReplayPolicyMeta | null {
  const sessionKey = resolveToolResultReplaySessionKey(params);
  const toolCallId = trimString(params.toolCallId);
  if (!sessionKey || !toolCallId) {
    return null;
  }
  const key = buildPendingKey(sessionKey, toolCallId);
  const meta = pendingToolResultReplayMeta.get(key) ?? null;
  pendingToolResultReplayMeta.delete(key);
  return meta;
}

export function applyToolResultReplayMetadata(
  message: AgentMessage,
  meta: ToolResultReplayPolicyMeta | null,
): AgentMessage {
  if (!meta || (message as { role?: unknown }).role !== "toolResult") {
    return message;
  }
  const next = message as AgentMessage & OpenClawReplayMetaEnvelope;
  return {
    ...next,
    __openclaw: {
      ...next.__openclaw,
      transient: true,
      diagnosticType: meta.diagnosticType,
      diagnosticTarget: meta.diagnosticTarget,
      taggedAt: meta.taggedAt,
      sourceTool: meta.sourceTool,
    },
  } as unknown as AgentMessage;
}

export function getToolResultReplayMetadata(
  message: AgentMessage,
): ToolResultReplayPolicyMeta | null {
  if ((message as { role?: unknown }).role !== "toolResult") {
    return null;
  }
  const meta = (message as OpenClawReplayMetaEnvelope).__openclaw;
  if (!meta || meta.transient !== true || typeof meta.diagnosticType !== "string") {
    return null;
  }
  return {
    transient: true,
    diagnosticType: meta.diagnosticType as ReplayDiagnosticType,
    diagnosticTarget: typeof meta.diagnosticTarget === "string" ? meta.diagnosticTarget : undefined,
    taggedAt: typeof meta.taggedAt === "number" ? meta.taggedAt : 0,
    persistedAt: typeof meta.persistedAt === "number" ? meta.persistedAt : undefined,
    sourceTool: typeof meta.sourceTool === "string" ? meta.sourceTool : "unknown",
  };
}

export function stampPersistedToolResultReplayMetadata(
  message: AgentMessage,
  meta: ToolResultReplayPolicyMeta | null,
): AgentMessage {
  if (!meta || (message as { role?: unknown }).role !== "toolResult") {
    return message;
  }
  const next = message as AgentMessage &
    OpenClawReplayMetaEnvelope & {
      timestamp?: unknown;
    };
  const persistedAt =
    typeof next.timestamp === "number" && Number.isFinite(next.timestamp)
      ? next.timestamp
      : Date.now();
  return {
    ...next,
    __openclaw: {
      ...next.__openclaw,
      transient: true,
      diagnosticType: meta.diagnosticType,
      diagnosticTarget: meta.diagnosticTarget,
      taggedAt: meta.taggedAt,
      persistedAt,
      sourceTool: meta.sourceTool,
    },
  } as unknown as AgentMessage;
}

export function replaceToolResultReplayContent(
  message: AgentMessage,
  replacementText: string,
): AgentMessage {
  if ((message as { role?: unknown }).role !== "toolResult") {
    return message;
  }
  const next = message as AgentMessage &
    OpenClawReplayMetaEnvelope & {
      content?: unknown;
    };
  const replacement =
    typeof next.content === "string"
      ? replacementText
      : Array.isArray(next.content)
        ? [{ type: "text", text: replacementText }]
        : replacementText;
  return {
    ...next,
    ...(replacement !== undefined ? { content: replacement } : {}),
    __openclaw: {
      ...next.__openclaw,
      replayOmitted: true,
    },
  } as unknown as AgentMessage;
}
