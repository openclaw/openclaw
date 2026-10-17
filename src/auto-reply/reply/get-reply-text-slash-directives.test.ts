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

afterEach(() => resetPluginRuntimeStateForTest());

async function resolveTextSlashDirective(
  body: string,
  options: {
    botUsername?: string;
    commandsText?: boolean;
    surface?: string;
    authorized?: boolean;
    admin?: boolean;
  } = {},
) {
  const storePath = path.join(tempDirs.make("openclaw-text-slash-directive-"), "sessions.json");
  const {
    surface = "webchat",
    authorized = true,
    botUsername,
    commandsText,
    admin = true,
  } = options;
  const sessionKey = `agent:main:${surface}:direct:user-1`;
  const ctx = buildTestCtx({
    Body: body,
    BodyForAgent: body,
    CommandBody: body,
    CommandSource: "text",
    CommandAuthorized: authorized,
    CommandTurn: {
      kind: "text-slash",
      source: "text",
      authorized,
      commandName: body.slice(1).split(/\s+/, 1)[0],
      body,
    },
    Provider: surface,
    Surface: surface,
    BotUsername: botUsername,
    GatewayClientScopes: admin ? ["operator.admin"] : [],
    SessionKey: sessionKey,
  });
  const sessionEntry = { sessionId: "session-1", updatedAt: 1 };
  await replaceSessionEntry({ sessionKey, storePath }, sessionEntry);
  const read = () => loadExactSessionEntry({ sessionKey, storePath })?.entry;
  const storedBefore = read();
  const result = await resolveReplyDirectives({
    ctx,
    cfg: markCompleteReplyConfig({
      session: { store: storePath },
      commands: commandsText === undefined ? undefined : { text: commandsText },
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
    commandAuthorized: authorized,
    defaultProvider: "openai",
    defaultModel: "gpt-5.5",
    aliasIndex: { byAlias: new Map(), byKey: new Map() },
    provider: "openai",
    model: "gpt-5.5",
    hasResolvedHeartbeatModelOverride: false,
    typing: createTypingController({}),
  });
  return { result, read, storedBefore };
}

function resolveAddressed(body: string) {
  return resolveTextSlashDirective(body, { botUsername: "openclaw" });
}

describe("text slash directive ownership", () => {
  it.each([
    "/model list -g Review this",
    "/model list@work --runtime codex -g Review this",
    "/model status -a -g Review this",
  ])("ignores mixed model information metadata: %s", async (body) => {
    for (const authorized of [true, false]) {
      const { result, read, storedBefore } = await resolveTextSlashDirective(body, {
        admin: false,
        authorized,
      });
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
      expect(read()).toEqual(storedBefore);
    }
  });

  it.each([
    [
      "  /exec@openclaw security=full ask=off\n",
      "Review  this:\n```python\n    print('a  b')\n```",
      { security: "full", ask: "off" },
    ],
    ["", "/unknown@openclaw explain  this\n    unchanged", undefined],
    ["/verbose@openclaw:\r\n", "    if ready:\n        run('a  b')  \n", undefined],
  ] as const)("preserves addressed task bytes after %s", async (prefix, task, execOverrides) => {
    const { result } = await resolveAddressed(`${prefix}${task}`);
    expect(result).toMatchObject({
      kind: "continue",
      result: { cleanedBody: task, ...(execOverrides ? { execOverrides } : {}) },
    });
  });

  it.each([
    ["/think: high", "\n", "thinkingLevel", { resolvedThinkLevel: "high" }],
    ["/fast on", " ", "fastMode", { resolvedFastMode: true, resolvedFastModeOverride: true }],
  ] as const)(
    "preserves a task after %s with separator %j",
    async (directive, separator, field, expected) => {
      const task = "Please inspect this code:\n```python\nif True:\n    print('a  b')\n```";
      const { result, read, storedBefore } = await resolveAddressed(
        `${directive}${separator}${task}`,
      );

      expect(result.kind).toBe("continue");
      if (result.kind !== "continue") {
        throw new Error("expected the directive task to continue");
      }
      const levels = await result.result.resolveModelLevels();
      expect({ ...result.result, ...levels }).toMatchObject({ cleanedBody: task, ...expected });
      expect(read()).toEqual(storedBefore);
      expect(read()).not.toHaveProperty(field);
    },
  );

  it("preserves addressed exec key/value arguments", async () => {
    const { result, read } = await resolveAddressed("/exec@openclaw: host=gateway");

    expect(result).toMatchObject({
      kind: "reply",
      reply: { text: expect.stringContaining("Exec defaults set (host=gateway).") },
    });
    expect(read()?.execHost).toBe("gateway");
  });

  it("rejects positional exec arguments addressed to the current bot", async () => {
    const { result } = await resolveAddressed("/exec@openclaw: gateway");

    expect(result).toMatchObject({
      kind: "reply",
      reply: { text: 'Unexpected argument "gateway" for /exec.' },
    });
  });

  it("applies all text directives separated by newlines", async () => {
    const { result, read } = await resolveTextSlashDirective("/verbose full\n/reasoning off");

    expect(result).toMatchObject({ kind: "reply" });
    expect(read()).toMatchObject({ verboseLevel: "full", reasoningLevel: "off" });
  });

  it("preserves text exec commands when text routing is disabled on a native surface", async () => {
    const body = "/exec host=gateway";
    const { result, read } = await resolveTextSlashDirective(body, {
      commandsText: false,
      surface: "discord",
    });

    expect(result).toMatchObject({ kind: "continue", result: { cleanedBody: body } });
    expect(read()?.execHost).toBeUndefined();
  });
});
