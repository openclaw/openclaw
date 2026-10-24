import { describe, expect, it, vi } from "vitest";
import { routeReplyDirectivesForTest as route } from "./get-reply-directives-routing.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

const renderedMentionPattern = "<@BOT> \\(Bek \\(Ops\\)\\)";

// Model the plugin-owned exact substitution fact at the loaded-plugin seam;
// routing must not import Slack internals.
vi.mock("../../channels/plugins/registry-loaded.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/registry-loaded.js")>()),
  getLoadedChannelPluginById: (id: string) =>
    id === "slack"
      ? {
          id: "slack",
          config: {},
          mentions: { stripPatterns: () => [renderedMentionPattern, "<@[^>\\s]+>"] },
        }
      : undefined,
}));

describe("sender-owned directive projection", () => {
  it.each([
    {
      name: "selects an inline shortcut after a rendered group mention",
      rawText: "<@BOT> (Bek (Ops)) Please /help continue",
      commandText: "Please /help continue",
      expected: "<@BOT> (Bek (Ops)) Please continue",
    },
    {
      name: "selects an inline shortcut when the rendered mention trails the text",
      rawText: "Please /help continue <@BOT> (Bek (Ops))",
      commandText: "Please /help continue",
      expected: "Please continue <@BOT> (Bek (Ops))",
    },
    {
      name: "selects an inline shortcut on a later line after a rendered mention",
      rawText: "<@BOT> (Bek (Ops)) Please summarize\n/help",
      commandText: "Please summarize /help",
      expected: "<@BOT> (Bek (Ops)) Please summarize\n",
    },
    {
      name: "selects an inline shortcut after mention rendering in a direct message",
      rawText: "<@BOT> (Bek (Ops)) Please /help continue",
      commandText: "Please /help continue",
      expected: "<@BOT> (Bek (Ops)) Please continue",
      isGroup: false,
    },
    {
      name: "keeps attachment context after a multiline sender shortcut",
      rawText: "<@BOT> (Bek (Ops)) Please /help\ncontinue\n[slack attachment unavailable]",
      commandSourceText: "<@BOT> (Bek (Ops)) Please /help\ncontinue",
      commandText: "Please /help continue",
      expected: "<@BOT> (Bek (Ops)) Please\ncontinue\n[slack attachment unavailable]",
    },
    {
      name: "rejects prepared metadata that does not reconstruct the command body",
      rawText: "unrelated sender text",
      commandSourceText: "<@BOT> (Bek (Ops)) different /help text",
      commandText: "Please /help continue",
      agentText: "[Forwarded message]\nPlease /help continue",
      expected: "[Forwarded message]\nPlease /help continue",
      rejected: true,
    },
  ])("$name", async (testCase) => {
    const { rawText, commandText, expected } = testCase;
    const isGroup = testCase.isGroup !== false;
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      ChatType: isGroup ? "channel" : "direct",
      CommandBody: commandText,
      RawBody: rawText,
      BodyForAgent: testCase.agentText ?? rawText,
      CommandAuthorized: true,
      WasMentioned: true,
      ChannelContext: { chat: { commandSourceText: testCase.commandSourceText ?? rawText } },
    });
    const result = await route(ctx, { isGroup });
    expect(result.inlineCommand).toBe(testCase.rejected ? undefined : "/help");
    expect(result.cleanedBody).toBe(expected);
  });

  const forwardedStatus = "Please summarize\n[Forwarded message]\n/status marker";
  const tail = "/think high\n  code()";
  it.each<[string, string, string, boolean, string?, string?, boolean?]>([
    ["preserves forwarded status beside a caption", "Please summarize", forwardedStatus, false],
    [
      "removes only sender status",
      "Please /status summarize",
      "Please /status summarize\n[Forwarded message]\n/status marker",
      true,
      forwardedStatus,
    ],
    [
      "preserves forwarded directives",
      "Please summarize",
      `Please summarize\n[Forwarded message]\n${tail}`,
      false,
    ],
    ["keeps an empty sender projection", "", "[Forwarded message]\n/status marker", false],
    [
      "preserves whitespace after repeated status",
      "Please /status summarize /status\n  code()",
      "Please /status summarize /status\n  code()",
      true,
      "Please summarize\n  code()",
    ],
    [
      "keeps flat history opaque",
      "hello",
      "[Chat messages since your last reply - for context]\nOther: /think high\n[Current message - respond to this]\nOwner: hello /status",
      false,
    ],
    ["does not resurrect a consumed reset", "new session", "", false, "", "new session", true],
    [
      "keeps normalized command tails",
      "/status",
      `/status:\n${tail}`,
      false,
      tail,
      `/status:\n${tail}`,
    ],
    [
      "keeps tails after leading blanks",
      "/status",
      `\n\n/status:\n${tail}`,
      false,
      tail,
      `\n\n/status:\n${tail}`,
    ],
  ])(
    "%s",
    async (
      _name,
      commandText,
      agentText,
      inlineStatus,
      expected = agentText,
      rawText = commandText,
      resetTriggered = false,
    ) => {
      const ctx = buildTestCtx({
        CommandBody: commandText,
        RawBody: rawText,
        BodyForAgent: agentText,
        CommandAuthorized: true,
      });
      const result = await route(ctx, { resetTriggered });
      expect(result.cleanedBody).toBe(expected);
      expect(result.inlineStatusRequested).toBe(inlineStatus);
      expect(result.directives.hasThinkDirective).toBe(false);
    },
  );

  it.each([
    { body: "/status", suppressed: false },
    { body: "/skill weather\n  first\n  second", suppressed: false },
    { body: "/reset\ninspect this", suppressed: false },
    { body: "/status", suppressed: true },
  ])(
    "keeps standalone command status out of attachment context: %j",
    async ({ body, suppressed }) => {
      const agentText = `[System receipt]\n\n${body}\n[media attached: media://inbound/voice.mp3]`;
      const ctx = buildTestCtx({
        CommandBody: body,
        RawBody: `${body}\n[media attached: media://inbound/voice.mp3]`,
        BodyForAgent: agentText,
        CommandAuthorized: !suppressed,
        CommandInterpretationSuppressed: suppressed,
      });
      const result = await route(ctx);
      expect(result.inlineStatusRequested).toBe(false);
      expect(result.cleanedBody).toBe(agentText);
    },
  );

  it.each([true, false])(
    "preserves reasoning authorization before clearing (authorized: %s)",
    async (authorized) => {
      const ctx = buildTestCtx({
        Body: "/reasoning on",
        CommandBody: "/reasoning on",
        CommandAuthorized: authorized,
      });
      const result = await route(ctx);
      expect(result.directives.hasReasoningDirective).toBe(authorized);
      expect((await result.resolveModelLevels()).resolvedReasoningLevel).toBe(
        authorized ? "on" : "off",
      );
    },
  );
});
