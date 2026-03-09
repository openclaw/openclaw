import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../templating.js";
import { registerGetReplyCommonMocks } from "./get-reply.test-mocks.js";

const mocks = vi.hoisted(() => ({
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
}));

registerGetReplyCommonMocks();

vi.mock("../../link-understanding/apply.js", () => ({
  applyLinkUnderstanding: vi.fn(async () => undefined),
}));
vi.mock("../../media-understanding/apply.js", () => ({
  applyMediaUnderstanding: vi.fn(async () => undefined),
}));
vi.mock("./commands-core.js", () => ({
  emitResetCommandHooks: vi.fn(async () => undefined),
}));
vi.mock("./get-reply-inline-actions.js", () => ({
  handleInlineActions: (...args: unknown[]) => mocks.handleInlineActions(...args),
}));
vi.mock("./session.js", () => ({
  initSessionState: (...args: unknown[]) => mocks.initSessionState(...args),
}));

const { getReplyFromConfig } = await import("./get-reply.js");

function buildWhatsAppCtx(): MsgContext {
  return {
    Provider: "whatsapp",
    Surface: "whatsapp",
    OriginatingChannel: "whatsapp",
    OriginatingTo: "+15550001111",
    ChatType: "direct",
    Body: "/model openai/gpt-4o",
    BodyForAgent: "/model openai/gpt-4o",
    RawBody: "/model openai/gpt-4o",
    CommandBody: "/model openai/gpt-4o",
    SessionKey: "agent:main:whatsapp:direct:+15550001111",
    From: "+15550001111",
    To: "+15550002222",
    CommandAuthorized: false,
    InboundPolicy: {
      allowAgentDispatch: true,
      allowTextCommands: false,
      allowOperationalDirectives: false,
      pauseMode: "active",
    },
  };
}

describe("getReplyFromConfig whatsapp inbound policy", () => {
  beforeEach(() => {
    mocks.handleInlineActions.mockReset();
    mocks.initSessionState.mockReset();

    mocks.initSessionState.mockResolvedValue({
      sessionCtx: {
        Body: "/model openai/gpt-4o",
        BodyForAgent: "/model openai/gpt-4o",
        RawBody: "/model openai/gpt-4o",
        CommandBody: "/model openai/gpt-4o",
        Provider: "whatsapp",
        Surface: "whatsapp",
        ChatType: "direct",
      },
      sessionEntry: {},
      previousSessionEntry: {},
      sessionStore: {},
      sessionKey: "agent:main:whatsapp:direct:+15550001111",
      sessionId: "session-1",
      isNewSession: false,
      resetTriggered: false,
      systemSent: false,
      abortedLastRun: false,
      storePath: "/tmp/sessions.json",
      sessionScope: "per-chat",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: "/model openai/gpt-4o",
      bodyStripped: "/model openai/gpt-4o",
    });

    mocks.handleInlineActions.mockResolvedValue({
      kind: "reply",
      reply: undefined,
    });
  });

  it("blocks whatsapp command and directive handling while preserving the raw body for normal prompting", async () => {
    const ctx = buildWhatsAppCtx();

    await getReplyFromConfig(ctx, undefined, {
      commands: { text: true },
      agents: { defaults: {} },
    });

    expect(mocks.handleInlineActions).toHaveBeenCalledTimes(1);
    const params = mocks.handleInlineActions.mock.calls[0]?.[0] as {
      allowTextCommands: boolean;
      cleanedBody: string;
      directives: {
        hasModelDirective?: boolean;
        hasStatusDirective?: boolean;
        hasThinkDirective?: boolean;
        hasExecDirective?: boolean;
      };
      command: {
        commandBodyNormalized: string;
      };
    };
    expect(params.allowTextCommands).toBe(false);
    expect(params.cleanedBody).toBe("/model openai/gpt-4o");
    expect(params.command.commandBodyNormalized).toBe("/model openai/gpt-4o");
    expect(params.directives.hasModelDirective).toBe(false);
    expect(params.directives.hasStatusDirective).toBe(false);
    expect(params.directives.hasThinkDirective).toBe(false);
    expect(params.directives.hasExecDirective).toBe(false);
  });
});
