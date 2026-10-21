import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
    native?: boolean;
    authorized?: boolean;
    admin?: boolean;
  } = {},
) {
  const { native = false, authorized = true, admin = true } = options;
  const surface = native ? "discord" : "webchat";
  const storePath = path.join(tempDirs.make("openclaw-text-slash-directive-"), "sessions.json");
  const sessionKey = `agent:main:${surface}:direct:user-1`;
  const ctx = buildTestCtx({
    Body: body,
    CommandBody: body,
    CommandAuthorized: authorized,
    Provider: surface,
    Surface: surface,
    BotUsername: "openclaw",
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
      commands: native ? { text: false } : undefined,
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

const codeTask = "Please inspect this code:\n```python\nif True:\n    print('a  b')\n```";
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
    { execOverrides: { security: "full", ask: "off" } },
    undefined,
  ],
  ["", "/unknown@openclaw explain  this\n    unchanged", {}, undefined],
  ["/verbose@openclaw:\r\n", "    if ready:\n        run('a  b')  \n", {}, undefined],
  ["/think: high\n", codeTask, { resolvedThinkLevel: "high" }, "thinkingLevel"],
  ["/fast on ", codeTask, { resolvedFastMode: true, resolvedFastModeOverride: true }, "fastMode"],
] as const)("preserves addressed task bytes after %s", async (prefix, task, expected, field) => {
  const { result, read, storedBefore } = await resolveTextSlashDirective(`${prefix}${task}`);
  assert(result.kind === "continue", "expected the directive task to continue");
  const levels = field ? await result.result.resolveModelLevels() : {};
  expect({ ...result.result, ...levels }).toMatchObject({ cleanedBody: task, ...expected });
  if (field) {
    expect(read()).toEqual(storedBefore);
    expect(read()).not.toHaveProperty(field);
  }
});

it.each([
  ["host=gateway", expect.stringContaining("Exec defaults set (host=gateway)."), "gateway"],
  ["gateway", 'Unexpected argument "gateway" for /exec.', undefined],
] as const)("validates addressed exec arguments: %s", async (args, text, host) => {
  const { result, read } = await resolveTextSlashDirective(`/exec@openclaw: ${args}`);
  expect(result).toMatchObject({ kind: "reply", reply: { text } });
  if (host) {
    expect(read()?.execHost).toBe(host);
  }
});

it("applies all text directives separated by newlines", async () => {
  const { result, read } = await resolveTextSlashDirective("/verbose full\n/reasoning off");
  expect(result).toMatchObject({ kind: "reply" });
  expect(read()).toMatchObject({ verboseLevel: "full", reasoningLevel: "off" });
});

it("preserves text exec commands when text routing is disabled on a native surface", async () => {
  const body = "/exec host=gateway";
  const { result, read } = await resolveTextSlashDirective(body, { native: true });
  expect(result).toMatchObject({ kind: "continue", result: { cleanedBody: body } });
  expect(read()?.execHost).toBeUndefined();
});
