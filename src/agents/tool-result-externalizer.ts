import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import path from "node:path";
import {
  buildToolResultPlaceholder,
  writeToolResultArtifact,
} from "./pi-extensions/context-pruning/artifacts.js";
import { getToolResultArtifactRef, withToolResultArtifactRef } from "./session-artifacts.js";

function isToolResultMessage(message: AgentMessage): message is ToolResultMessage {
  return (message as { role?: unknown }).role === "toolResult";
}

export function externalizeToolResultForSession(params: {
  message: AgentMessage;
  sessionFile?: string | null;
  sessionKey?: string;
  isSynthetic?: boolean;
}): AgentMessage {
  const { message, sessionFile, sessionKey, isSynthetic } = params;
  if (!isToolResultMessage(message)) {
    return message;
  }
  if (isSynthetic) {
    return message;
  }
  if (getToolResultArtifactRef(message)) {
    return message;
  }
  if (!Array.isArray(message.content)) {
    return message;
  }
  if (!sessionFile) {
    return message;
  }
  const artifactDir = path.join(path.dirname(sessionFile), "artifacts");
  const ref = writeToolResultArtifact({
    artifactDir,
    toolName: message.toolName,
    content: message.content,
    sessionKey,
  });
  const placeholder = buildToolResultPlaceholder(ref);
  const details = withToolResultArtifactRef((message as { details?: unknown }).details, ref);
  const content: ToolResultMessage["content"] = [{ type: "text", text: placeholder }];
  return {
    ...message,
    content,
    details,
  };
}
