import { extractAssistantVisibleText } from "./chat-message-content.js";

export function isTranscriptOnlyOpenClawAssistantMessage(message: unknown): boolean {
  return openclawAssistantModel(message) === "delivery-mirror";
}

export function stripTranscriptOnlyOpenClawAssistantMessages(messages: unknown[]): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const visible: unknown[] = [];
  for (const message of messages) {
    if (isTranscriptOnlyOpenClawAssistantMessage(message)) {
      changed = true;
      continue;
    }
    if (isDuplicateAcpGatewayInjectedMessage(message, visible.at(-1))) {
      changed = true;
      continue;
    }
    visible.push(message);
  }
  return changed ? visible : messages;
}

function openclawAssistantModel(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as {
    role?: unknown;
    provider?: unknown;
    model?: unknown;
  };
  return record.role === "assistant" &&
    record.provider === "openclaw" &&
    typeof record.model === "string"
    ? record.model
    : undefined;
}

function hasAssistantNonTextContent(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) && content.some((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }
    return (block as { type?: unknown }).type !== "text";
  });
}

function isDuplicateAcpGatewayInjectedMessage(
  current: unknown,
  previousVisible: unknown,
): boolean {
  if (
    openclawAssistantModel(previousVisible) !== "acp-runtime" ||
    openclawAssistantModel(current) !== "gateway-injected"
  ) {
    return false;
  }
  if (hasAssistantNonTextContent(previousVisible) || hasAssistantNonTextContent(current)) {
    return false;
  }
  const previousText = extractAssistantVisibleText(previousVisible)?.trim();
  const currentText = extractAssistantVisibleText(current)?.trim();
  return Boolean(previousText && currentText && previousText === currentText);
}
