import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { maybeHandleResetCommand } from "./commands-reset.js";
import type { HandleCommandsParams } from "./commands-types.js";

const triggerInternalHookMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../../channels/plugins/binding-targets.js", () => ({
  resetConfiguredBindingTargetInPlace: vi.fn().mockResolvedValue({ ok: false, skipped: true }),
}));

vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: (
    type: string,
    action: string,
    sessionKey: string,
    context: Record<string, unknown>,
  ) => ({
    type,
    action,
    sessionKey,
    context,
    timestamp: new Date(0),
    messages: [],
  }),
  triggerInternalHook: triggerInternalHookMock,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../commands-registry.js", () => ({
  normalizeCommandBody: (raw: string) => raw.trim(),
  shouldHandleTextCommands: () => true,
}));

vi.mock("./commands-acp/targets.js", () => ({
  resolveBoundAcpThreadSessionKey: vi.fn(() => undefined),
}));

vi.mock("./commands-handlers.runtime.js", () => ({
  loadCommandHandlers: () => [],
}));

function buildResetParams(
  commandBody: string,
  cfg: OpenClawConfig,
  ctxOverrides?: Partial<MsgContext>,
): HandleCommandsParams {
  const ctx = {
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "whatsapp",
    Surface: "whatsapp",
    SessionKey: "agent:main:main",
    ...ctxOverrides,
  } as MsgContext;

  return {
    ctx,
    cfg,
    command: {
      commandBodyNormalized: commandBody.trim(),
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: ctx.SenderId ?? "123",
      channel: String(ctx.Surface ?? "whatsapp"),
      channelId: String(ctx.Surface ?? "whatsapp"),
      surface: String(ctx.Surface ?? "whatsapp"),
      ownerList: [],
      from: ctx.From ?? "sender",
      to: ctx.To ?? "bot",
      resetHookTriggered: false,
    },
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp/openclaw-commands",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "whatsapp",
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
  };
}

describe("handleCommands reset hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("triggers hooks for /new commands", async () => {
    const cases = [
      {
        name: "text command with arguments",
        params: buildResetParams("/new take notes", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        expectedCall: expect.objectContaining({ type: "command", action: "new" }),
      },
      {
        name: "native command routed to target session",
        params: (() => {
          const params = buildResetParams(
            "/new",
            {
              commands: { text: true },
              channels: { telegram: { allowFrom: ["*"] } },
            } as OpenClawConfig,
            {
              Provider: "telegram",
              Surface: "telegram",
              CommandSource: "native",
              CommandTargetSessionKey: "agent:main:telegram:direct:123",
              SessionKey: "telegram:slash:123",
              SenderId: "123",
              From: "telegram:123",
              To: "slash:123",
              CommandAuthorized: true,
            },
          );
          params.sessionKey = "agent:main:telegram:direct:123";
          return params;
        })(),
        expectedCall: expect.objectContaining({
          type: "command",
          action: "new",
          sessionKey: "agent:main:telegram:direct:123",
          context: expect.objectContaining({
            workspaceDir: "/tmp/openclaw-commands",
          }),
        }),
      },
    ] as const;

    for (const testCase of cases) {
      await maybeHandleResetCommand(testCase.params);
      expect(triggerInternalHookMock, testCase.name).toHaveBeenCalledWith(testCase.expectedCall);
      triggerInternalHookMock.mockClear();
    }
  });
});
