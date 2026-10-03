import { type CallToolResult, ContentBlockSchema } from "@modelcontextprotocol/sdk/types.js";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { BoardMcpAppDescriptor } from "../../packages/gateway-protocol/src/index.js";

type McpAppDescriptor = BoardMcpAppDescriptor & {
  viewId: string;
  resultMetaState?: "unavailable";
};

export type McpAppTranscriptLookup = { viewId: string } | { descriptor: BoardMcpAppDescriptor };

export type McpAppReconstructionData = {
  descriptor: McpAppDescriptor;
  toolInput: unknown;
  toolResult: CallToolResult;
};

type TranscriptVisit = (visit: (message: unknown) => void) => void;
type TranscriptResult = Omit<McpAppReconstructionData, "toolInput"> & { modelToolName: string };
type TranscriptResultRead =
  | { kind: "restorable"; value: TranscriptResult }
  | { kind: "unavailable" };

function readDescriptor(value: unknown): McpAppDescriptor | undefined {
  const record = asOptionalRecord(value);
  const viewId = normalizeOptionalString(record?.viewId);
  const serverName = normalizeOptionalString(record?.serverName);
  const toolName = normalizeOptionalString(record?.toolName);
  const uiResourceUri = normalizeOptionalString(record?.uiResourceUri);
  const toolCallId = normalizeOptionalString(record?.toolCallId);
  const rawResultMetaState = record?.resultMetaState;
  const resultMetaState = rawResultMetaState === "unavailable" ? rawResultMetaState : undefined;
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
    toolCallId.length > 512 ||
    (rawResultMetaState !== undefined && resultMetaState === undefined)
  ) {
    return undefined;
  }
  return {
    viewId,
    serverName,
    toolName,
    uiResourceUri,
    toolCallId,
    ...(resultMetaState ? { resultMetaState } : {}),
  };
}

function readToolInputFromMessage(
  value: unknown,
  toolCallId: string,
  modelToolName: string,
): { input: unknown } | undefined {
  const message = asOptionalRecord(value);
  if (normalizeOptionalString(message?.role)?.toLowerCase() !== "assistant") {
    return undefined;
  }
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const blockValue of content) {
    const block = asOptionalRecord(blockValue);
    if (
      (normalizeOptionalString(block?.id) ?? normalizeOptionalString(block?.toolCallId)) !==
      toolCallId
    ) {
      continue;
    }
    const type = normalizeOptionalString(block?.type)?.toLowerCase();
    if (type !== "toolcall" && type !== "tool_call" && type !== "tooluse" && type !== "tool_use") {
      continue;
    }
    const blockToolName =
      normalizeOptionalString(block?.name) ??
      normalizeOptionalString(block?.toolName) ??
      normalizeOptionalString(block?.tool_name);
    if (blockToolName !== modelToolName) {
      continue;
    }
    return { input: block?.arguments ?? block?.input ?? block?.args ?? {} };
  }
  return undefined;
}

function readCallToolResult(
  message: Record<string, unknown>,
  details: Record<string, unknown>,
): CallToolResult {
  const content = Array.isArray(message.content)
    ? message.content.flatMap((value) => {
        const parsed = ContentBlockSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  const structuredContent = asOptionalRecord(details.structuredContent);
  return {
    content,
    ...(structuredContent ? { structuredContent } : {}),
    ...(message.isError === true || details.status === "error" ? { isError: true } : {}),
  };
}

function matchesLookup(
  rawDescriptor: Record<string, unknown> | undefined,
  lookup: McpAppTranscriptLookup,
): boolean {
  if ("viewId" in lookup) {
    return normalizeOptionalString(rawDescriptor?.viewId) === lookup.viewId;
  }
  const descriptor = lookup.descriptor;
  return (
    normalizeOptionalString(rawDescriptor?.serverName) === descriptor.serverName &&
    normalizeOptionalString(rawDescriptor?.toolName) === descriptor.toolName &&
    normalizeOptionalString(rawDescriptor?.uiResourceUri) === descriptor.uiResourceUri &&
    normalizeOptionalString(rawDescriptor?.toolCallId) === descriptor.toolCallId
  );
}

function readTranscriptResult(
  value: unknown,
  lookup: McpAppTranscriptLookup,
): TranscriptResultRead | undefined {
  const message = asOptionalRecord(value);
  if (!message || normalizeOptionalString(message.role)?.toLowerCase() !== "toolresult") {
    return undefined;
  }
  const details = asOptionalRecord(message.details);
  if (!details) {
    return undefined;
  }
  const preview = asOptionalRecord(details.mcpAppPreview);
  const rawDescriptor = asOptionalRecord(preview?.mcpApp);
  if (!matchesLookup(rawDescriptor, lookup)) {
    return undefined;
  }
  const descriptor = readDescriptor(rawDescriptor);
  const modelToolName =
    normalizeOptionalString(message.toolName) ?? normalizeOptionalString(message.tool_name);
  if (!descriptor || !modelToolName) {
    return { kind: "unavailable" };
  }
  if (
    normalizeOptionalString(message.toolCallId) !== descriptor.toolCallId ||
    normalizeOptionalString(details.mcpServer) !== descriptor.serverName ||
    normalizeOptionalString(details.mcpTool) !== descriptor.toolName ||
    descriptor.resultMetaState === "unavailable"
  ) {
    return { kind: "unavailable" };
  }
  return {
    kind: "restorable",
    value: { descriptor, modelToolName, toolResult: readCallToolResult(message, details) },
  };
}

/** Searches the full active transcript without retaining its messages in memory. */
export function selectMcpAppReconstructionData(
  visitTranscript: TranscriptVisit,
  lookup: McpAppTranscriptLookup,
): McpAppReconstructionData | undefined {
  let resultRead: TranscriptResultRead | undefined;
  let resultIndex = -1;
  let messageIndex = 0;
  visitTranscript((message) => {
    const read = readTranscriptResult(message, lookup);
    if (read) {
      resultRead = read;
      resultIndex = messageIndex;
    }
    messageIndex += 1;
  });
  if (!resultRead || resultRead.kind === "unavailable") {
    return undefined;
  }
  const resolvedResult = resultRead.value;
  let input: ReturnType<typeof readToolInputFromMessage>;
  messageIndex = 0;
  visitTranscript((message) => {
    if (messageIndex < resultIndex) {
      input =
        readToolInputFromMessage(
          message,
          resolvedResult.descriptor.toolCallId,
          resolvedResult.modelToolName,
        ) ?? input;
    }
    messageIndex += 1;
  });
  if (!input) {
    return undefined;
  }
  const { modelToolName: _modelToolName, ...reconstruction } = resolvedResult;
  return { ...reconstruction, toolInput: input.input };
}
