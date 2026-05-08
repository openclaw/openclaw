/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { loadGmailInbox, updateGmailInboxFilters, type GmailInboxState } from "./gmail-inbox.ts";

function createState(): GmailInboxState {
  return {
    client: {
      request: vi.fn(),
    } as unknown as GmailInboxState["client"],
    connected: true,
    gmailAuthStatus: {
      providerId: "google-gmail",
      connected: true,
      profiles: [{ profileId: "google-gmail:david@example.com", email: "david@example.com" }],
    },
    gmailInboxLoading: false,
    gmailInboxError: null,
    gmailInboxItems: [],
    gmailInboxQuery: "",
    gmailInboxUnreadOnly: false,
    gmailSelectedThreadId: null,
    gmailThreadLoading: false,
    gmailThreadError: null,
    gmailSelectedThread: null,
  };
}

describe("gmail inbox controller", () => {
  it("loads inbox messages and auto-selects the first thread", async () => {
    const state = createState();
    const request = vi.mocked(state.client!.request);
    request.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "gmail.messages.list") {
        return {
          messages: [{ id: "msg-1", threadId: "thread-1" }],
        };
      }
      if (method === "gmail.messages.get") {
        return {
          message: {
            id: String(params?.id),
            threadId: "thread-1",
            snippet: "Preview text",
            internalDate: String(Date.now()),
            labelIds: ["INBOX", "UNREAD"],
            payload: {
              headers: [
                { name: "Subject", value: "Inbox subject" },
                { name: "From", value: "Taylor <taylor@example.com>" },
              ],
            },
          },
        };
      }
      if (method === "gmail.threads.get") {
        return {
          thread: {
            id: "thread-1",
            messages: [
              {
                id: "msg-1",
                threadId: "thread-1",
                snippet: "Preview text",
                labelIds: ["INBOX", "UNREAD"],
                payload: {
                  headers: [
                    { name: "Subject", value: "Inbox subject" },
                    { name: "From", value: "Taylor <taylor@example.com>" },
                    { name: "To", value: "David <david@example.com>" },
                  ],
                  mimeType: "text/plain",
                  body: { data: "SGVsbG8gRGF2aWQ" },
                },
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    await loadGmailInbox(state);

    expect(request).toHaveBeenCalledWith("gmail.messages.list", {
      labelIds: ["INBOX"],
      maxResults: 12,
    });
    expect(state.gmailInboxItems[0]?.subject).toBe("Inbox subject");
    expect(state.gmailSelectedThreadId).toBe("thread-1");
    expect(state.gmailSelectedThread?.messages[0]?.bodyText).toContain("Hello David");
  });

  it("uses gmail search when filters are set", async () => {
    const state = createState();
    updateGmailInboxFilters(state, { query: "invoice", unreadOnly: true });
    const request = vi.mocked(state.client!.request);
    request.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "gmail.messages.search") {
        expect(params).toMatchObject({
          query: "invoice",
          inInbox: true,
          isUnread: true,
          maxResults: 12,
        });
        return { messages: [] };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    await loadGmailInbox(state);

    expect(request).toHaveBeenCalledWith("gmail.messages.search", {
      query: "invoice",
      inInbox: true,
      isUnread: true,
      maxResults: 12,
    });
  });
});
