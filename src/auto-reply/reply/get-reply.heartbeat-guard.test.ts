import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../templating.js";
import type { ReplyDirectiveContinuation } from "./get-reply-directives.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  initSessionState: vi.fn(),
  handleInlineActions: vi.fn(),
}));
vi.mock("./directive-handling.defaults.js", () => ({
  resolveDefaultModel: vi.fn(() => ({
    defaultProvider: "openai",
    defaultModel: "gpt-4o-mini",
    aliasIndex: new Map(),
  })),
}));
vi.mock("./get-reply-directives.js", () => ({
  resolveReplyDirectives: (...args: unknown[]) => mocks.resolveReplyDirectives(...args),
}));
vi.mock("./get-reply-inline-actions.js", () => ({
  handleInlineActions: (...args: unknown[]) => mocks.handleInlineActions(...args),
}));
vi.mock("./session.js", () => ({
  initSessionState: (...args: unknown[]) => mocks.initSessionState(...args),
}));

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let loadConfigMock: typeof import("../../config/config.js").loadConfig;
let resolveModelRefFromStringMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  ({ getReplyFromConfig } = await import("./get-reply.js"));
  ({ loadConfig: loadConfigMock } = await import("../../config/config.js"));
  const modelSelection = await import("../../agents/model-selection.js");
  resolveModelRefFromStringMock = vi.mocked(modelSelection.resolveModelRefFromString);
});

function buildCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    ChatType: "direct",
    Body: "hello",
    BodyForAgent: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    SessionKey: "agent:main:telegram:123",
    From: "telegram:user:42",
    To: "telegram:123",
    Timestamp: 1710000000000,
    ...overrides,
  };
}

describe("getReplyFromConfig heartbeat guard", () => {
  beforeEach(() => {
    mocks.resolveReplyDirectives.mockReset();
    mocks.initSessionState.mockReset();
    mocks.handleInlineActions.mockReset();
    vi.mocked(loadConfigMock).mockReset();

    vi.mocked(loadConfigMock).mockReturnValue({});
    mocks.resolveReplyDirectives.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
    mocks.initSessionState.mockResolvedValue({
      sessionCtx: {},
      sessionEntry: {},
      previousSessionEntry: {},
      sessionStore: {},
      sessionKey: "agent:main:telegram:123",
      sessionId: "session-1",
      isNewSession: false,
      resetTriggered: false,
      systemSent: false,
      abortedLastRun: false,
      storePath: "/tmp/sessions.json",
      sessionScope: "per-chat",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: "",
      bodyStripped: "",
    });
  });

  it("preserves heartbeat model override after directive resolution", async () => {
    // resolveModelRefFromString is mocked to null by default in get-reply.test-mocks.ts;
    // override it once so the heartbeat ref resolves correctly.
    resolveModelRefFromStringMock.mockReturnValueOnce({
      ref: { provider: "minimax", model: "MiniMax-M2.7" },
    });

    // Simulate resolveReplyDirectives returning a different provider/model (as if a
    // model directive fired inside the heartbeat turn). The guard in get-reply.ts should
    // prevent this from overwriting the resolved heartbeat model.
    mocks.resolveReplyDirectives.mockResolvedValueOnce({
      kind: "continue",
      result: {
        commandSource: "",
        command: {},
        allowTextCommands: false,
        skillCommands: undefined,
        directives: {},
        cleanedBody: "",
        elevatedEnabled: false,
        elevatedAllowed: false,
        elevatedFailures: [],
        defaultActivation: undefined,
        resolvedThinkLevel: undefined,
        resolvedFastMode: false,
        resolvedVerboseLevel: undefined,
        resolvedReasoningLevel: "default",
        resolvedElevatedLevel: "default",
        execOverrides: undefined,
        blockStreamingEnabled: false,
        blockReplyChunking: undefined,
        resolvedBlockStreamingBreak: "message_end",
        provider: "openai",
        model: "gpt-4o-mini",
        modelState: { resolveDefaultThinkingLevel: undefined },
        contextTokens: 0,
        inlineStatusRequested: false,
        directiveAck: undefined,
        perMessageQueueMode: undefined,
        perMessageQueueOptions: undefined,
        messageProviderKey: "",
      } as unknown as ReplyDirectiveContinuation,
    });

    await getReplyFromConfig(buildCtx(), {
      isHeartbeat: true,
      heartbeatModelOverride: "minimax/MiniMax-M2.7",
    });

    // The guard must keep the heartbeat model — not the directive-resolved one.
    expect(mocks.handleInlineActions).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "minimax", model: "MiniMax-M2.7" }),
    );
  });
});
