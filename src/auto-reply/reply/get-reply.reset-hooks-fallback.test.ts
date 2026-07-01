// Tests reset hook fallback behavior inside the get-reply directive pipeline.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
  emitResetCommandHooks: vi.fn(),
  initSessionState: vi.fn(),
}));
vi.mock("./commands-core.js", () => ({
  emitResetCommandHooks: (...args: unknown[]) => mocks.emitResetCommandHooks(...args),
}));
vi.mock("./commands-core.runtime.js", () => ({
  emitResetCommandHooks: (...args: unknown[]) => mocks.emitResetCommandHooks(...args),
}));
registerGetReplyRuntimeOverrides(mocks);

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;

async function loadGetReplyRuntimeForTest() {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
}

function createContinueDirectivesResult(
  resetHookTriggered: boolean,
  body = "/new",
  overrides: { sessionKey?: string; from?: string; to?: string } = {},
) {
  return createGetReplyContinueDirectivesResult({
    body,
    abortKey: overrides.sessionKey ?? "telegram:slash:123",
    from: overrides.from ?? "telegram:123",
    to: overrides.to ?? "slash:123",
    senderId: "123",
    commandSource: body,
    senderIsOwner: true,
    resetHookTriggered,
  });
}

describe("getReplyFromConfig reset-hook fallback", () => {
  beforeAll(async () => {
    await loadGetReplyRuntimeForTest();
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    mocks.resolveReplyDirectives.mockReset();
    mocks.handleInlineActions.mockReset();
    mocks.emitResetCommandHooks.mockReset();
    mocks.initSessionState.mockReset();

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

    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult(false));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emits reset hooks when inline actions return early without marking resetHookTriggered", async () => {
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: undefined });

    await getReplyFromConfig(buildNativeResetContext(), undefined, {});

    expect(mocks.emitResetCommandHooks).toHaveBeenCalledTimes(1);
    const [[hookParams]] = mocks.emitResetCommandHooks.mock.calls as unknown as Array<
      [{ action?: string; sessionKey?: string }]
    >;
    expect(hookParams.action).toBe("new");
    expect(hookParams.sessionKey).toBe("agent:main:telegram:direct:123");
  });

  it("emits fallback reset hooks for the custom trigger that caused the reset", async () => {
    const ctx = buildNativeResetContext({
      Provider: "discord",
      Surface: "discord",
      RawBody: "!fresh tail",
      CommandBody: "!fresh tail",
      SessionKey: "agent:main:discord:channel:ops",
      CommandTargetSessionKey: "agent:main:discord:channel:ops",
      From: "discord:123",
      To: "discord:channel:ops",
    });
    mocks.initSessionState.mockResolvedValue(
      createGetReplySessionState({
        sessionCtx: ctx,
        sessionKey: "agent:main:discord:channel:ops",
        isNewSession: true,
        resetTriggered: true,
        sessionScope: "per-chat",
        triggerBodyNormalized: "!fresh tail",
        bodyStripped: "tail",
        matchedResetTrigger: "!fresh",
      }),
    );
    mocks.resolveReplyDirectives.mockResolvedValue(
      createContinueDirectivesResult(false, "!fresh tail", {
        sessionKey: "agent:main:discord:channel:ops",
        from: "discord:123",
        to: "discord:channel:ops",
      }),
    );
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: undefined });

    await getReplyFromConfig(ctx, undefined, {});

    expect(mocks.emitResetCommandHooks).toHaveBeenCalledTimes(1);
    const [[hookParams]] = mocks.emitResetCommandHooks.mock.calls as unknown as Array<
      [{ action?: string; sessionKey?: string }]
    >;
    expect(hookParams.action).toBe("new");
    expect(hookParams.sessionKey).toBe("agent:main:discord:channel:ops");
  });

  it("does not emit fallback hooks when resetHookTriggered is already set", async () => {
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: undefined });
    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult(true));

    await getReplyFromConfig(buildNativeResetContext(), undefined, {});

    expect(mocks.emitResetCommandHooks).not.toHaveBeenCalled();
  });
});
