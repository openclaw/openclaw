import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import { prepareReplyConversation } from "./prompt-session-context.js";
import { buildTestCtx } from "./test-ctx.js";
import { createTypingController } from "./typing.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        plugin: createChannelTestPluginBase({
          id: "discord",
          capabilities: { nativeCommands: true, chatTypes: ["direct"] },
        }),
        source: "test",
      },
    ]),
  );
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

async function resolveTextSlashDirective(
  body: string,
  options?: {
    botUsername?: string;
    commandsText?: boolean;
    surface?: string;
    authorized?: boolean;
    admin?: boolean;
  },
) {
  const storePath = path.join(tempDirs.make("openclaw-text-slash-directive-"), "sessions.json");
  const surface = options?.surface ?? "webchat";
  const sessionKey = `agent:main:${surface}:direct:user-1`;
  const ctx = buildTestCtx({
    Body: body,
    BodyForAgent: body,
    CommandBody: body,
    CommandSource: "text",
    CommandAuthorized: options?.authorized ?? true,
    CommandTurn: {
      kind: "text-slash",
      source: "text",
      authorized: options?.authorized ?? true,
      commandName: body.slice(1).split(/\s+/, 1)[0],
      body,
    },
    Provider: surface,
    Surface: surface,
    BotUsername: options?.botUsername,
    GatewayClientScopes: options?.admin === false ? [] : ["operator.admin"],
    SessionKey: sessionKey,
  });
  const sessionEntry = { sessionId: "session-1", updatedAt: 1 };
  await replaceSessionEntry({ sessionKey, storePath }, sessionEntry);
  const storedBefore = loadExactSessionEntry({ sessionKey, storePath })?.entry;
  const result = await resolveReplyDirectives({
    ctx,
    cfg: markCompleteReplyConfig({
      session: { store: storePath },
      commands: options?.commandsText === undefined ? undefined : { text: options.commandsText },
    }),
    agentId: "main",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    agentCfg: {},
    sessionCtx: ctx,
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
    sessionKey,
    storePath,
    sessionScope: "per-sender",
    conversation: prepareReplyConversation({ ctx, sessionEntry }),
    isGroup: false,
    triggerBodyNormalized: body,
    resetTriggered: false,
    commandAuthorized: options?.authorized ?? true,
    defaultProvider: "openai",
    defaultModel: "gpt-5.5",
    aliasIndex: { byAlias: new Map(), byKey: new Map() },
    provider: "openai",
    model: "gpt-5.5",
    hasResolvedTurnModelOverride: false,
    typing: createTypingController({}),
  });
  return { result, sessionKey, storePath, storedBefore };
}

describe("text slash directive ownership", () => {
  it.each([
    "/model list -g Review this",
    "/model list@work --runtime codex -g Review this",
    "/model status -a -g Review this",
  ])("ignores mixed model information metadata: %s", async (body) => {
    for (const authorized of [true, false]) {
      const { result, sessionKey, storePath, storedBefore } = await resolveTextSlashDirective(
        body,
        {
          admin: false,
          authorized,
        },
      );
      expect(result).toMatchObject({
        kind: "continue",
        result: {
          cleanedBody: expect.stringContaining("Review this"),
          directives: {
            hasModelDirective: false,
            rawModelDirective: undefined,
            rawModelProfile: undefined,
            rawModelRuntime: undefined,
            modelDirectiveSource: undefined,
            modelScope: undefined,
            modelScopeConflict: false,
          },
        },
      });
      expect(loadExactSessionEntry({ sessionKey, storePath })?.entry).toEqual(storedBefore);
    }
  });

  it("keeps an indented addressed exec task with its per-turn policy", async () => {
    const task = "Review  this:\n```python\n    print('a  b')\n```";
    const { result } = await resolveTextSlashDirective(
      `  /exec@openclaw security=full ask=off\n${task}`,
      {
        botUsername: "openclaw",
      },
    );

    expect(result).toMatchObject({
      kind: "continue",
      result: { cleanedBody: task, execOverrides: { security: "full", ask: "off" } },
    });
  });

  it("preserves unknown addressed command text for the model", async () => {
    const body = "/unknown@openclaw explain  this\n    unchanged";
    const { result } = await resolveTextSlashDirective(body, { botUsername: "openclaw" });

    expect(result).toMatchObject({ kind: "continue", result: { cleanedBody: body } });
  });

  it.each([
    ["/think: high", "\n", "thinkingLevel", { resolvedThinkLevel: "high" }],
    ["/fast on", " ", "fastMode", { resolvedFastMode: true, resolvedFastModeOverride: true }],
  ] as const)(
    "preserves a task after %s with separator %j",
    async (directive, separator, field, expected) => {
      const task = "Please inspect this code:\n```python\nif True:\n    print('a  b')\n```";
      const { result, sessionKey, storePath, storedBefore } = await resolveTextSlashDirective(
        `${directive}${separator}${task}`,
        { botUsername: "openclaw" },
      );

      expect(result.kind).toBe("continue");
      if (result.kind !== "continue") {
        throw new Error("expected the directive task to continue");
      }
      const levels = await result.result.resolveModelLevels();
      expect({ ...result.result, ...levels }).toMatchObject({
        cleanedBody: task,
        ...expected,
      });
      expect(loadExactSessionEntry({ sessionKey, storePath })?.entry).toEqual(storedBefore);
      expect(loadExactSessionEntry({ sessionKey, storePath })?.entry).not.toHaveProperty(field);
    },
  );

  it("preserves addressed exec key/value arguments", async () => {
    const { result, sessionKey, storePath } = await resolveTextSlashDirective(
      "/exec@openclaw: host=gateway",
      {
        botUsername: "openclaw",
      },
    );

    expect(result).toMatchObject({
      kind: "reply",
      reply: { text: expect.stringContaining("Exec defaults set (host=gateway).") },
    });
    expect(loadExactSessionEntry({ sessionKey, storePath })?.entry.execHost).toBe("gateway");
  });

  it("rejects positional exec arguments addressed to the current bot", async () => {
    const { result } = await resolveTextSlashDirective("/exec@openclaw: gateway", {
      botUsername: "openclaw",
    });

    expect(result).toMatchObject({
      kind: "reply",
      reply: { text: 'Unexpected argument "gateway" for /exec.' },
    });
  });

  it("applies all text directives separated by newlines", async () => {
    const { result, sessionKey, storePath } = await resolveTextSlashDirective(
      "/verbose full\n/reasoning off",
    );

    expect(result).toMatchObject({ kind: "reply" });
    expect(loadExactSessionEntry({ sessionKey, storePath })?.entry).toMatchObject({
      verboseLevel: "full",
      reasoningLevel: "off",
    });
  });

  it("preserves task whitespace after addressed verbose directive", async () => {
    const task = "    if ready:\n        run('a  b')  \n";
    const { result } = await resolveTextSlashDirective(`/verbose@openclaw:\r\n${task}`, {
      botUsername: "openclaw",
    });

    expect(result).toMatchObject({ kind: "continue", result: { cleanedBody: task } });
  });

  it("preserves text exec commands when text routing is disabled on a native surface", async () => {
    const body = "/exec host=gateway";
    const { result, sessionKey, storePath } = await resolveTextSlashDirective(body, {
      commandsText: false,
      surface: "discord",
    });

    expect(result).toMatchObject({ kind: "continue", result: { cleanedBody: body } });
    expect(loadExactSessionEntry({ sessionKey, storePath })?.entry.execHost).toBeUndefined();
  });
});
