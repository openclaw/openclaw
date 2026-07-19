// Tests reset hook fallback behavior inside the get-reply directive pipeline.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTurnAuthoritySnapshot } from "../../plugins/turn-authority.js";
import type { AuthorizationPolicyHandler } from "../../plugins/types.js";
import {
  buildNativeResetContext,
  createGetReplyContinueDirectivesResult,
  createGetReplySessionState,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-runtime-mocks.js";
import {
  REPLY_SESSION_RESET_CONTROL_BUSY_REPLY,
  ReplySessionResetControlError,
} from "./session-reset-control.js";
import {
  REPLY_SESSION_RESET_TARGET_CHANGED_REPLY,
  ReplySessionResetTargetChangedError,
} from "./session-reset-target.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  emitResetCommandHooks: vi.fn(),
  initSessionState: vi.fn(),
  resolveReplySessionPreprocessingState: vi.fn(),
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
    mocks.resolveReplySessionPreprocessingState.mockReset();
    resetGlobalHookRunner();
    setActivePluginRegistry(createEmptyPluginRegistry());

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
    mocks.resolveReplySessionPreprocessingState.mockReturnValue({
      sessionEntry: { sessionId: "existing-session" },
      sessionKey: "agent:main:telegram:direct:123",
      storePath: "/tmp/sessions.json",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emits reset hooks when inline actions return early without marking resetHookTriggered", async () => {
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: undefined });

    await getReplyFromConfig(buildNativeResetContext(), undefined, {});

    expect(mocks.emitResetCommandHooks).toHaveBeenCalledTimes(1);
    const [hookParams] = expectDefined(
      (
        mocks.emitResetCommandHooks.mock.calls as unknown as Array<
          [{ action?: string; sessionKey?: string }]
        >
      )[0],
      "(mocks.emitResetCommandHooks.mock.calls as unknown as Array<\n        [{ action?: string; sessionKey?: string }]\n      >)[0] test invariant",
    );
    expect(hookParams.action).toBe("new");
    expect(hookParams.sessionKey).toBe("agent:main:telegram:direct:123");
  });

  it("does not emit fallback hooks when resetHookTriggered is already set", async () => {
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: undefined });
    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult(true));

    await getReplyFromConfig(buildNativeResetContext(), undefined, {});

    expect(mocks.emitResetCommandHooks).not.toHaveBeenCalled();
  });

  it("pins the reset identity authorized before session initialization", async () => {
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: undefined });

    await getReplyFromConfig(buildNativeResetContext(), undefined, {});

    expect(mocks.initSessionState).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedResetTarget: {
          sessionKey: "agent:main:telegram:direct:123",
          sessionId: "existing-session",
        },
        prepareExplicitResetControl: expect.any(Function),
      }),
    );
  });

  it("preflights configured hard reset triggers through the same mutation gate", async () => {
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: undefined });
    const policy = vi.fn<AuthorizationPolicyHandler<"command.invoke">>(() => ({
      effect: "pass",
    }));
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "sender-access",
      source: "/plugins/sender-access/index.ts",
      policy: {
        id: "maintainer-actions",
        description: "Protect session rollover",
        handlers: { "command.invoke": policy },
      },
    });
    setActivePluginRegistry(registry);
    const ctx = {
      ...buildNativeResetContext(),
      Body: "/fresh KeepCase",
      RawBody: "/fresh KeepCase",
      CommandBody: "/fresh KeepCase",
    };

    await getReplyFromConfig(ctx, undefined, {
      session: { resetTriggers: ["/fresh"] },
    });

    expect(policy).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "command.invoke",
        phase: "session-mutation",
        commandName: "new",
        arguments: { raw: "KeepCase" },
      }),
      expect.objectContaining({
        sessionKey: "agent:main:telegram:direct:123",
        sessionId: "existing-session",
      }),
      expect.any(AbortSignal),
    );
    expect(mocks.initSessionState).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedResetTarget: {
          sessionKey: "agent:main:telegram:direct:123",
          sessionId: "existing-session",
        },
        prepareExplicitResetControl: expect.any(Function),
      }),
    );
  });

  it("fails closed when the authorized reset target changes before initialization", async () => {
    mocks.initSessionState.mockRejectedValueOnce(new ReplySessionResetTargetChangedError());

    const reply = await getReplyFromConfig(buildNativeResetContext(), undefined, {});

    expect(reply).toMatchObject({ text: REPLY_SESSION_RESET_TARGET_CHANGED_REPLY });
    expect(mocks.handleInlineActions).not.toHaveBeenCalled();
    expect(mocks.emitResetCommandHooks).not.toHaveBeenCalled();
  });

  it("returns a safe busy reply when active-run reset control cannot complete", async () => {
    mocks.initSessionState.mockRejectedValueOnce(new ReplySessionResetControlError("busy"));

    const reply = await getReplyFromConfig(buildNativeResetContext(), undefined, {});

    expect(reply).toMatchObject({ text: REPLY_SESSION_RESET_CONTROL_BUSY_REPLY });
    expect(mocks.handleInlineActions).not.toHaveBeenCalled();
    expect(mocks.emitResetCommandHooks).not.toHaveBeenCalled();
  });

  it("denies reset session mutation before session initialization", async () => {
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: undefined });
    const policy = vi.fn<AuthorizationPolicyHandler<"command.invoke">>((request) =>
      request.phase === "session-mutation"
        ? { effect: "deny", code: "reset-denied" }
        : { effect: "pass" },
    );
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "sender-access",
      source: "/plugins/sender-access/index.ts",
      policy: {
        id: "maintainer-actions",
        description: "Protect session rollover",
        handlers: { "command.invoke": policy },
      },
    });
    setActivePluginRegistry(registry);

    const reply = await getReplyFromConfig(buildNativeResetContext(), undefined, {});

    expect(policy).toHaveBeenCalledTimes(1);
    expect(policy).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "command.invoke",
        phase: "session-mutation",
        commandName: "new",
      }),
      expect.objectContaining({
        sessionKey: "agent:main:telegram:direct:123",
        sessionId: "existing-session",
      }),
      expect.any(AbortSignal),
    );
    expect(reply).toMatchObject({ text: "Command blocked by authorization policy." });
    expect(mocks.initSessionState).not.toHaveBeenCalled();
    expect(mocks.emitResetCommandHooks).not.toHaveBeenCalled();
  });

  it("rejects a cloned turn authority before session or policy work", async () => {
    const authority = createTurnAuthoritySnapshot({
      principal: {
        kind: "sender",
        provider: "telegram",
        senderId: "123",
        senderIsOwner: true,
        isAuthorizedSender: true,
      },
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:123",
      conversationId: "123",
      trigger: "channel",
    });
    const policy = vi.fn<AuthorizationPolicyHandler<"command.invoke">>(() => ({
      effect: "pass",
    }));
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "sender-access",
      source: "/plugins/sender-access/index.ts",
      policy: {
        id: "maintainer-actions",
        description: "Protect session rollover",
        handlers: { "command.invoke": policy },
      },
    });
    setActivePluginRegistry(registry);

    const reply = await getReplyFromConfig(
      { ...buildNativeResetContext(), TurnAuthority: structuredClone(authority) },
      undefined,
      {},
    );

    expect(reply).toMatchObject({ text: "Command blocked by authorization policy." });
    expect(policy).not.toHaveBeenCalled();
    expect(mocks.initSessionState).not.toHaveBeenCalled();
    expect(mocks.handleInlineActions).not.toHaveBeenCalled();
    expect(mocks.emitResetCommandHooks).not.toHaveBeenCalled();
  });

  it.each([
    ["agent", { agentId: "other" }],
    ["session", { sessionKey: "agent:main:telegram:direct:other" }],
    ["conversation", { conversationId: "telegram:other" }],
  ] as const)("rejects issued authority bound to another %s", async (_label, override) => {
    const targetSessionKey = "agent:main:telegram:direct:123";
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: {
        kind: "sender",
        provider: "telegram",
        senderId: "123",
        senderIsOwner: true,
        isAuthorizedSender: true,
      },
      agentId: "main",
      sessionKey: targetSessionKey,
      conversationId: targetSessionKey,
      trigger: "channel",
      ...override,
    });

    const reply = await getReplyFromConfig(
      { ...buildNativeResetContext(), TurnAuthority: turnAuthority },
      undefined,
      {},
    );

    expect(reply).toMatchObject({ text: "Command blocked by authorization policy." });
    expect(mocks.initSessionState).not.toHaveBeenCalled();
    expect(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
    expect(mocks.handleInlineActions).not.toHaveBeenCalled();
    expect(mocks.emitResetCommandHooks).not.toHaveBeenCalled();
  });

  it("accepts issued authority already rebound to the resolved reply target", async () => {
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
    const targetSessionKey = "agent:main:telegram:direct:123";
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: {
        kind: "sender",
        provider: "telegram",
        senderId: "123",
        senderIsOwner: true,
        isAuthorizedSender: true,
      },
      agentId: "main",
      sessionKey: targetSessionKey,
      conversationId: targetSessionKey,
      trigger: "command",
    });
    const ctx = { ...buildNativeResetContext(), TurnAuthority: turnAuthority };

    await getReplyFromConfig(ctx, undefined, {});

    expect(ctx.TurnAuthority).toBe(turnAuthority);
    expect(mocks.initSessionState).toHaveBeenCalledOnce();
    expect(mocks.handleInlineActions).toHaveBeenCalledOnce();
  });

  it("does not use the session-mutation phase for soft reset", async () => {
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: undefined });
    mocks.initSessionState.mockResolvedValue(
      createGetReplySessionState({
        sessionCtx: buildNativeResetContext(),
        sessionKey: "agent:main:telegram:direct:123",
        isNewSession: false,
        resetTriggered: false,
        sessionScope: "per-sender",
        triggerBodyNormalized: "/reset soft",
        bodyStripped: "/reset soft",
      }),
    );
    const policy = vi.fn<AuthorizationPolicyHandler<"command.invoke">>(() => ({
      effect: "deny",
      code: "mutation-only",
    }));
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "sender-access",
      source: "/plugins/sender-access/index.ts",
      policy: {
        id: "maintainer-actions",
        description: "Protect session rollover",
        handlers: { "command.invoke": policy },
      },
    });
    setActivePluginRegistry(registry);
    const ctx = {
      ...buildNativeResetContext(),
      Body: "/reset soft",
      RawBody: "/reset soft",
      CommandBody: "/reset soft",
    };

    await getReplyFromConfig(ctx, undefined, {});

    expect(policy).not.toHaveBeenCalled();
    expect(mocks.initSessionState).toHaveBeenCalledTimes(1);
    expect(mocks.initSessionState).toHaveBeenCalledWith(
      expect.not.objectContaining({ expectedResetTarget: expect.anything() }),
    );
  });
});
