// Message.processed diagnostic emission with captureContent-gated private content.
import { getRuntimeConfig } from "../config/config.js";
import { truncateDiagnosticContent } from "../infra/diagnostic-content.js";
import {
  emitInternalDiagnosticEvent,
  type DiagnosticEventInput,
} from "../infra/diagnostic-events.js";
import { resolveDiagnosticModelContentCapturePolicy } from "../infra/diagnostic-llm-content.js";

// Callers pass message facts without the discriminant; this owner stamps the
// event type so listeners' type guards match the dispatched event.
type MessageProcessedDiagnosticParams = Omit<
  Extract<DiagnosticEventInput, { type: "message.processed" }>,
  "type"
> & {
  userPrompt?: string;
  finalResponse?: string;
};

export function emitMessageProcessedDiagnosticEvent(
  params: MessageProcessedDiagnosticParams,
): void {
  // Gate each message content field on its own captureContent policy field so that
  // enabling input capture does not leak output text and vice versa.
  const contentPolicy = resolveDiagnosticModelContentCapturePolicy(getRuntimeConfig());
  const messageContent: { userPrompt?: string; finalResponse?: string } | undefined =
    contentPolicy.inputMessages || contentPolicy.outputMessages
      ? {
          ...(contentPolicy.inputMessages && params.userPrompt !== undefined
            ? { userPrompt: truncateDiagnosticContent(params.userPrompt) }
            : {}),
          ...(contentPolicy.outputMessages && params.finalResponse !== undefined
            ? { finalResponse: truncateDiagnosticContent(params.finalResponse) }
            : {}),
        }
      : undefined;
  const hasContent = messageContent !== undefined && Object.keys(messageContent).length > 0;
  const { userPrompt: _userPrompt, finalResponse: _finalResponse, ...event } = params;
  emitInternalDiagnosticEvent(
    { type: "message.processed" as const, ...event },
    hasContent ? { messageContent } : undefined,
  );
}
