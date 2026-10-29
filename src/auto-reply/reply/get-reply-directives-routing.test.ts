import { describe, expect, it, vi } from "vitest";
import { buildModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
      name: "selects an inline shortcut when the rendered mention trails the text",
      rawText: "Please /help continue <@BOT> (Bek (Ops))",
      commandText: "Please /help continue",
      expected: "Please continue <@BOT> (Bek (Ops))",
    },
    {
      name: "keeps direct-message attachment context after a multiline sender shortcut",
      rawText: "<@BOT> (Bek (Ops)) Please /help\ncontinue\n[slack attachment unavailable]",
      commandSourceText: "<@BOT> (Bek (Ops)) Please /help\ncontinue",
      commandText: "Please /help continue",
      expected: "<@BOT> (Bek (Ops)) Please\ncontinue\n[slack attachment unavailable]",
      isGroup: false,
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

  const tail = "/think high\n  code()";
  const forwardedStatus = `Please summarize\n[Forwarded message]\n/status marker\n${tail}`;
  it.each<[string, string, string, boolean, string?, string?, boolean?]>([
    ["preserves forwarded status beside a caption", "Please summarize", forwardedStatus, false],
    [
      "removes only sender status",
      "Please /status summarize",
      `Please /status summarize\n[Forwarded message]\n/status marker\n${tail}`,
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

describe("model references in ordinary text", () => {
  const german =
    "Prüfe anschließend, ob das Modell über /model bzw. /models in Telegram auswählbar ist.";
  const entries = [
    { provider: "openai", id: "safe", name: "Safe" },
    { provider: "fixture-route", id: "reasoner-42", name: "Reasoner" },
    { provider: "fixture-route", id: "blocked-42", name: "Blocked" },
  ];
  const cfg: OpenClawConfig = {
    commands: { text: true },
    agents: {
      defaults: {
        model: "openai/safe",
        models: { "fixture-route/reasoner-42": { alias: "chosen" } },
        modelPolicy: { allow: ["openai/safe", "fixture-route/reasoner-42"] },
      },
    },
  };
  it.each([
    { body: german, expected: german, model: false },
    { body: german, expected: german, model: false, unrestricted: true },
    {
      body: `${german} /elevated full /exec security=full`,
      expected: german,
      model: false,
      isGroup: true,
    },
    { body: `${german} /queue collect`, expected: german, model: false, queue: true },
    { body: "Explain /model reasoner-42 today", expected: "Explain today", model: true },
    { body: "Explain /model reasonr-42 today", expected: "Explain today", model: true },
    { body: "Explain /model chosen today", expected: "Explain today", model: true },
    { body: "Explain /chosen today", expected: "Explain today", model: true },
    {
      body: "Explain /model reasoner-42 /queue collect today",
      expected: "Explain today",
      model: true,
      queue: true,
    },
    { body: "Explain /model blocked-42 today", expected: "Explain today", model: true },
    { body: "Explain /model: unknown today", expected: "Explain today", model: true },
    { body: "Explain /model 123 today", expected: "Explain today", model: true },
    { body: "Explain /model other/unknown today", expected: "Explain today", model: true },
    { body: 'Explain /model "unknown" today', expected: "Explain today", model: true },
    { body: "Explain /model unknown@profile today", expected: "Explain today", model: true },
    {
      body: "Explain /model unknown --runtime openclaw today",
      expected: "Explain today",
      model: true,
    },
    { body: "Explain /model unknown --session today", expected: "Explain today", model: true },
    { body: "Explain /model default today", expected: "Explain today", model: true },
    { body: "/model unknown", expected: "", model: true },
    { body: "/model unknown /queue collect", expected: "", model: true, queue: true },
  ])("routes $body without changing explicit selection semantics", async (testCase) => {
    const history = `\n[Forwarded message]\n${testCase.body}`;
    const ctx = buildTestCtx({
      CommandBody: testCase.body,
      RawBody: testCase.body,
      BodyForAgent: `${testCase.body}${history}`,
      ChatType: testCase.isGroup ? "group" : "direct",
      WasMentioned: false,
      CommandAuthorized: true,
    });
    const result = await route(ctx, {
      cfg: testCase.unrestricted
        ? { ...cfg, agents: { defaults: { ...cfg.agents?.defaults, modelPolicy: { allow: [] } } } }
        : cfg,
      defaultModel: "safe",
      model: "safe",
      aliasIndex: buildModelAliasIndex({ cfg, defaultProvider: "openai" }),
      preparedModelCatalog: { entries, routeVariants: entries },
    });
    expect(result.directives.hasModelDirective).toBe(testCase.model);
    expect(result.directives.hasQueueDirective).toBe(testCase.queue ?? false);
    expect(result.directives.hasElevatedDirective).toBe(false);
    expect(result.directives.hasExecDirective).toBe(false);
    expect(result.cleanedBody).toBe(`${testCase.expected}${history}`.trimStart());
  });
});
