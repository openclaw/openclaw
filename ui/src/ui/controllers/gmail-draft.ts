import type { GatewayBrowserClient } from "../gateway.ts";
import type { GmailThreadView } from "./gmail-inbox.ts";

export type GmailDraftForm = {
  to: string;
  subject: string;
  textBody: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string[];
};

export type GmailDraftState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  gmailDraftForm: GmailDraftForm;
  gmailDraftSaving: boolean;
  gmailDraftError: string | null;
  gmailDraftSuccess: string | null;
  gmailSendConfirmOpen: boolean;
  gmailSendPending: boolean;
  gmailSendError: string | null;
  gmailSendSuccess: string | null;
  gmailSelectedThread: GmailThreadView | null;
};

function normalizeSubjectForReply(subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) {
    return "Re:";
  }
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

function parseEmailAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  if (match?.[1]) {
    return match[1].trim();
  }
  return value.trim();
}

function validateDraftFields(
  state: GmailDraftState,
): { to: string; subject: string; textBody: string } | null {
  const to = state.gmailDraftForm.to.trim();
  const subject = state.gmailDraftForm.subject.trim();
  const textBody = state.gmailDraftForm.textBody.trim();
  if (!to || !subject || !textBody) {
    state.gmailDraftError = "To, subject, and body are required to save a draft.";
    state.gmailDraftSuccess = null;
    return null;
  }
  return { to, subject, textBody };
}

export function updateGmailDraftForm(state: GmailDraftState, patch: Partial<GmailDraftForm>): void {
  state.gmailDraftForm = {
    ...state.gmailDraftForm,
    ...patch,
  };
  state.gmailDraftError = null;
  state.gmailDraftSuccess = null;
  state.gmailSendError = null;
  state.gmailSendSuccess = null;
}

export function populateReplyDraftFromThread(state: GmailDraftState): void {
  const lastMessage = state.gmailSelectedThread?.messages.at(-1) ?? null;
  if (!lastMessage) {
    return;
  }
  state.gmailDraftForm = {
    to: parseEmailAddress(lastMessage.from),
    subject: normalizeSubjectForReply(lastMessage.subject),
    textBody:
      state.gmailDraftForm.textBody || `\n\n---\n${lastMessage.bodyText || lastMessage.snippet}`,
    threadId: state.gmailSelectedThread?.id,
    inReplyTo: lastMessage.messageId || undefined,
    references: lastMessage.references?.length ? lastMessage.references : undefined,
  };
  state.gmailDraftError = null;
  state.gmailDraftSuccess = null;
  state.gmailSendError = null;
  state.gmailSendSuccess = null;
}

export function resetGmailDraftForm(state: GmailDraftState): void {
  state.gmailDraftForm = {
    to: "",
    subject: "",
    textBody: "",
  };
  state.gmailDraftError = null;
  state.gmailDraftSuccess = null;
  state.gmailSendConfirmOpen = false;
  state.gmailSendError = null;
  state.gmailSendSuccess = null;
}

export function openGmailSendConfirm(state: GmailDraftState): void {
  const valid = validateDraftFields(state);
  if (!valid) {
    state.gmailSendConfirmOpen = false;
    return;
  }
  state.gmailSendError = null;
  state.gmailSendSuccess = null;
  state.gmailSendConfirmOpen = true;
}

export function closeGmailSendConfirm(state: GmailDraftState): void {
  state.gmailSendConfirmOpen = false;
  state.gmailSendError = null;
}

export async function createGmailDraft(state: GmailDraftState): Promise<void> {
  if (!state.client || !state.connected || state.gmailDraftSaving) {
    return;
  }
  const valid = validateDraftFields(state);
  if (!valid) {
    return;
  }

  state.gmailDraftSaving = true;
  state.gmailDraftError = null;
  state.gmailDraftSuccess = null;
  try {
    const result = await state.client.request<{ draft?: { id?: string } }>("gmail.drafts.create", {
      to: valid.to,
      subject: valid.subject,
      textBody: valid.textBody,
      ...(state.gmailDraftForm.threadId ? { threadId: state.gmailDraftForm.threadId } : {}),
      ...(state.gmailDraftForm.inReplyTo ? { inReplyTo: state.gmailDraftForm.inReplyTo } : {}),
      ...(state.gmailDraftForm.references?.length
        ? { references: state.gmailDraftForm.references }
        : {}),
    });
    state.gmailDraftSuccess = result?.draft?.id
      ? `Draft saved (${result.draft.id}).`
      : "Draft saved.";
    state.gmailDraftForm = {
      ...state.gmailDraftForm,
      textBody: "",
    };
  } catch (error) {
    state.gmailDraftError = error instanceof Error ? error.message : String(error);
  } finally {
    state.gmailDraftSaving = false;
  }
}

export async function sendGmailMessage(state: GmailDraftState): Promise<void> {
  if (!state.client || !state.connected || state.gmailSendPending) {
    return;
  }
  const valid = validateDraftFields(state);
  if (!valid) {
    state.gmailSendConfirmOpen = false;
    return;
  }

  state.gmailSendPending = true;
  state.gmailSendError = null;
  state.gmailSendSuccess = null;
  try {
    const result = await state.client.request<{ message?: { id?: string } }>(
      "gmail.messages.send",
      {
        to: valid.to,
        subject: valid.subject,
        textBody: valid.textBody,
        ...(state.gmailDraftForm.threadId ? { threadId: state.gmailDraftForm.threadId } : {}),
        ...(state.gmailDraftForm.inReplyTo ? { inReplyTo: state.gmailDraftForm.inReplyTo } : {}),
        ...(state.gmailDraftForm.references?.length
          ? { references: state.gmailDraftForm.references }
          : {}),
      },
    );
    state.gmailSendSuccess = result?.message?.id
      ? `Message sent (${result.message.id}).`
      : "Message sent.";
    state.gmailSendConfirmOpen = false;
    state.gmailDraftForm = {
      ...state.gmailDraftForm,
      textBody: "",
    };
  } catch (error) {
    state.gmailSendError = error instanceof Error ? error.message : String(error);
  } finally {
    state.gmailSendPending = false;
  }
}
