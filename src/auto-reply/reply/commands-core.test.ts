// Tests core command dispatch, reset hooks, authorization, and send policy.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HookRunner } from "../../plugins/hooks.js";
import { commandFixture } from "./commands-handler-fixture.test-support.js";
import type {
  CommandDispatchParams,
  CommandHandler,
  HandleCommandsParams,
} from "./commands-types.js";

const hookRunnerMocks = vi.hoisted(() => ({
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runBeforeReset: vi.fn<HookRunner["runBeforeReset"]>(),
  loadTranscriptEvents: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("../../config/sessions/session-accessor.js", () => {
  return {
    loadTranscriptEvents: hookRunnerMocks.loadTranscriptEvents,
  };
});

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () =>
    ({
      hasHooks: hookRunnerMocks.hasHooks,
      runBeforeReset: hookRunnerMocks.runBeforeReset,
    }) as unknown as HookRunner,
}));

const { emitResetCommandHooks } = await import("./commands-reset-hooks.js");

function transcriptMessage(id: string, parentId: string | null, role: string, content: string) {
  return { type: "message", id, parentId, message: { role, content } };
}

describe("emitResetCommandHooks", () => {
  async function resetHooks(
    sessionKey?: string,
    cfg: HandleCommandsParams["cfg"] = {
      agents: { entries: { main: {} } },
    },
  ) {
    const command = {
      surface: "discord",
      senderId: "rai",
      channel: "discord",
      from: "discord:rai",
      to: "discord:bot",
      resetHookTriggered: false,
    } as HandleCommandsParams["command"];

    await emitResetCommandHooks({
      action: "new",
      ctx: {} as HandleCommandsParams["ctx"],
      cfg,
      command,
      sessionKey,
      previousSessionEntry: {
        sessionId: "prev-session",
        ...(sessionKey
          ? { sessionFile: "sqlite:main:prev-session:/tmp/openclaw-agent.sqlite" }
          : {}),
      } as HandleCommandsParams["previousSessionEntry"],
      storePath: "/tmp/openclaw-agent.sqlite",
      workspaceDir: "/tmp/openclaw-workspace",
    });

    await vi.waitFor(() => expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledTimes(1));
    return expectDefined(hookRunnerMocks.runBeforeReset.mock.calls[0], "before_reset call");
  }

  beforeEach(() => {
    hookRunnerMocks.hasHooks.mockReset();
    hookRunnerMocks.runBeforeReset.mockReset();
    hookRunnerMocks.loadTranscriptEvents.mockReset();
    hookRunnerMocks.hasHooks.mockImplementation((hookName) => hookName === "before_reset");
    hookRunnerMocks.runBeforeReset.mockResolvedValue(undefined);
    hookRunnerMocks.loadTranscriptEvents.mockResolvedValue([]);
  });

  it("uses the configured default when the reset hook has no session key", async () => {
    const [, ctx] = await resetHooks(undefined, {
      agents: { entries: { ops: {} } },
    });
    expect(ctx).toMatchObject({
      agentId: "ops",
      sessionId: "prev-session",
      workspaceDir: "/tmp/openclaw-workspace",
    });
    expect(ctx?.sessionKey).toBeUndefined();
  });

  it("loads marker-backed before_reset transcripts by session identity", async () => {
    hookRunnerMocks.loadTranscriptEvents.mockResolvedValueOnce([
      {
        type: "message",
        id: "m1",
        message: { role: "user", content: "Recovered from archive" },
      },
    ]);
    const [event, ctx] = await resetHooks(
      "agent:main:telegram:group:-1003826723328:topic:8428",
      {},
    );
    expect(hookRunnerMocks.loadTranscriptEvents).toHaveBeenCalledWith({
      agentId: "main",
      sessionId: "prev-session",
      sessionKey: "agent:main:telegram:group:-1003826723328:topic:8428",
      storePath: "/tmp/openclaw-agent.sqlite",
    });
    expect(event).toMatchObject({
      sessionFile: "sqlite:main:prev-session:/tmp/openclaw-agent.sqlite",
      reason: "new",
    });
    expect(event.messages).toEqual([{ role: "user", content: "Recovered from archive" }]);
    expect(ctx.sessionId).toBe("prev-session");
  });

  it("keeps leaf-controlled side branches out of before_reset hooks", async () => {
    hookRunnerMocks.loadTranscriptEvents.mockResolvedValueOnce([
      transcriptMessage("active-root", null, "user", "active root"),
      transcriptMessage("side-entry", "active-root", "assistant", "side delivery"),
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "side-entry",
        targetId: "active-root",
      },
      transcriptMessage("active-tail", "active-root", "assistant", "active tail"),
      {
        type: "metadata",
        id: "opaque-after-active-tail",
        parentId: "side-entry",
      },
    ]);

    const [event] = await resetHooks("agent:main:main", {});
    expect(event.messages).toEqual([
      { role: "user", content: "active root" },
      { role: "assistant", content: "active tail" },
    ]);
  });
});

const loadCommandHandlersMock = vi.hoisted((): ReturnType<typeof vi.fn<() => CommandHandler[]>> =>
  vi.fn<() => CommandHandler[]>(() => []),
);

vi.mock("./commands-handlers.runtime.js", () => ({
  loadCommandHandlers: () => loadCommandHandlersMock(),
}));

vi.mock("./commands-reset.js", () => ({
  maybeHandleResetCommand: vi.fn(async () => null),
}));

vi.mock("../commands-registry.js", () => ({
  shouldHandleTextCommands: vi.fn(() => true),
}));

function makeParams(): CommandDispatchParams {
  return {
    ...commandFixture(
      "/unknown",
      {
        ctx: { Provider: "whatsapp", Surface: "whatsapp", CommandSource: "text" },
      },
      { surface: "whatsapp" },
    ),
    cfg: {
      commands: { text: true },
      session: {
        sendPolicy: {
          default: "allow",
          rules: [{ action: "deny", match: { channel: "telegram" } }],
        },
      },
    },
    sessionKey: "agent:target:main",
    sessionEntry: {
      sessionId: "wrapper-session",
      updatedAt: Date.now(),
      channel: "whatsapp",
      chatType: "direct",
    },
    sessionStore: {
      "agent:target:main": {
        sessionId: "target-session",
        updatedAt: Date.now(),
        channel: "telegram",
        chatType: "direct",
      },
    },
    resolveModelLevels: async () => ({
      resolvedThinkLevel: undefined,
      resolvedReasoningLevel: "off",
    }),
  };
}

describe("handleCommands send policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    loadCommandHandlersMock.mockReturnValue([]);
  });

  it("allows processing to continue even when send policy is deny (#53328)", async () => {
    const { handleCommands } = await import("./commands-core.js");
    // Send policy suppresses downstream delivery, not inbound command processing.
    const result = await handleCommands(makeParams());

    expect(result).toEqual({ shouldContinue: true });
  });

  it("dispatches agent:target:main with its selected owner", async () => {
    const { handleCommands } = await import("./commands-core.js");
    const handler = vi.fn<CommandHandler>(async (params) => ({
      shouldContinue: false,
      reply: { text: params.agentId },
    }));
    loadCommandHandlersMock.mockReturnValue([handler]);
    const params = makeParams();
    params.cfg.agents = {
      ownership: "explicit",
      entries: { caller: {}, target: { agentDir: "/tmp/target-agent" } },
    };
    params.agentId = "caller";
    params.agentDir = "/tmp/caller-agent";

    expect((await handleCommands(params)).reply?.text).toBe("target");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir: "/tmp/target-agent" }),
      true,
    );
  });

  it.each([true, false])(
    "preserves literal input when command interpretation is suppressed (%s)",
    async (suppressed) => {
      const { handleCommands } = await import("./commands-core.js");
      const { maybeHandleResetCommand } = await import("./commands-reset.js");
      const handler = vi.fn<CommandHandler>(async () => ({ shouldContinue: false }));
      loadCommandHandlersMock.mockReturnValue([handler]);
      const params = makeParams();
      params.ctx.CommandInterpretationSuppressed = suppressed;
      params.command.commandBodyNormalized = "/stop";
      params.command.rawBodyNormalized = "/stop";

      expect(await handleCommands(params)).toEqual({ shouldContinue: suppressed });
      expect(maybeHandleResetCommand).toHaveBeenCalledTimes(suppressed ? 0 : 1);
      expect(handler).toHaveBeenCalledTimes(suppressed ? 0 : 1);
      expect(params.command.commandBodyNormalized).toBe("/stop");
    },
  );
});
