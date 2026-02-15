import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { handleGmailAction } from "./gmail-actions.js";

const listGmailMessages = vi.fn(async () => []);
const getGmailMessage = vi.fn(async () => ({}));
const searchGmailMessages = vi.fn(async () => []);
const sendGmailMessage = vi.fn(async () => ({ id: "sent-msg-1" }));
const createGmailDraft = vi.fn(async () => ({ id: "draft-1" }));
const triageGmailMessages = vi.fn(async () => ({
  urgent: [],
  needs_reply: [],
  informational: [],
  can_archive: [],
}));

vi.mock("../../gmail/actions.js", () => ({
  listGmailMessages: (...args: unknown[]) => listGmailMessages(...args),
  getGmailMessage: (...args: unknown[]) => getGmailMessage(...args),
  searchGmailMessages: (...args: unknown[]) => searchGmailMessages(...args),
  sendGmailMessage: (...args: unknown[]) => sendGmailMessage(...args),
  createGmailDraft: (...args: unknown[]) => createGmailDraft(...args),
  triageGmailMessages: (...args: unknown[]) => triageGmailMessages(...args),
}));

function makeCfg(
  overrides?: Partial<{ actions: Record<string, boolean>; accounts: Record<string, unknown> }>,
): OpenClawConfig {
  return {
    channels: {
      gmail: {
        enabled: true,
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        refreshToken: "test-refresh-token",
        actions: overrides?.actions,
        accounts: overrides?.accounts,
      },
    },
  } as OpenClawConfig;
}

beforeEach(() => {
  listGmailMessages.mockClear();
  getGmailMessage.mockClear();
  searchGmailMessages.mockClear();
  sendGmailMessage.mockClear();
  createGmailDraft.mockClear();
  triageGmailMessages.mockClear();
});

describe("handleGmailAction", () => {
  describe("read action", () => {
    it("returns unread email summaries from a specified account", async () => {
      const summaries = [
        {
          from: "alice@example.com",
          subject: "Hello",
          snippet: "Hi there",
          date: "2026-01-01",
          threadId: "t1",
        },
      ];
      listGmailMessages.mockResolvedValueOnce(summaries);
      const cfg = makeCfg();

      const result = await handleGmailAction({ action: "read", accountId: "edubites" }, cfg);
      const payload = result.details as { ok: boolean; messages: unknown[] };

      expect(payload.ok).toBe(true);
      expect(payload.messages).toEqual(summaries);
      expect(listGmailMessages).toHaveBeenCalled();
    });

    it("passes count as maxResults", async () => {
      listGmailMessages.mockResolvedValueOnce([]);
      const cfg = makeCfg();

      await handleGmailAction({ action: "read", accountId: "edubites", count: 5 }, cfg);

      const callArgs = listGmailMessages.mock.calls[0] as unknown[];
      expect(callArgs).toBeDefined();
      const opts = callArgs[1] as Record<string, unknown>;
      expect(opts.maxResults).toBe(5);
    });

    it("filters unread by default", async () => {
      listGmailMessages.mockResolvedValueOnce([]);
      const cfg = makeCfg();

      await handleGmailAction({ action: "read", accountId: "edubites" }, cfg);

      const callArgs = listGmailMessages.mock.calls[0] as unknown[];
      const opts = callArgs[1] as Record<string, unknown>;
      expect(opts.unreadOnly).toBe(true);
    });

    it("reads all messages when unreadOnly is false", async () => {
      listGmailMessages.mockResolvedValueOnce([]);
      const cfg = makeCfg();

      await handleGmailAction({ action: "read", accountId: "edubites", unreadOnly: false }, cfg);

      const callArgs = listGmailMessages.mock.calls[0] as unknown[];
      const opts = callArgs[1] as Record<string, unknown>;
      expect(opts.unreadOnly).toBe(false);
    });

    it("passes label filter", async () => {
      listGmailMessages.mockResolvedValueOnce([]);
      const cfg = makeCfg();

      await handleGmailAction({ action: "read", accountId: "edubites", label: "STARRED" }, cfg);

      const callArgs = listGmailMessages.mock.calls[0] as unknown[];
      const opts = callArgs[1] as Record<string, unknown>;
      expect(opts.label).toBe("STARRED");
    });
  });

  describe("get action", () => {
    it("returns full message details", async () => {
      const message = {
        id: "msg123",
        body: "Full email body",
        from: "alice@example.com",
        subject: "Test",
        attachments: [{ filename: "doc.pdf", mimeType: "application/pdf" }],
      };
      getGmailMessage.mockResolvedValueOnce(message);
      const cfg = makeCfg();

      const result = await handleGmailAction(
        { action: "get", accountId: "edubites", messageId: "msg123" },
        cfg,
      );
      const payload = result.details as { ok: boolean; message: unknown };

      expect(payload.ok).toBe(true);
      expect(payload.message).toEqual(message);
      expect(getGmailMessage).toHaveBeenCalledWith("edubites", "msg123");
    });

    it("throws ToolInputError when messageId is missing", async () => {
      const cfg = makeCfg();

      await expect(
        handleGmailAction({ action: "get", accountId: "edubites" }, cfg),
      ).rejects.toThrow(/messageId required/);
    });
  });

  describe("search action", () => {
    it("searches a single account", async () => {
      const matches = [{ id: "msg1", subject: "Meeting", snippet: "Let us meet" }];
      searchGmailMessages.mockResolvedValueOnce(matches);
      const cfg = makeCfg();

      const result = await handleGmailAction(
        { action: "search", accountId: "edubites", query: "from:thomas" },
        cfg,
      );
      const payload = result.details as { ok: boolean; results: unknown[] };

      expect(payload.ok).toBe(true);
      expect(payload.results).toEqual(matches);
      expect(searchGmailMessages).toHaveBeenCalledWith("edubites", "from:thomas");
    });

    it('searches all accounts when accountId is "all"', async () => {
      const cfg = makeCfg({
        accounts: {
          edubites: { refreshToken: "tok1" },
          protaige: { refreshToken: "tok2" },
          zenloop: { refreshToken: "tok3" },
        },
      });
      searchGmailMessages.mockResolvedValue([{ id: "msg1" }]);

      const result = await handleGmailAction(
        { action: "search", accountId: "all", query: "meeting" },
        cfg,
      );
      const payload = result.details as { ok: boolean; results: unknown[] };

      expect(payload.ok).toBe(true);
      expect(searchGmailMessages).toHaveBeenCalledTimes(3);
    });

    it("throws ToolInputError when query is missing", async () => {
      const cfg = makeCfg();

      await expect(
        handleGmailAction({ action: "search", accountId: "edubites" }, cfg),
      ).rejects.toThrow(/query required/);
    });
  });

  describe("send action", () => {
    it("sends email from the correct account and returns message ID", async () => {
      sendGmailMessage.mockResolvedValueOnce({ id: "sent-msg-1" });
      const cfg = makeCfg();

      const result = await handleGmailAction(
        {
          action: "send",
          accountId: "protaige",
          to: "bob@example.com",
          subject: "Hello",
          body: "Hi Bob",
        },
        cfg,
      );
      const payload = result.details as { ok: boolean; messageId: string };

      expect(payload.ok).toBe(true);
      expect(payload.messageId).toBe("sent-msg-1");
      expect(sendGmailMessage).toHaveBeenCalled();
    });

    it("throws ToolInputError when to is missing", async () => {
      const cfg = makeCfg();

      await expect(
        handleGmailAction(
          { action: "send", accountId: "protaige", subject: "Hi", body: "Hello" },
          cfg,
        ),
      ).rejects.toThrow(/to required/);
    });

    it("throws ToolInputError when subject is missing", async () => {
      const cfg = makeCfg();

      await expect(
        handleGmailAction(
          { action: "send", accountId: "protaige", to: "a@b.com", body: "Hello" },
          cfg,
        ),
      ).rejects.toThrow(/subject required/);
    });

    it("throws ToolInputError when body is missing", async () => {
      const cfg = makeCfg();

      await expect(
        handleGmailAction(
          { action: "send", accountId: "protaige", to: "a@b.com", subject: "Hi" },
          cfg,
        ),
      ).rejects.toThrow(/body required/);
    });

    it("sends a reply with replyToMessageId", async () => {
      sendGmailMessage.mockResolvedValueOnce({ id: "sent-reply-1" });
      const cfg = makeCfg();

      await handleGmailAction(
        {
          action: "send",
          accountId: "protaige",
          to: "bob@example.com",
          subject: "Re: Hello",
          body: "Got it",
          replyToMessageId: "msg123",
        },
        cfg,
      );

      const callArgs = sendGmailMessage.mock.calls[0] as unknown[];
      const opts = callArgs[1] as Record<string, unknown>;
      expect(opts.replyToMessageId).toBe("msg123");
    });

    it("sends with cc", async () => {
      sendGmailMessage.mockResolvedValueOnce({ id: "sent-cc-1" });
      const cfg = makeCfg();

      await handleGmailAction(
        {
          action: "send",
          accountId: "protaige",
          to: "bob@example.com",
          subject: "Hi",
          body: "Hello",
          cc: "carol@example.com",
        },
        cfg,
      );

      const callArgs = sendGmailMessage.mock.calls[0] as unknown[];
      const opts = callArgs[1] as Record<string, unknown>;
      expect(opts.cc).toBe("carol@example.com");
    });
  });

  describe("draft action", () => {
    it("creates a draft without sending and returns draft ID", async () => {
      createGmailDraft.mockResolvedValueOnce({ id: "draft-1" });
      const cfg = makeCfg();

      const result = await handleGmailAction(
        {
          action: "draft",
          accountId: "zenloop",
          to: "alice@example.com",
          subject: "Draft test",
          body: "This is a draft",
        },
        cfg,
      );
      const payload = result.details as { ok: boolean; draftId: string };

      expect(payload.ok).toBe(true);
      expect(payload.draftId).toBe("draft-1");
      expect(createGmailDraft).toHaveBeenCalled();
      expect(sendGmailMessage).not.toHaveBeenCalled();
    });

    it("creates a draft reply with replyToMessageId", async () => {
      createGmailDraft.mockResolvedValueOnce({ id: "draft-reply-1" });
      const cfg = makeCfg();

      await handleGmailAction(
        {
          action: "draft",
          accountId: "zenloop",
          to: "alice@example.com",
          subject: "Re: Draft test",
          body: "Reply draft",
          replyToMessageId: "msg456",
        },
        cfg,
      );

      const callArgs = createGmailDraft.mock.calls[0] as unknown[];
      const opts = callArgs[1] as Record<string, unknown>;
      expect(opts.replyToMessageId).toBe("msg456");
    });
  });

  describe("triage action", () => {
    it("categorizes emails from a single account", async () => {
      const triageResult = {
        urgent: [{ id: "u1", subject: "URGENT" }],
        needs_reply: [{ id: "r1", subject: "Question" }],
        informational: [{ id: "i1", subject: "Newsletter" }],
        can_archive: [{ id: "a1", subject: "Old thread" }],
      };
      triageGmailMessages.mockResolvedValueOnce(triageResult);
      const cfg = makeCfg();

      const result = await handleGmailAction({ action: "triage", accountId: "edubites" }, cfg);
      const payload = result.details as { ok: boolean; triage: typeof triageResult };

      expect(payload.ok).toBe(true);
      expect(payload.triage).toEqual(triageResult);
    });

    it('triages all accounts when accountId is "all"', async () => {
      const cfg = makeCfg({
        accounts: {
          edubites: { refreshToken: "tok1" },
          protaige: { refreshToken: "tok2" },
          zenloop: { refreshToken: "tok3" },
        },
      });
      triageGmailMessages.mockResolvedValue({
        urgent: [],
        needs_reply: [],
        informational: [],
        can_archive: [],
      });

      const result = await handleGmailAction({ action: "triage", accountId: "all" }, cfg);
      const payload = result.details as { ok: boolean };

      expect(payload.ok).toBe(true);
      expect(triageGmailMessages).toHaveBeenCalledTimes(3);
    });
  });

  describe("action gating", () => {
    it("throws when read action is disabled", async () => {
      const cfg = makeCfg({ actions: { read: false } });

      await expect(
        handleGmailAction({ action: "read", accountId: "edubites" }, cfg),
      ).rejects.toThrow(/Gmail read is disabled/);
    });

    it("throws when send action is disabled", async () => {
      const cfg = makeCfg({ actions: { send: false } });

      await expect(
        handleGmailAction(
          {
            action: "send",
            accountId: "protaige",
            to: "a@b.com",
            subject: "Hi",
            body: "Hello",
          },
          cfg,
        ),
      ).rejects.toThrow(/Gmail send is disabled/);
    });

    it("throws when get action is disabled", async () => {
      const cfg = makeCfg({ actions: { get: false } });

      await expect(
        handleGmailAction({ action: "get", accountId: "edubites", messageId: "msg1" }, cfg),
      ).rejects.toThrow(/Gmail get is disabled/);
    });

    it("throws when search action is disabled", async () => {
      const cfg = makeCfg({ actions: { search: false } });

      await expect(
        handleGmailAction({ action: "search", accountId: "edubites", query: "test" }, cfg),
      ).rejects.toThrow(/Gmail search is disabled/);
    });

    it("throws when draft action is disabled", async () => {
      const cfg = makeCfg({ actions: { draft: false } });

      await expect(
        handleGmailAction(
          {
            action: "draft",
            accountId: "zenloop",
            to: "a@b.com",
            subject: "Hi",
            body: "Hello",
          },
          cfg,
        ),
      ).rejects.toThrow(/Gmail draft is disabled/);
    });

    it("throws when triage action is disabled", async () => {
      const cfg = makeCfg({ actions: { triage: false } });

      await expect(
        handleGmailAction({ action: "triage", accountId: "edubites" }, cfg),
      ).rejects.toThrow(/Gmail triage is disabled/);
    });

    it("allows actions when not explicitly disabled", async () => {
      listGmailMessages.mockResolvedValueOnce([]);
      const cfg = makeCfg({ actions: { send: false } });

      const result = await handleGmailAction({ action: "read", accountId: "edubites" }, cfg);
      const payload = result.details as { ok: boolean };
      expect(payload.ok).toBe(true);
    });
  });

  describe("unknown action", () => {
    it("throws error with action name", async () => {
      const cfg = makeCfg();

      await expect(
        handleGmailAction({ action: "archive", accountId: "edubites" }, cfg),
      ).rejects.toThrow(/Unknown action: archive/);
    });
  });

  describe("account resolution", () => {
    it("uses default account when no accountId is provided", async () => {
      listGmailMessages.mockResolvedValueOnce([]);
      const cfg = makeCfg();

      await handleGmailAction({ action: "read" }, cfg);

      expect(listGmailMessages).toHaveBeenCalled();
    });

    it("resolves named account from config", async () => {
      listGmailMessages.mockResolvedValueOnce([]);
      const cfg = makeCfg({
        accounts: {
          edubites: { refreshToken: "edubites-token" },
          protaige: { refreshToken: "protaige-token" },
        },
      });

      await handleGmailAction({ action: "read", accountId: "edubites" }, cfg);

      const callArgs = listGmailMessages.mock.calls[0] as unknown[];
      expect(callArgs[0]).toBe("edubites");
    });
  });
});
