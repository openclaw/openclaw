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

describe("message-start command admission", () => {
  it.each([
    "Send /model to choose another model.",
    "Use /model openai/gpt-4o-mini for this example.",
    "Use /fixture for this example.",
    "Please /think high explain this.",
    "Please /fast on explain this.",
    "Please /verbose on explain this.",
    "Please /trace on explain this.",
    "Please /reasoning on explain this.",
    "Please /elevated on explain this.",
    "Please /exec security=deny ask=always explain this.",
    "Please /queue collect explain this.",
    "Please /status explain this.",
    "Please /help explain this.",
    "Please /commands explain this.",
    "Please /whoami explain this.",
    "Please /id explain this.",
    "> /model openai/gpt-4o-mini",
    '" /model openai/gpt-4o-mini"',
    "```text\n/model openai/gpt-4o-mini\n```",
    "First line\n/model openai/gpt-4o-mini",
  ])("keeps slash mentions as ordinary text: %j", async (body) => {
    const ctx = buildTestCtx({
      Body: body,
      CommandBody: body,
      CommandAuthorized: true,
    });
    const result = await route(ctx, {
      cfg: {
        commands: { text: true },
        agents: {
          defaults: {
            models: { "openai/gpt-4o-mini": { alias: "fixture" } },
            modelPolicy: { allow: ["openai/gpt-4o-mini", "tencent-tokenhub/hy-3d-retopology"] },
          },
        },
      },
      // The prose word "to" fuzzy-matches this visible synthetic catalog entry.
      preparedModelCatalog: {
        entries: [
          { provider: "tencent-tokenhub", id: "hy-3d-retopology", name: "Synthetic retopology" },
        ],
        routeVariants: [],
      },
    });
    expect(result.cleanedBody).toBe(body);
    expect(result.inlineCommand).toBeUndefined();
    expect(result.inlineStatusRequested).toBe(false);
    expect(result.directives).toMatchObject({
      cleaned: body,
      hasThinkDirective: false,
      hasFastDirective: false,
      hasVerboseDirective: false,
      hasTraceDirective: false,
      hasReasoningDirective: false,
      hasElevatedDirective: false,
      hasExecDirective: false,
      hasQueueDirective: false,
      hasModelDirective: false,
      hasStatusDirective: false,
    });
  });

  it.each([
    { body: "/model openai/gpt-4o-mini explain this", source: "text" as const },
    { body: " \n\t/fixture explain this", source: "text" as const },
    { body: "/model openai/gpt-4o-mini", source: "native" as const },
  ])("keeps explicit model selections supported: $body ($source)", async ({ body, source }) => {
    const result = await route(
      buildTestCtx({
        Body: body,
        CommandBody: body,
        CommandSource: source,
        CommandAuthorized: true,
      }),
      {
        cfg: {
          commands: { text: true },
          agents: { defaults: { models: { "openai/gpt-4o-mini": { alias: "fixture" } } } },
        },
      },
    );
    expect(result.directives).toMatchObject({
      hasModelDirective: true,
      rawModelDirective: body.includes("/fixture") ? "fixture" : "openai/gpt-4o-mini",
    });
    expect(result.cleanedBody.trim()).toBe(source === "native" ? "" : "explain this");
  });

  it.each([
    "<@BOT> (Bek (Ops)) /think high explain this",
    " \t/think high explain this <@BOT> (Bek (Ops))",
  ])("preserves group addressing around a leading directive: %j", async (body) => {
    const result = await route(
      buildTestCtx({
        Body: body,
        CommandBody: body,
        Provider: "slack",
        Surface: "slack",
        ChatType: "group",
        CommandAuthorized: true,
        WasMentioned: true,
      }),
    );
    expect(result.directives).toMatchObject({ hasThinkDirective: true, thinkLevel: "high" });
    expect(result.cleanedBody).toContain("explain this");
    expect(result.cleanedBody).not.toContain("/think");
  });

  it("keeps leading whitespace and chained directives with a task supported", async () => {
    const body =
      " \t/think high /fast on /verbose on /reasoning on /exec security=deny /queue collect explain this";
    const result = await route(
      buildTestCtx({ Body: body, CommandBody: body, CommandAuthorized: true }),
    );
    expect(result.cleanedBody.trim()).toBe("explain this");
    expect(result.directives).toMatchObject({
      hasThinkDirective: true,
      thinkLevel: "high",
      hasFastDirective: true,
      fastMode: true,
      hasVerboseDirective: true,
      verboseLevel: "on",
      hasReasoningDirective: true,
      reasoningLevel: "on",
      hasExecDirective: true,
      execSecurity: "deny",
      hasQueueDirective: true,
      queueMode: "collect",
    });
  });
});

describe("sender-owned directive projection", () => {
  it.each([
    {
      name: "selects an inline shortcut when the rendered mention trails the text",
      rawText: "/help Please continue <@BOT> (Bek (Ops))",
      commandText: "/help Please continue",
      expected: "Please continue <@BOT> (Bek (Ops))",
    },
    {
      name: "keeps direct-message attachment context after a multiline sender shortcut",
      rawText: "<@BOT> (Bek (Ops)) /help Please\ncontinue\n[slack attachment unavailable]",
      commandSourceText: "<@BOT> (Bek (Ops)) /help Please\ncontinue",
      commandText: "/help Please",
      expected: "<@BOT> (Bek (Ops)) Please\ncontinue\n[slack attachment unavailable]",
      isGroup: false,
    },
    {
      name: "rejects prepared metadata that does not reconstruct the command body",
      rawText: "unrelated sender text",
      commandSourceText: "<@BOT> (Bek (Ops)) different /help text",
      commandText: "/help Please continue",
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

  const tail = "/think high\n  code()";
  const prose =
    "Prüfe anschließend, ob das Modell über /model bzw. /models in Telegram auswählbar ist.";
  const forwardedStatus = `${prose}\n[Forwarded message]\n/status marker\n${tail}`;
  it.each<[string, string, string, boolean, string?, string?, boolean?]>([
    ["preserves model prose and forwarded status", prose, forwardedStatus, false],
    [
      "removes only sender status",
      `/status ${prose}`,
      `/status ${prose}\n[Forwarded message]\n/status marker\n${tail}`,
      true,
      forwardedStatus,
    ],
    ["keeps an empty sender projection", "", "[Forwarded message]\n/status marker", false],
    [
      "keeps flat history opaque",
      "hello",
      "[Chat messages since your last reply - for context]\nOther: /think high\n[Current message - respond to this]\nOwner: hello /status",
      false,
    ],
    ["does not resurrect a consumed reset", "new session", "", false, "", "new session", true],
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
      const result = await route(ctx, {
        resetTriggered,
        preparedModelCatalog: { entries: [], routeVariants: [] },
      });
      expect(result.cleanedBody).toBe(expected);
      expect(result.inlineStatusRequested).toBe(inlineStatus);
      expect(result.directives.hasThinkDirective).toBe(false);
      expect(result.directives.hasModelDirective).toBe(false);
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
