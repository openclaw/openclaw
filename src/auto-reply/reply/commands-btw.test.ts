import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { runBtwSideQuestion } from "../../agents/btw.js";
import { resolveMessageActionTurnCapability } from "../../gateway/message-action-turn-capability.js";
import { expectObjectFields, mockFirstObjectArg } from "../../test-utils/mock-call-assertions.js";
import { resolveAgentDirMock } from "./commands-agent-scope.test-support.js";
import { buildCommandTestParams } from "./commands.test-harness.js";
import { createMockTypingController } from "./test-helpers.js";

const runBtwSideQuestionMock = vi.hoisted(() => vi.fn<typeof runBtwSideQuestion>());

// mock-isolation: Capture the side-question request without starting a model turn.
vi.mock("../../agents/btw.js", () => ({
  runBtwSideQuestion: runBtwSideQuestionMock,
}));

const { handleBtwCommand } = await import("./commands-btw.js");

const session = (sessionId = "session-1") => ({ sessionId, updatedAt: Date.now() });
function buildParams(commandBody = "/btw what changed?") {
  const cfg = { commands: { text: true }, channels: { whatsapp: { allowFrom: ["*"] } } };
  return buildCommandTestParams(commandBody, cfg, undefined, { workspaceDir: "/tmp/workspace" });
}
function activeParams(commandBody?: string): ReturnType<typeof buildParams> {
  return { ...buildParams(commandBody), agentDir: "/tmp/agent", sessionEntry: session() };
}
const run = (params: ReturnType<typeof buildParams>) => handleBtwCommand(params, true);
const runnerArgs = () => mockFirstObjectArg(runBtwSideQuestionMock);
function expectReply(result: Awaited<ReturnType<typeof run>>, text: string, question?: string) {
  expect(result).toEqual({
    shouldContinue: false,
    reply: { text, ...(question ? { btw: { question } } : {}) },
  });
}

describe("handleBtwCommand", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    runBtwSideQuestionMock.mockReset();
    resolveAgentDirMock.mockReset();
    resolveAgentDirMock.mockImplementation(
      (_cfg: unknown, agentId: string) => `/tmp/workspace/.openclaw/agents/${agentId}/agent`,
    );
  });

  it("returns usage when the side question is missing", async () => {
    expectReply(await run(buildParams("/btw")), "Usage: /btw [side question]");
  });

  it("ignores /btw when text commands are disabled", async () => {
    const result = await handleBtwCommand(buildParams(), false);
    expect(result).toBeNull();
    expect(runBtwSideQuestionMock).not.toHaveBeenCalled();
  });

  it("requires an active session context", async () => {
    const params = buildParams();
    params.sessionEntry = undefined;
    expectReply(await run(params), "⚠️ /btw requires an active session with existing context.");
  });

  it("returns an actionable visible error before running a restricted side question", async () => {
    const params = activeParams();
    params.ctx.ConversationToolPolicy = { deny: ["exec"] };
    expect(await run(params)).toEqual({
      shouldContinue: false,
      reply: {
        text: "⚠️ /btw cannot enforce this conversation's tool policy. Ask in the main conversation or switch this session to the embedded runtime.",
        btw: { question: "what changed?" },
        isError: true,
      },
    });
    expect(runBtwSideQuestionMock).not.toHaveBeenCalled();
  });

  it.each(["image", "described image"] as const)(
    "forwards current undescribed images: %s",
    async (attachment) => {
      const params = buildParams("/btw describe this");
      params.sessionEntry = session();
      const dir = tempDirs.make("openclaw-btw-images-");
      const data =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
      const file = path.join(dir, "photo.png");
      await writeFile(file, Buffer.from(data, "base64"));
      params.ctx.media = [
        { path: file, contentType: "image/png", kind: "image", workspaceDir: dir },
      ];
      if (attachment === "described image") {
        params.ctx.Body = "[Image]\nDescription:\na tiny dot image";
        params.ctx.MediaUnderstanding = [
          {
            kind: "image.description",
            attachmentIndex: 0,
            provider: "test",
            model: "test",
            text: "a tiny dot image",
          },
        ];
      }
      await run(params);
      const args = runnerArgs();
      expect(args.question).toBe("describe this");
      expect(args.images).toEqual(
        attachment === "image" ? [{ type: "image", data, mimeType: "image/png" }] : undefined,
      );
    },
  );

  it("delegates to the side-question runner", async () => {
    const params = activeParams();
    const typing = createMockTypingController();
    params.typing = typing;
    params.command.senderId = "sender-1";
    params.command.senderIsOwner = true;
    params.ctx.AccountId = "account-1";
    params.ctx.RuntimePolicySessionKey = "agent:main:runtime-policy";
    params.ctx.GroupChannel = "#ops";
    params.ctx.GroupSpace = "workspace-1";
    params.ctx.SenderId = "sender-1";
    params.ctx.SenderName = "Rosita";
    params.ctx.SenderUsername = "rosita";
    params.ctx.SenderE164 = "+15550001";
    params.ctx.MessageThreadId = "thread-1";
    params.sessionEntry = {
      ...session(),
      groupId: "group-1",
      parentSessionKey: "agent:main:parent",
    };
    let resolvedTurnContext: ReturnType<typeof resolveMessageActionTurnCapability> | undefined;
    runBtwSideQuestionMock.mockImplementation(async (input) => {
      resolvedTurnContext = resolveMessageActionTurnCapability({
        token: input.messageActionTurnCapability,
        agentId: "main",
        runId: input.authorityRunId,
        sessionKey: "agent:main:runtime-policy",
        sessionId: "session-1",
      });
      return { text: "nothing important" };
    });
    const result = await run(params);
    const args = runnerArgs();
    expect(typing.startTypingLoop).toHaveBeenCalledTimes(1);
    expect(args).toMatchObject({
      question: "what changed?",
      agentId: params.agentId,
      agentDir: params.agentDir,
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "off",
      messageChannel: "whatsapp",
      messageProvider: "whatsapp",
      agentAccountId: "account-1",
      messageThreadId: "thread-1",
      sandboxSessionKey: "agent:main:runtime-policy",
      groupId: "group-1",
      groupChannel: "#ops",
      groupSpace: "workspace-1",
      spawnedBy: "agent:main:parent",
      senderIsOwner: true,
      senderId: "sender-1",
      senderName: "Rosita",
      senderUsername: "rosita",
      senderE164: "+15550001",
      messageActionTurnCapability: expect.any(String),
      authorityRunId: expect.any(String),
      opts: { runId: expect.any(String) },
    });
    expect(args.sessionEntry).toEqual(params.sessionEntry);
    expect(resolveAgentDirMock).not.toHaveBeenCalled();
    expect(args.authorityRunId).not.toBe((args.opts as { runId?: string } | undefined)?.runId);
    expect(resolvedTurnContext).toMatchObject({
      requesterAccountId: "account-1",
      requesterSenderId: "sender-1",
      toolContext: { currentChannelProvider: "whatsapp" },
    });
    expectReply(result, "nothing important", "what changed?");
  });

  it("uses the originating target before the command transport target", async () => {
    const params = activeParams();
    params.ctx.OriginatingTo = "channel:source";
    params.ctx.NativeChannelId = "native:source";
    params.ctx.ChatType = "channel";
    params.command.to = "slash:transport";
    runBtwSideQuestionMock.mockResolvedValue({ text: "source target" });
    await run(params);
    expectObjectFields(runnerArgs(), {
      chatId: "native:source",
      chatType: "channel",
      messageTo: "channel:source",
      currentChannelId: "native:source",
    });
  });

  it("does not mint current-turn context for Gateway chat with an explicit origin", async () => {
    const params = activeParams();
    params.ctx.Provider = "webchat";
    params.ctx.OriginatingChannel = "matrix";
    params.ctx.OriginatingTo = "!room:example.org";
    params.command.channel = "matrix";
    params.command.to = "!room:example.org";
    runBtwSideQuestionMock.mockResolvedValue({ text: "origin answer" });
    await run(params);
    expect(runnerArgs().messageActionTurnCapability).toBeUndefined();
  });

  it("prefers the target session entry for side-question context", async () => {
    const params = buildParams();
    params.sessionKey = "agent:worker-1:whatsapp:direct:12345";
    params.sessionEntry = session("wrapper-session");
    params.sessionStore = {
      "agent:worker-1:whatsapp:direct:12345": session("target-session"),
    };
    runBtwSideQuestionMock.mockResolvedValue({ text: "target context" });
    const result = await run(params);
    expectObjectFields(runnerArgs().sessionEntry, { sessionId: "target-session" });
    expectReply(result, "target context", "what changed?");
  });

  it.each([
    [
      "/btw why does this fail?\nError: ENOSPC\n  at write",
      "why does this fail?\nError: ENOSPC\n  at write",
    ],
    ["/btw\nwhy does this fail?", "why does this fail?"],
    ["/side first\n\nsecond", "first\n\nsecond"],
  ])(
    "passes every line of a multi-line side question to the runner: %s",
    async (body, question) => {
      runBtwSideQuestionMock.mockResolvedValue({ text: "answer" });
      const params = activeParams(body);

      const result = await run(params);

      expect(runnerArgs().question).toBe(question);
      expectReply(result, "answer", question);
    },
  );
});
