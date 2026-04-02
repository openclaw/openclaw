import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseInlineDirectives } from "./directive-handling.js";
import { normalizeInlineDirectivesForMessage } from "./get-reply-directives-utils.js";
import { prepareOneShotThinkText, resolveOneShotThinkLevel } from "./one-shot-think.js";
import { buildTestCtx } from "./test-ctx.js";

function buildParams(commandText: string) {
  const ctx = buildTestCtx({
    Body: commandText,
    RawBody: commandText,
    CommandBody: commandText,
    BodyForCommands: commandText,
    Provider: "discord",
    Surface: "discord",
    ChatType: "group",
    WasMentioned: true,
    CommandAuthorized: true,
  });
  return {
    commandText,
    ctx,
    cfg: {
      session: {},
      channels: {},
      agents: { defaults: {} },
      messages: {
        groupChat: {
          mentionPatterns: ["@bot"],
        },
      },
    },
    isGroup: true,
    agentId: "default",
    hasThinkDirective: true,
    thinkLevel: "high" as const,
  };
}

function resolveReplyDirectivesInSubprocess(params: { commandText: string; cfg?: object }): {
  kind: string;
  oneShotThinkLevel: string | undefined;
  hasThinkDirective: boolean | undefined;
  thinkLevel: string | undefined;
  hasStatusDirective: boolean | undefined;
  hasModelDirective: boolean | undefined;
  rawModelDirective: string | undefined;
  hasQueueDirective: boolean | undefined;
  queueMode: string | undefined;
  hasVerboseDirective: boolean | undefined;
  verboseLevel: string | undefined;
} {
  // `resolveReplyDirectives()` is safe in a plain Node+tsx process, but the Vitest worker
  // can hang importing that module directly in this suite. Keep one integration smoke here
  // so we still verify the helper is actually wired back into the real directive pipeline.
  const script = `
    import { buildTestCtx } from "./src/auto-reply/reply/test-ctx.ts";
    import { resolveReplyDirectives } from "./src/auto-reply/reply/get-reply-directives.ts";

    const commandText = ${JSON.stringify(params.commandText)};
    const sessionEntry = { sessionId: "session-id", updatedAt: Date.now() };
    const ctx = buildTestCtx({
      Body: commandText,
      RawBody: commandText,
      CommandBody: commandText,
      BodyForCommands: commandText,
      Provider: "discord",
      Surface: "discord",
      ChatType: "group",
      WasMentioned: true,
      CommandAuthorized: true,
    });
    const result = await resolveReplyDirectives({
      ctx,
      cfg: {
        session: {},
        channels: {},
        agents: { defaults: {} },
        messages: { groupChat: { mentionPatterns: ["@bot"] } },
        ...${JSON.stringify(params.cfg ?? {})},
      },
      agentId: "default",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      agentCfg: {},
      sessionCtx: {
        ...ctx,
        Body: commandText,
        BodyStripped: commandText,
        BodyForCommands: commandText,
        CommandBody: commandText,
      },
      sessionEntry,
      sessionStore: {},
      sessionKey: "session-key",
      sessionScope: "per-sender",
      groupResolution: undefined,
      isGroup: true,
      triggerBodyNormalized: commandText,
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
      aliasIndex: {},
      provider: "openai",
      model: "gpt-5.4",
      hasResolvedHeartbeatModelOverride: false,
      typing: { cleanup() {} },
    });
    if (result.kind !== "continue") {
      throw new Error("expected continue result");
    }
    console.log(JSON.stringify({
      kind: result.kind,
      oneShotThinkLevel: result.result.directives.oneShotThinkLevel,
      hasThinkDirective: result.result.directives.hasThinkDirective,
      thinkLevel: result.result.directives.thinkLevel,
      hasStatusDirective: result.result.directives.hasStatusDirective,
      hasModelDirective: result.result.directives.hasModelDirective,
      rawModelDirective: result.result.directives.rawModelDirective,
      hasQueueDirective: result.result.directives.hasQueueDirective,
      queueMode: result.result.directives.queueMode,
      hasVerboseDirective: result.result.directives.hasVerboseDirective,
      verboseLevel: result.result.directives.verboseLevel,
    }));
  `;

  return JSON.parse(
    execFileSync(process.execPath, ["--import", "tsx", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim(),
  ) as {
    kind: string;
    oneShotThinkLevel: string | undefined;
    hasThinkDirective: boolean | undefined;
    thinkLevel: string | undefined;
    hasStatusDirective: boolean | undefined;
    hasModelDirective: boolean | undefined;
    rawModelDirective: string | undefined;
    hasQueueDirective: boolean | undefined;
    queueMode: string | undefined;
    hasVerboseDirective: boolean | undefined;
    verboseLevel: string | undefined;
  };
}

describe("resolveOneShotThinkLevel", () => {
  it("preserves one-shot think level after stripping leading mentions", async () => {
    const params = buildParams("@bot /think high explain this");
    const result = resolveOneShotThinkLevel(params, prepareOneShotThinkText(params));
    expect(result).toBe("high");
  });

  it("preserves one-shot think level when mention stripping leaves punctuation", async () => {
    const params = buildParams("@bot, /think high explain this");
    const result = resolveOneShotThinkLevel(params, prepareOneShotThinkText(params));
    expect(result).toBe("high");
  });

  it("does not treat punctuation without a stripped mention as one-shot", async () => {
    const params = buildParams(", /think high explain this");
    const result = resolveOneShotThinkLevel(params, prepareOneShotThinkText(params));
    expect(result).toBeUndefined();
  });

  it("does not treat mid-text think mentions as one-shot", async () => {
    const params = buildParams("@bot compare /think high vs /think low");
    const result = resolveOneShotThinkLevel(params, prepareOneShotThinkText(params));
    expect(result).toBeUndefined();
  });

  it("wires one-shot think level back into resolveReplyDirectives", () => {
    const result = resolveReplyDirectivesInSubprocess({
      commandText: "@bot /think high explain this",
    });
    expect(result).toEqual({
      kind: "continue",
      oneShotThinkLevel: "high",
      hasThinkDirective: false,
      thinkLevel: undefined,
      hasStatusDirective: false,
      hasModelDirective: false,
      rawModelDirective: undefined,
      hasQueueDirective: false,
      queueMode: undefined,
      hasVerboseDirective: false,
      verboseLevel: undefined,
    });
  });

  it("preserves repeated directive-only model chains as directives", () => {
    const result = resolveReplyDirectivesInSubprocess({
      commandText: "/model openai/gpt-5.4 /model openai/gpt-5.4",
    });
    expect(result).toEqual({
      kind: "continue",
      oneShotThinkLevel: undefined,
      hasThinkDirective: false,
      thinkLevel: undefined,
      hasStatusDirective: false,
      hasModelDirective: true,
      rawModelDirective: "openai/gpt-5.4",
      hasQueueDirective: false,
      queueMode: undefined,
      hasVerboseDirective: false,
      verboseLevel: undefined,
    });
  });

  it("clears all directives for directive-only tails (invalid one-shot)", () => {
    const directives = parseInlineDirectives("/think high /status");

    // Invalid tail: no oneShotThinkLevel, so all directives are cleared (matching old behavior).
    const result = normalizeInlineDirectivesForMessage({
      directives,
      allowInlineStatus: true,
    });
    expect(result.hasThinkDirective).toBe(false);
    expect(result.thinkLevel).toBeUndefined();
    expect(result.oneShotThinkLevel).toBeUndefined();
    expect(result.hasStatusDirective).toBe(true);
  });

  it("clears all directives for slash-command tails (invalid one-shot)", () => {
    const directives = parseInlineDirectives("/think high /new");

    const result = normalizeInlineDirectivesForMessage({
      directives,
      allowInlineStatus: false,
    });
    expect(result.hasThinkDirective).toBe(false);
    expect(result.thinkLevel).toBeUndefined();
    expect(result.oneShotThinkLevel).toBeUndefined();
  });

  it("clears all directives for one-shot think, only attaches oneShotThinkLevel", () => {
    const directives = parseInlineDirectives(
      "/think high /model openai/gpt-5.4 /queue interrupt /verbose on explain this",
    );
    const result = normalizeInlineDirectivesForMessage({
      directives,
      allowInlineStatus: false,
      oneShotThinkLevel: "high",
    });
    // All directive flags cleared to prevent accidental session pollution;
    // only oneShotThinkLevel is attached.
    expect(result.oneShotThinkLevel).toBe("high");
    expect(result.hasThinkDirective).toBe(false);
    expect(result.hasVerboseDirective).toBe(false);
    expect(result.hasModelDirective).toBe(false);
    expect(result.hasQueueDirective).toBe(false);
  });
});
