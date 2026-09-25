// Shares the dispatch entrypoint's existing mocked module graph and setup.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  createDispatcher,
  emptyConfig,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  dispatchReplyFromConfig,
  setNoAbort,
  firstFinalReplyPayload,
  globalBeforeAll0,
  describe2BeforeEach0,
} from "./dispatch-from-config.test-harness.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

describe("model inheritance for source delivery defaults", () => {
  beforeEach(describe2BeforeEach0);

  it("honors parent model overrides before Codex direct source delivery defaults", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { visibleReplies: "message_tool" },
      supports: (ctx) =>
        ctx.provider === "codex"
          ? { supported: true, priority: 100 }
          : { supported: false, reason: "codex provider only" },
      runAttempt: vi.fn(async () => ({}) as never),
    });
    const parentSessionKey = "agent:main:telegram:direct:U1";
    const childSessionKey = `${parentSessionKey}:thread:topic-1`;
    sessionStoreMocks.currentEntry = {
      sessionId: "child",
      updatedAt: 0,
      agentHarnessId: "codex",
      parentSessionKey,
      sendPolicy: "allow",
    };
    const parentEntry = {
      sessionId: "parent",
      updatedAt: 0,
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4.6",
    };
    // Scope the parent-key override to this test; the describe's beforeEach does
    // not reset loadSessionStoreEntry, so leaving it in place would resolve a
    // stale "parent" sessionId for a sibling reusing this session key.
    const defaultLoadSessionStoreEntry = () => sessionStoreMocks.currentEntry;
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation(((params: unknown) =>
      (params as { sessionKey?: string }).sessionKey === parentSessionKey
        ? parentEntry
        : sessionStoreMocks.currentEntry) as () => Record<string, unknown> | undefined);
    sessionStoreMocks.loadSessionStoreEntry.mockClear();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "visible parent-model reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        ModelParentSessionKey: parentSessionKey,
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: childSessionKey,
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(sessionStoreMocks.loadSessionStore).not.toHaveBeenCalled();
    expect(sessionStoreMocks.loadSessionStoreEntry).toHaveBeenCalledWith({
      agentId: "main",
      storePath: "/tmp/mock-sessions.json",
      sessionKey: parentSessionKey,
      readConsistency: "latest",
      clone: false,
    });
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("visible parent-model reply");
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation(defaultLoadSessionStoreEntry);
  });

  it("does not derive a flat DM model override when a Telegram topic suppresses inheritance", async () => {
    setNoAbort();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      deliveryDefaults: { visibleReplies: "message_tool" },
      supports: (ctx) =>
        ctx.provider === "codex"
          ? { supported: true, priority: 100 }
          : { supported: false, reason: "codex provider only" },
      runAttempt: vi.fn(async () => ({}) as never),
    });
    const parentSessionKey = "agent:main:main";
    const childSessionKey = `${parentSessionKey}:thread:12345:99`;
    sessionStoreMocks.currentEntry = {
      sessionId: "child",
      updatedAt: 0,
      agentHarnessId: "codex",
      sendPolicy: "allow",
    };
    const parentEntry = {
      sessionId: "parent",
      updatedAt: 0,
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4.6",
    };
    const defaultLoadSessionStoreEntry = () => sessionStoreMocks.currentEntry;
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation(((params: unknown) =>
      (params as { sessionKey?: string }).sessionKey === parentSessionKey
        ? parentEntry
        : sessionStoreMocks.currentEntry) as () => Record<string, unknown> | undefined);
    sessionStoreMocks.loadSessionStoreEntry.mockClear();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.sourceReplyDeliveryMode).toBe("automatic");
      return { text: "topic reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        ChatType: "direct",
        CommandSource: undefined,
        ModelParentSessionKey: null,
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: childSessionKey,
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(sessionStoreMocks.loadSessionStoreEntry).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: parentSessionKey }),
    );
    expect(result.queuedFinal).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.text).toBe("topic reply");
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation(defaultLoadSessionStoreEntry);
  });
});
