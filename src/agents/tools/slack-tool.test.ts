import { beforeEach, describe, expect, it, vi } from "vitest";
import type { callGatewayTool } from "./gateway.js";
import { createSlackTool } from "./slack-tool.js";

type GatewayCall = {
  method: string;
  opts: unknown;
  request: {
    channel: string;
    action: string;
    params: Record<string, unknown>;
    accountId?: string;
    idempotencyKey: string;
  };
};

const callGatewayMock = vi.fn();

const callGatewayStub: typeof callGatewayTool = async (method, opts, request) =>
  callGatewayMock({ method, opts, request }) as never;

function makeTool(): ReturnType<typeof createSlackTool> {
  return createSlackTool({
    callGatewayTool: callGatewayStub,
    randomId: () => "idem-test",
  });
}

function lastCall(): GatewayCall {
  const call = callGatewayMock.mock.calls.at(-1)?.[0] as GatewayCall | undefined;
  if (!call) {
    throw new Error("expected gateway call");
  }
  return call;
}

beforeEach(() => {
  callGatewayMock.mockReset();
  callGatewayMock.mockResolvedValue({ ok: true });
});

describe("slack tool bridge", () => {
  it("is not owner-only so harnesses can call it", () => {
    const tool = makeTool();
    expect(tool.ownerOnly).toBeFalsy();
    expect(tool.name).toBe("slack");
  });

  it("dispatches to message.action with the slack channel id", async () => {
    const tool = makeTool();
    await tool.execute("call-1", {
      action: "sendMessage",
      to: "channel:C123",
      content: "hi",
    });
    const call = lastCall();
    expect(call.method).toBe("message.action");
    expect(call.request.channel).toBe("slack");
    expect(call.request.idempotencyKey).toBe("idem-test");
  });

  it("forwards accountId only when supplied", async () => {
    const tool = makeTool();
    await tool.execute("call-default", {
      action: "sendMessage",
      to: "channel:C123",
      content: "hi",
    });
    expect(lastCall().request.accountId).toBeUndefined();

    await tool.execute("call-account", {
      action: "sendMessage",
      to: "channel:C123",
      content: "hi",
      accountId: "team-a",
    });
    expect(lastCall().request.accountId).toBe("team-a");
  });

  describe("action mapping", () => {
    it("maps react with optional remove", async () => {
      const tool = makeTool();
      await tool.execute("call", {
        action: "react",
        channelId: "C1",
        messageId: "1.0",
        emoji: "✅",
      });
      expect(lastCall().request).toMatchObject({
        action: "react",
        params: { channelId: "C1", messageId: "1.0", emoji: "✅" },
      });
      expect(lastCall().request.params).not.toHaveProperty("remove");

      await tool.execute("call-remove", {
        action: "react",
        channelId: "C1",
        messageId: "1.0",
        emoji: "✅",
        remove: true,
      });
      expect(lastCall().request.params).toMatchObject({ remove: true });
    });

    it("maps reactions list", async () => {
      const tool = makeTool();
      await tool.execute("call", {
        action: "reactions",
        channelId: "C1",
        messageId: "1.0",
        limit: 5,
      });
      expect(lastCall().request).toMatchObject({
        action: "reactions",
        params: { channelId: "C1", messageId: "1.0", limit: 5 },
      });
    });

    it("sendMessage prefers `to` over channelId and threads via threadTs", async () => {
      const tool = makeTool();
      await tool.execute("call", {
        action: "sendMessage",
        channelId: "C1",
        to: "user:U9",
        content: "hi",
        threadTs: "1.5",
      });
      expect(lastCall().request).toMatchObject({
        action: "send",
        params: { to: "user:U9", message: "hi", threadId: "1.5" },
      });
    });

    it("sendMessage falls back to channelId when `to` is omitted", async () => {
      const tool = makeTool();
      await tool.execute("call", {
        action: "sendMessage",
        channelId: "C1",
        content: "hi",
      });
      expect(lastCall().request.params).toMatchObject({ to: "C1" });
    });

    it("editMessage and deleteMessage map to edit/delete", async () => {
      const tool = makeTool();
      await tool.execute("c-edit", {
        action: "editMessage",
        channelId: "C1",
        messageId: "1.0",
        content: "fixed",
      });
      expect(lastCall().request).toMatchObject({
        action: "edit",
        params: { channelId: "C1", messageId: "1.0", message: "fixed" },
      });

      await tool.execute("c-del", {
        action: "deleteMessage",
        channelId: "C1",
        messageId: "1.0",
      });
      expect(lastCall().request).toMatchObject({
        action: "delete",
        params: { channelId: "C1", messageId: "1.0" },
      });
    });

    it("readMessages forwards window/threading params", async () => {
      const tool = makeTool();
      await tool.execute("call", {
        action: "readMessages",
        channelId: "C1",
        limit: 20,
        before: "1.9",
        after: "1.1",
        threadId: "1.5",
      });
      expect(lastCall().request).toMatchObject({
        action: "read",
        params: {
          channelId: "C1",
          limit: 20,
          before: "1.9",
          after: "1.1",
          threadId: "1.5",
        },
      });
    });

    it("pin / unpin / list-pins", async () => {
      const tool = makeTool();
      await tool.execute("c-pin", {
        action: "pinMessage",
        channelId: "C1",
        messageId: "1.0",
      });
      expect(lastCall().request).toMatchObject({
        action: "pin",
        params: { channelId: "C1", messageId: "1.0" },
      });

      await tool.execute("c-unpin", {
        action: "unpinMessage",
        channelId: "C1",
        messageId: "1.0",
      });
      expect(lastCall().request).toMatchObject({
        action: "unpin",
        params: { channelId: "C1", messageId: "1.0" },
      });

      await tool.execute("c-list", { action: "listPins", channelId: "C1" });
      expect(lastCall().request).toMatchObject({
        action: "list-pins",
        params: { channelId: "C1" },
      });
    });

    it("memberInfo + emojiList", async () => {
      const tool = makeTool();
      await tool.execute("c-mem", { action: "memberInfo", userId: "U1" });
      expect(lastCall().request).toMatchObject({
        action: "member-info",
        params: { userId: "U1" },
      });

      await tool.execute("c-emoji", { action: "emojiList", limit: 10 });
      expect(lastCall().request).toMatchObject({
        action: "emoji-list",
        params: { limit: 10 },
      });
    });

    it("uploadFile and downloadFile", async () => {
      const tool = makeTool();
      await tool.execute("c-up", {
        action: "uploadFile",
        to: "channel:C1",
        filePath: "/tmp/a.png",
        initialComment: "look",
        filename: "a.png",
        title: "A",
        threadTs: "1.5",
      });
      expect(lastCall().request).toMatchObject({
        action: "upload-file",
        params: {
          to: "channel:C1",
          filePath: "/tmp/a.png",
          initialComment: "look",
          filename: "a.png",
          title: "A",
          threadId: "1.5",
        },
      });

      await tool.execute("c-down", {
        action: "downloadFile",
        fileId: "F1",
        channelId: "C1",
        threadId: "1.5",
      });
      expect(lastCall().request).toMatchObject({
        action: "download-file",
        params: { fileId: "F1", channelId: "C1", threadId: "1.5" },
      });
    });

    it("createConversation maps to channel-create with optional isPrivate", async () => {
      const tool = makeTool();
      await tool.execute("c-cc", { action: "createConversation", name: "team-x" });
      expect(lastCall().request).toMatchObject({
        action: "channel-create",
        params: { name: "team-x" },
      });
      expect(lastCall().request.params).not.toHaveProperty("isPrivate");

      await tool.execute("c-cc-priv", {
        action: "createConversation",
        name: "team-y",
        isPrivate: true,
      });
      expect(lastCall().request.params).toMatchObject({ name: "team-y", isPrivate: true });
    });

    it("lookupUserByEmail maps to user-lookup-by-email", async () => {
      const tool = makeTool();
      await tool.execute("c-lu", {
        action: "lookupUserByEmail",
        email: "alice@example.com",
      });
      expect(lastCall().request).toMatchObject({
        action: "user-lookup-by-email",
        params: { email: "alice@example.com" },
      });
    });

    it("inviteUsers maps to addParticipant with channelId + userIds", async () => {
      const tool = makeTool();
      await tool.execute("c-inv", {
        action: "inviteUsers",
        channelId: "C1",
        userIds: ["U1", "U2"],
      });
      expect(lastCall().request).toMatchObject({
        action: "addParticipant",
        params: { channelId: "C1", userIds: ["U1", "U2"] },
      });
    });

    it("listMembers maps to member-list with optional cursor/limit", async () => {
      const tool = makeTool();
      await tool.execute("c-lm", {
        action: "listMembers",
        channelId: "C1",
        limit: 50,
        cursor: "next-1",
      });
      expect(lastCall().request).toMatchObject({
        action: "member-list",
        params: { channelId: "C1", limit: 50, cursor: "next-1" },
      });
    });
  });

  describe("validation", () => {
    it("rejects unknown action", async () => {
      const tool = makeTool();
      await expect(tool.execute("call", { action: "nope" })).rejects.toThrow(
        /Unknown slack action/,
      );
      expect(callGatewayMock).not.toHaveBeenCalled();
    });

    it("requires channelId/messageId for react", async () => {
      const tool = makeTool();
      await expect(tool.execute("call", { action: "react", emoji: "✅" })).rejects.toThrow(
        /channelId required/,
      );
      await expect(
        tool.execute("call", { action: "react", channelId: "C1", emoji: "✅" }),
      ).rejects.toThrow(/messageId required/);
    });

    it("sendMessage requires `to` or channelId", async () => {
      const tool = makeTool();
      await expect(tool.execute("call", { action: "sendMessage", content: "hi" })).rejects.toThrow(
        /to or channelId required/,
      );
    });

    it("uploadFile requires filePath and target", async () => {
      const tool = makeTool();
      await expect(
        tool.execute("call", { action: "uploadFile", to: "channel:C1" }),
      ).rejects.toThrow(/filePath/);
      await expect(
        tool.execute("call", { action: "uploadFile", filePath: "/tmp/a" }),
      ).rejects.toThrow(/to or channelId required/);
    });

    it("downloadFile requires fileId", async () => {
      const tool = makeTool();
      await expect(tool.execute("call", { action: "downloadFile" })).rejects.toThrow(/fileId/);
    });

    it("memberInfo requires userId", async () => {
      const tool = makeTool();
      await expect(tool.execute("call", { action: "memberInfo" })).rejects.toThrow(/userId/);
    });

    it("createConversation requires name", async () => {
      const tool = makeTool();
      await expect(tool.execute("call", { action: "createConversation" })).rejects.toThrow(/name/);
    });

    it("lookupUserByEmail requires email", async () => {
      const tool = makeTool();
      await expect(tool.execute("call", { action: "lookupUserByEmail" })).rejects.toThrow(/email/);
    });

    it("inviteUsers requires channelId and non-empty userIds", async () => {
      const tool = makeTool();
      await expect(
        tool.execute("call", { action: "inviteUsers", userIds: ["U1"] }),
      ).rejects.toThrow(/channelId required/);
      await expect(
        tool.execute("call", { action: "inviteUsers", channelId: "C1" }),
      ).rejects.toThrow(/userIds required/);
      await expect(
        tool.execute("call", { action: "inviteUsers", channelId: "C1", userIds: [] }),
      ).rejects.toThrow(/userIds required/);
    });

    it("listMembers requires channelId", async () => {
      const tool = makeTool();
      await expect(tool.execute("call", { action: "listMembers" })).rejects.toThrow(
        /channelId required/,
      );
    });
  });

  describe("description", () => {
    it("documents the bridge boundary and the admin opt-in", () => {
      const tool = makeTool();
      expect(tool.description).toContain("skills/slack/SKILL.md");
      expect(tool.description).toContain("channels.slack.actions.admin");
      expect(tool.description).toContain("apps.manifest.create");
    });
  });
});
