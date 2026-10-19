import type { EmbeddedRunAttachment, ReplyOperation } from "./session-controller.contracts.js";
import {
  getSessionControllerEntryForOperation,
  assertSessionControllerOperation,
  resolveReplyRunForCurrentSessionId,
} from "./session-controller.identity.js";
export function resolveControllerNativeAttempt(sessionId: string) {
  const resolution = resolveReplyRunForCurrentSessionId(sessionId);
  if (resolution.kind !== "one") {
    return undefined;
  }
  const attachment = getSessionControllerEntryForOperation(resolution.operation).attachment;
  return attachment && "handle" in attachment && attachment.operation === resolution.operation
    ? attachment.handle
    : undefined;
}

export function attachControllerNativeAttempt(
  operation: ReplyOperation,
  attachment: EmbeddedRunAttachment,
): void {
  assertSessionControllerOperation(operation);
  if (attachment.operation !== operation) {
    throw new Error("Native attachment does not match its controller operation");
  }
  getSessionControllerEntryForOperation(operation).attachment = attachment;
}

export function detachControllerNativeAttempt(
  operation: ReplyOperation,
  attachment: EmbeddedRunAttachment,
): void {
  const entry = getSessionControllerEntryForOperation(operation);
  if (entry.attachment === attachment) {
    entry.attachment =
      attachment.backend || attachment.projectSessionActive !== undefined
        ? {
            operation,
            backend: attachment.backend,
            projectSessionActive: attachment.projectSessionActive,
          }
        : undefined;
  }
}
