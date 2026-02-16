import type { SessionEntry } from "../../config/sessions.js";
import type { ReplyPayload } from "../types.js";
import { callGateway } from "../../gateway/call.js";

export type DialogInterceptResult = {
  reply: ReplyPayload;
} | null;

export async function checkActiveDialog(params: {
  sessionKey: string;
  sessionEntry?: SessionEntry;
  cleanedBody: string;
}): Promise<DialogInterceptResult> {
  const { sessionKey, sessionEntry, cleanedBody } = params;

  const activeDialogId = sessionEntry?.activeDialogId;
  if (!activeDialogId) {
    return null;
  }

  // Check for cancel command
  const trimmed = cleanedBody.trim().toLowerCase();
  if (trimmed === "/dialog cancel" || trimmed === "/cancel") {
    try {
      await callGateway({
        method: "dialog.cancel",
        params: { dialogId: activeDialogId },
      });
    } catch {
      // Dialog may already be gone
    }

    // Clear activeDialogId on the session
    try {
      await callGateway({
        method: "sessions.patch",
        params: { key: sessionKey, activeDialogId: null },
      });
    } catch {
      // Best-effort
    }

    return {
      reply: { text: "Dialog cancelled." },
    };
  }

  // Submit the user's message as an answer
  let payload: Record<string, unknown>;
  try {
    payload = await callGateway({
      method: "dialog.answer",
      params: {
        dialogId: activeDialogId,
        value: cleanedBody,
      },
    });
  } catch {
    // Dialog may have expired or been cancelled externally — clear and let through
    try {
      await callGateway({
        method: "sessions.patch",
        params: { key: sessionKey, activeDialogId: null },
      });
    } catch {
      // Best-effort
    }
    return null;
  }

  const done = payload.done as boolean;
  const currentStep = payload.currentStep as {
    id: string;
    prompt: string;
  } | null;

  if (!done && currentStep) {
    // Send the next question — return it as the reply
    return {
      reply: { text: currentStep.prompt },
    };
  }

  // Dialog complete
  const answers = payload.answers as Record<string, unknown>;
  const outro = payload.outro as string | undefined;

  // Clear activeDialogId
  try {
    await callGateway({
      method: "sessions.patch",
      params: { sessionKey, activeDialogId: null },
    });
  } catch {
    // Best-effort
  }

  // Inject results into agent session
  const answersFormatted = JSON.stringify(answers, null, 2);
  try {
    await callGateway({
      method: "agent",
      params: {
        sessionKey,
        text: `[Dialog completed] Collected answers:\n${answersFormatted}`,
      },
    });
  } catch {
    // Best-effort
  }

  const completionMessage = outro || "Thanks, your responses have been recorded.";

  return {
    reply: { text: completionMessage },
  };
}
