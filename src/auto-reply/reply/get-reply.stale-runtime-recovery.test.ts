import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logVerbose } from "../../globals.js";
import type { HookRunner } from "../../plugins/hooks.js";
import {
  buildGetReplyGroupCtx,
  buildNativeResetContext,
  createGetReplyContinueDirectivesResult,
  createGetReplySessionState,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
  applyResetModelOverride: vi.fn(),
  emitResetCommandHooks: vi.fn(),
  stageSandboxMedia: vi.fn(),
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runBeforeAgentReply: vi.fn<HookRunner["runBeforeAgentReply"]>(),
  getGlobalHookRunner: vi.fn(),
  resolveOriginMessageProvider: vi.fn(),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("./commands-core.js", () => ({
  emitResetCommandHooks: (...args: unknown[]) => mocks.emitResetCommandHooks(...args),
}));

vi.mock("./origin-routing.js", () => ({
  resolveOriginMessageProvider: (...args: unknown[]) => mocks.resolveOriginMessageProvider(...args),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: (...args: unknown[]) => mocks.getGlobalHookRunner(...args),
}));

// The shared `get-reply.test-mocks.js` (loaded transitively via
// `get-reply.test-runtime-mocks.js`) registers default mocks for the runtime
// modules below that resolve to no-op promises. We override those defaults
// here at module load via `vi.doMock` (runtime-registered, "last wins") so
// the rejection paths exercised in this suite reach our hoisted handles.
vi.doMock("./session-reset-model.runtime.js", () => ({
  applyResetModelOverride: (...args: unknown[]) => mocks.applyResetModelOverride(...args),
}));
vi.doMock("./stage-sandbox-media.runtime.js", () => ({
  stageSandboxMedia: (...args: unknown[]) => mocks.stageSandboxMedia(...args),
}));
vi.doMock("./commands-core.runtime.js", () => ({
  emitResetCommandHooks: (...args: unknown[]) => mocks.emitResetCommandHooks(...args),
}));

registerGetReplyRuntimeOverrides(mocks);

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;

async function loadGetReplyRuntimeForTest() {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
}

function createContinueDirectivesResult(
  overrides: { body?: string; resetHookTriggered?: boolean } = {},
) {
  return createGetReplyContinueDirectivesResult({
    body: overrides.body ?? "hello world",
    abortKey: "agent:main:telegram:-100123",
    from: "telegram:user:42",
    to: "telegram:-100123",
    senderId: "42",
    commandSource: "text",
    senderIsOwner: false,
    resetHookTriggered: overrides.resetHookTriggered ?? false,
  });
}

describe("getReplyFromConfig stale-runtime recovery", () => {
  beforeEach(async () => {
    await loadGetReplyRuntimeForTest();
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    delete process.env.OPENCLAW_TEST_FAST;
    mocks.resolveReplyDirectives.mockReset();
    mocks.handleInlineActions.mockReset();
    mocks.initSessionState.mockReset();
    mocks.applyResetModelOverride.mockReset();
    mocks.emitResetCommandHooks.mockReset();
    mocks.stageSandboxMedia.mockReset();
    mocks.hasHooks.mockReset();
    mocks.runBeforeAgentReply.mockReset();
    mocks.getGlobalHookRunner.mockReset();
    mocks.resolveOriginMessageProvider.mockReset();
    vi.mocked(logVerbose).mockReset();

    mocks.applyResetModelOverride.mockResolvedValue(undefined);
    mocks.emitResetCommandHooks.mockResolvedValue(undefined);
    mocks.stageSandboxMedia.mockResolvedValue(undefined);
    mocks.hasHooks.mockImplementation((hookName) => hookName === "before_agent_reply");
    mocks.runBeforeAgentReply.mockResolvedValue({ handled: false });
    mocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: mocks.hasHooks,
      runBeforeAgentReply: mocks.runBeforeAgentReply,
    } as unknown as HookRunner);
    mocks.resolveOriginMessageProvider.mockReturnValue("telegram");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("continues dispatching when session reset model override fails before reply routing", async () => {
    mocks.applyResetModelOverride.mockRejectedValueOnce(
      new Error(
        "Cannot find module '/tmp/openclaw/dist/auto-reply/reply/session-reset-model.runtime-old.js'",
      ),
    );
    mocks.initSessionState.mockResolvedValue(
      createGetReplySessionState({
        sessionCtx: buildNativeResetContext(),
        sessionKey: "agent:main:telegram:direct:123",
        isNewSession: true,
        resetTriggered: true,
        sessionScope: "per-sender",
        triggerBodyNormalized: "/new",
        bodyStripped: "/new",
      }),
    );
    mocks.resolveReplyDirectives.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });

    const reply = await getReplyFromConfig(buildNativeResetContext(), undefined, {});

    expect(reply).toEqual({ text: "ok" });
    expect(mocks.initSessionState).toHaveBeenCalledTimes(1);
    expect(mocks.applyResetModelOverride).toHaveBeenCalledTimes(1);
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledTimes(1);
    expect(logVerbose).toHaveBeenCalledWith(
      expect.stringContaining("session reset model override failed, proceeding without override"),
    );
  });

  it("continues dispatching when reset command hooks fail before reply routing", async () => {
    mocks.emitResetCommandHooks.mockRejectedValueOnce(
      new Error(
        "Cannot find module '/tmp/openclaw/dist/auto-reply/reply/commands-core.runtime-old.js'",
      ),
    );
    mocks.initSessionState.mockResolvedValue(
      createGetReplySessionState({
        sessionCtx: buildNativeResetContext(),
        sessionKey: "agent:main:telegram:direct:123",
        isNewSession: true,
        resetTriggered: true,
        sessionScope: "per-sender",
        triggerBodyNormalized: "/new",
        bodyStripped: "",
      }),
    );
    mocks.resolveReplyDirectives.mockResolvedValue(
      createGetReplyContinueDirectivesResult({
        body: "/new",
        abortKey: "telegram:slash:123",
        from: "telegram:123",
        to: "slash:123",
        senderId: "123",
        commandSource: "/new",
        senderIsOwner: true,
        resetHookTriggered: false,
      }),
    );
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });

    const reply = await getReplyFromConfig(buildNativeResetContext(), undefined, {});

    expect(reply).toEqual({ text: "ok" });
    expect(mocks.emitResetCommandHooks).toHaveBeenCalledTimes(1);
    expect(logVerbose).toHaveBeenCalledWith(
      expect.stringContaining("reset command hooks failed, proceeding without emission"),
    );
  });

  it("continues dispatching when before_agent_reply hook runner fails before reply routing", async () => {
    mocks.runBeforeAgentReply.mockRejectedValueOnce(
      new Error("Cannot find module '/tmp/openclaw/dist/plugins/hook-runner-global-old.js'"),
    );
    mocks.initSessionState.mockResolvedValue(
      createGetReplySessionState({
        sessionCtx: buildGetReplyGroupCtx({
          OriginatingChannel: "Telegram",
          Provider: "telegram",
        }),
        sessionKey: "agent:main:telegram:-100123",
        sessionScope: "per-chat",
        isGroup: true,
        triggerBodyNormalized: "hello world",
        bodyStripped: "hello world",
      }),
    );
    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult());
    mocks.handleInlineActions.mockResolvedValue({
      kind: "continue",
      directives: {},
      abortedLastRun: false,
    });

    const reply = await getReplyFromConfig(buildGetReplyGroupCtx(), undefined, {});

    // runPreparedReply is mocked to return undefined; the important assertion is
    // that the failure was caught, logged, and the function did NOT throw.
    expect(reply).toBeUndefined();
    expect(mocks.runBeforeAgentReply).toHaveBeenCalledTimes(1);
    expect(logVerbose).toHaveBeenCalledWith(
      expect.stringContaining(
        "before_agent_reply hook runner failed, proceeding without plugin interception",
      ),
    );
  });

  it("continues dispatching when origin routing fails before reply routing", async () => {
    mocks.resolveOriginMessageProvider.mockImplementationOnce(() => {
      throw new Error(
        "Cannot find module '/tmp/openclaw/dist/auto-reply/reply/origin-routing-old.js'",
      );
    });
    mocks.initSessionState.mockResolvedValue(
      createGetReplySessionState({
        sessionCtx: buildGetReplyGroupCtx({
          OriginatingChannel: "Telegram",
          Provider: "telegram",
        }),
        sessionKey: "agent:main:telegram:-100123",
        sessionScope: "per-chat",
        isGroup: true,
        triggerBodyNormalized: "hello world",
        bodyStripped: "hello world",
      }),
    );
    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult());
    mocks.handleInlineActions.mockResolvedValue({
      kind: "continue",
      directives: {},
      abortedLastRun: false,
    });

    const reply = await getReplyFromConfig(buildGetReplyGroupCtx(), undefined, {});

    expect(reply).toBeUndefined();
    expect(mocks.resolveOriginMessageProvider).toHaveBeenCalledTimes(1);
    // origin routing is wrapped together with the hook runner; the recovery
    // log message reflects the shared try/catch boundary.
    expect(logVerbose).toHaveBeenCalledWith(
      expect.stringContaining(
        "before_agent_reply hook runner failed, proceeding without plugin interception",
      ),
    );
  });

  it("continues dispatching when sandbox media staging fails before reply routing", async () => {
    mocks.stageSandboxMedia.mockRejectedValueOnce(
      new Error(
        "Cannot find module '/tmp/openclaw/dist/auto-reply/reply/stage-sandbox-media.runtime-old.js'",
      ),
    );
    mocks.hasHooks.mockImplementation(() => false);
    mocks.initSessionState.mockResolvedValue(
      createGetReplySessionState({
        sessionCtx: buildGetReplyGroupCtx({
          OriginatingChannel: "Telegram",
          Provider: "telegram",
        }),
        sessionKey: "agent:main:telegram:-100123",
        sessionScope: "per-chat",
        isGroup: true,
        triggerBodyNormalized: "hello world",
        bodyStripped: "hello world",
      }),
    );
    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult());
    mocks.handleInlineActions.mockResolvedValue({
      kind: "continue",
      directives: {},
      abortedLastRun: false,
    });

    const ctx = buildGetReplyGroupCtx({
      MediaPath: "/tmp/voice.ogg",
      MediaUrl: "https://example.test/voice.ogg",
      MediaType: "audio/ogg",
    });

    const reply = await getReplyFromConfig(ctx, undefined, {});

    expect(reply).toBeUndefined();
    expect(mocks.stageSandboxMedia).toHaveBeenCalledTimes(1);
    expect(logVerbose).toHaveBeenCalledWith(
      expect.stringContaining("sandbox media staging failed, proceeding without staged media"),
    );
  });

  it("skips sandbox media staging when caller has already pre-staged media", async () => {
    mocks.hasHooks.mockImplementation(() => false);
    mocks.initSessionState.mockResolvedValue(
      createGetReplySessionState({
        sessionCtx: buildGetReplyGroupCtx({
          OriginatingChannel: "Telegram",
          Provider: "telegram",
        }),
        sessionKey: "agent:main:telegram:-100123",
        sessionScope: "per-chat",
        isGroup: true,
        triggerBodyNormalized: "hello world",
        bodyStripped: "hello world",
      }),
    );
    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult());
    mocks.handleInlineActions.mockResolvedValue({
      kind: "continue",
      directives: {},
      abortedLastRun: false,
    });

    const ctx = buildGetReplyGroupCtx({
      MediaPath: "/tmp/voice.ogg",
      MediaUrl: "https://example.test/voice.ogg",
      MediaType: "audio/ogg",
      MediaStaged: true,
    });

    await getReplyFromConfig(ctx, undefined, {});

    expect(mocks.stageSandboxMedia).not.toHaveBeenCalled();
  });
});
