import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getOrCreateSessionMcpRuntime } from "../agents/agent-bundle-mcp-runtime.js";
import type { SessionMcpRuntime } from "../agents/agent-bundle-mcp-types.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  fetchMcpAppView,
  getMcpAppViewLease,
  type McpAppViewLease,
} from "../agents/mcp-ui-resource.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { loadSessionEntry, visitSessionMessagesAsync } from "./session-utils.js";

const MCP_APP_RESTORE_IN_FLIGHT_KEY = Symbol.for("openclaw.mcpAppRestoreInFlight");

type McpAppDescriptor = {
  viewId: string;
  serverName: string;
  toolName: string;
  uiResourceUri: string;
  toolCallId: string;
};

type ReconstructionData = {
  descriptor: McpAppDescriptor;
  toolInput: unknown;
  toolResult: CallToolResult;
};

type ReconstructionResult = {
  runtime: SessionMcpRuntime;
  view: McpAppViewLease;
};

type TranscriptVisit = (visit: (message: unknown) => void) => Promise<void>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readDescriptor(value: unknown): McpAppDescriptor | undefined {
  const record = asRecord(value);
  const viewId = readString(record, "viewId");
  const serverName = readString(record, "serverName");
  const toolName = readString(record, "toolName");
  const uiResourceUri = readString(record, "uiResourceUri");
  const toolCallId = readString(record, "toolCallId");
  if (
    !viewId ||
    viewId.length > 128 ||
    !serverName ||
    serverName.length > 256 ||
    !toolName ||
    toolName.length > 256 ||
    !uiResourceUri?.startsWith("ui://") ||
    uiResourceUri.length > 2048 ||
    !toolCallId ||
    toolCallId.length > 512
  ) {
    return undefined;
  }
  return { viewId, serverName, toolName, uiResourceUri, toolCallId };
}

function readToolInputFromMessage(
  value: unknown,
  toolCallId: string,
): { found: true; input: unknown } | undefined {
  const message = asRecord(value);
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const blockValue of content) {
    const block = asRecord(blockValue);
    if ((readString(block, "id") ?? readString(block, "toolCallId")) !== toolCallId) {
      continue;
    }
    const type = readString(block, "type")?.toLowerCase();
    if (type !== "toolcall" && type !== "tool_call" && type !== "tooluse" && type !== "tool_use") {
      continue;
    }
    return { found: true, input: block?.arguments ?? block?.input ?? block?.args ?? {} };
  }
  return undefined;
}

function readCallToolResult(message: Record<string, unknown>, details: Record<string, unknown>) {
  const content = Array.isArray(message.content)
    ? message.content.filter((value) => {
        const block = asRecord(value);
        return block?.type === "text" || block?.type === "image";
      })
    : [];
  return {
    content,
    ...(details.structuredContent !== undefined
      ? { structuredContent: details.structuredContent }
      : {}),
    ...(message.isError === true || details.status === "error" ? { isError: true } : {}),
  } as CallToolResult;
}

function readTranscriptResult(
  value: unknown,
  viewId: string,
): Omit<ReconstructionData, "toolInput"> | undefined {
  const message = asRecord(value);
  if (!message || readString(message, "role")?.toLowerCase() !== "toolresult") {
    return undefined;
  }
  const details = asRecord(message.details);
  if (!details) {
    return undefined;
  }
  const preview = asRecord(details.mcpAppPreview);
  const descriptor = readDescriptor(asRecord(preview?.mcpApp));
  if (!descriptor || descriptor.viewId !== viewId) {
    return undefined;
  }
  if (
    readString(message, "toolCallId") !== descriptor.toolCallId ||
    readString(details, "mcpServer") !== descriptor.serverName ||
    readString(details, "mcpTool") !== descriptor.toolName
  ) {
    return undefined;
  }
  return { descriptor, toolResult: readCallToolResult(message, details) };
}

/** Finds a server-authored descriptor and its canonical tool call/result pair. */
export function findMcpAppReconstructionData(
  messages: unknown[],
  viewId: string,
): ReconstructionData | undefined {
  for (const value of messages.toReversed()) {
    const result = readTranscriptResult(value, viewId);
    if (!result) {
      continue;
    }
    const input = messages
      .map((message) => readToolInputFromMessage(message, result.descriptor.toolCallId))
      .find((entry) => entry?.found);
    return {
      ...result,
      toolInput: input?.input ?? {},
    };
  }
  return undefined;
}

/** Searches the full active transcript without retaining its messages in memory. */
export async function findMcpAppReconstructionDataByVisit(
  visitTranscript: TranscriptVisit,
  viewId: string,
): Promise<ReconstructionData | undefined> {
  let result: Omit<ReconstructionData, "toolInput"> | undefined;
  await visitTranscript((message) => {
    result ??= readTranscriptResult(message, viewId);
  });
  if (!result) {
    return undefined;
  }
  const resolvedResult = result;
  let toolInput: unknown = {};
  let foundInput = false;
  await visitTranscript((message) => {
    if (foundInput) {
      return;
    }
    const input = readToolInputFromMessage(message, resolvedResult.descriptor.toolCallId);
    if (input) {
      foundInput = true;
      toolInput = input.input;
    }
  });
  return { ...resolvedResult, toolInput };
}

function getRestoreInFlight(): Map<string, Promise<ReconstructionResult | undefined>> {
  const state = globalThis as Record<PropertyKey, unknown>;
  const existing = state[MCP_APP_RESTORE_IN_FLIGHT_KEY] as
    | Map<string, Promise<ReconstructionResult | undefined>>
    | undefined;
  if (existing) {
    return existing;
  }
  const created = new Map<string, Promise<ReconstructionResult | undefined>>();
  state[MCP_APP_RESTORE_IN_FLIGHT_KEY] = created;
  return created;
}

async function restoreMcpAppViewOnce(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  viewId: string;
}): Promise<ReconstructionResult | undefined> {
  if (!params.viewId.startsWith("mcp-app-") || params.viewId.length > 128) {
    return undefined;
  }
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const loaded = loadSessionEntry(params.sessionKey, { agentId });
  const sessionId = loaded.entry?.sessionId;
  if (!sessionId) {
    return undefined;
  }
  const transcriptScope = {
    agentId,
    sessionId,
    sessionKey: loaded.canonicalKey,
    storePath: loaded.storePath,
    sessionEntry: loaded.entry,
  };
  const data = await findMcpAppReconstructionDataByVisit(async (visit) => {
    await visitSessionMessagesAsync(transcriptScope, (message) => visit(message), {
      mode: "full",
      reason: "MCP App restart reconstruction",
      cache: "reuse",
    });
  }, params.viewId);
  if (!data) {
    return undefined;
  }
  const runtime = await getOrCreateSessionMcpRuntime({
    sessionId,
    sessionKey: loaded.canonicalKey,
    workspaceDir: resolveAgentWorkspaceDir(params.cfg, agentId),
    agentDir: resolveAgentDir(params.cfg, agentId),
    cfg: params.cfg,
  });
  if (runtime.mcpAppsEnabled !== true) {
    return undefined;
  }
  await fetchMcpAppView({
    runtime,
    serverName: data.descriptor.serverName,
    toolName: data.descriptor.toolName,
    uiResourceUri: data.descriptor.uiResourceUri,
    toolCallId: data.descriptor.toolCallId,
    toolInput: data.toolInput,
    toolResult: data.toolResult,
    viewId: data.descriptor.viewId,
    // A reconstructed preview can render and read its owning server resources,
    // but cannot call tools without a fresh run carrying current effective policy.
    allowedAppToolNames: new Set(),
  });
  const view = getMcpAppViewLease(params.viewId, runtime);
  return view ? { runtime, view } : undefined;
}

export async function restoreMcpAppView(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  viewId: string;
}): Promise<ReconstructionResult | undefined> {
  const key = `${params.sessionKey}\0${params.viewId}`;
  const inFlight = getRestoreInFlight();
  const existing = inFlight.get(key);
  if (existing) {
    return await existing;
  }
  const pending = restoreMcpAppViewOnce(params).finally(() => {
    if (inFlight.get(key) === pending) {
      inFlight.delete(key);
    }
  });
  inFlight.set(key, pending);
  return await pending;
}
