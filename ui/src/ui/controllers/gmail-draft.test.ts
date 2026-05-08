/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import {
  createGmailDraft,
  openGmailSendConfirm,
  populateReplyDraftFromThread,
  sendGmailMessage,
  type GmailDraftState,
} from "./gmail-draft.ts";

function createState(): GmailDraftState {
  return {
    client: {
      request: vi.fn(),
    } as unknown as GmailDraftState["client"],
    connected: true,
    gmailDraftForm: {
      to: "",
      subject: "",
      textBody: "",
    },
    gmailDraftSaving: false,
    gmailDraftError: null,
    gmailDraftSuccess: null,
    gmailSendConfirmOpen: false,
    gmailSendPending: false,
    gmailSendError: null,
    gmailSendSuccess: null,
    gmailSelectedThread: {
      id: "thread-1",
      messages: [
        {
          id: "msg-1",
          subject: "Project update",
          from: "Taylor <taylor@example.com>",
          to: "David <david@example.com>",
          date: "Wed, 7 May 2026 10:00:00 -0500",
          snippet: "Wanted to send a quick update",
          bodyText: "Latest body",
          unread: true,
          messageId: "<msg-1@example.com>",
          references: ["<root@example.com>"],
        },
      ],
    },
  };
}

describe("gmail draft controller", () => {
  it("prefills a reply draft from the selected thread", () => {
    const state = createState();

    populateReplyDraftFromThread(state);

    expect(state.gmailDraftForm.to).toBe("taylor@example.com");
    expect(state.gmailDraftForm.subject).toBe("Re: Project update");
    expect(state.gmailDraftForm.threadId).toBe("thread-1");
    expect(state.gmailDraftForm.inReplyTo).toBe("<msg-1@example.com>");
  });

  it("opens send confirmation for a valid message", () => {
    const state = createState();
    populateReplyDraftFromThread(state);
    state.gmailDraftForm.textBody = "Looks good.";

    openGmailSendConfirm(state);

    expect(state.gmailSendConfirmOpen).toBe(true);
  });

  it("creates a draft via the gateway", async () => {
    const state = createState();
    populateReplyDraftFromThread(state);
    state.gmailDraftForm.textBody = "Sounds good — I’ll review it today.";
    const request = vi.mocked(state.client!.request);
    request.mockResolvedValue({ draft: { id: "draft-123" } });

    await createGmailDraft(state);

    expect(request).toHaveBeenCalledWith("gmail.drafts.create", {
      to: "taylor@example.com",
      subject: "Re: Project update",
      textBody: "Sounds good — I’ll review it today.",
      threadId: "thread-1",
      inReplyTo: "<msg-1@example.com>",
      references: ["<root@example.com>"],
    });
    expect(state.gmailDraftSuccess).toContain("draft-123");
    expect(state.gmailDraftForm.textBody).toBe("");
  });

  it("sends a message via the gateway", async () => {
    const state = createState();
    populateReplyDraftFromThread(state);
    state.gmailDraftForm.textBody = "Sending this now.";
    const request = vi.mocked(state.client!.request);
    request.mockResolvedValue({ message: { id: "sent-123" } });

    await sendGmailMessage(state);

    expect(request).toHaveBeenCalledWith("gmail.messages.send", {
      to: "taylor@example.com",
      subject: "Re: Project update",
      textBody: "Sending this now.",
      threadId: "thread-1",
      inReplyTo: "<msg-1@example.com>",
      references: ["<root@example.com>"],
    });
    expect(state.gmailSendSuccess).toContain("sent-123");
  });
});
