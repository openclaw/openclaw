// Tests reset hook fallback behavior inside the get-reply directive pipeline.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildNativeResetContext,
  createGetReplyContinueDirectivesResult,
  createGetReplySessionState,
  registerGetReplyBaselineBypass,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-runtime-mocks.js";

registerGetReplyBaselineBypass();

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

let getReplyFromConfigInternal: typeof import("./get-reply.js").getReplyFromConfigInternal;

async function loadGetReplyRuntimeForTest() {
  ({ getReplyFromConfigInternal } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
}

function createContinueDirectivesResult(resetHookTriggered: boolean) {
  return createGetReplyContinueDirectivesResult({
    body: "/new",
    abortKey: "telegram:slash:123",
    from: "telegram:123",
    to: "slash:123",
    senderId: "123",
    commandSource: "/new",
    senderIsOwner: true,
    resetHookTriggered,
  });
}

describe("getReplyFromConfigInternal reset-hook fallback", () => {
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
    const onObservedReplyDelivery = vi.fn();

    await getReplyFromConfigInternal(buildNativeResetContext(), { onObservedReplyDelivery }, {});

    expect(mocks.emitResetCommandHooks).toHaveBeenCalledTimes(1);
    expect(mocks.emitResetCommandHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "new",
        onObservedReplyDelivery,
        sessionKey: "agent:main:telegram:direct:123",
      }),
    );
  });

  it("does not emit fallback hooks when resetHookTriggered is already set", async () => {
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: undefined });
    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult(true));

    await getReplyFromConfigInternal(buildNativeResetContext(), undefined, {});

    expect(mocks.emitResetCommandHooks).not.toHaveBeenCalled();
  });
});
