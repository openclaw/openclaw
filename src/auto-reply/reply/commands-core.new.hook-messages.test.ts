import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Mock ALL imported command handlers so handleCommands() doesn't run real logic ----
vi.mock("./commands-allowlist.js", () => ({ handleAllowlistCommand: async () => null }));
vi.mock("./commands-approve.js", () => ({ handleApproveCommand: async () => null }));
vi.mock("./commands-bash.js", () => ({ handleBashCommand: async () => null }));
vi.mock("./commands-compact.js", () => ({ handleCompactCommand: async () => null }));
vi.mock("./commands-config.js", () => ({
  handleConfigCommand: async () => null,
  handleDebugCommand: async () => null,
}));
vi.mock("./commands-info.js", () => ({
  handleCommandsListCommand: async () => null,
  handleContextCommand: async () => null,
  handleHelpCommand: async () => null,
  handleStatusCommand: async () => null,
  handleWhoamiCommand: async () => null,
}));
vi.mock("./commands-models.js", () => ({ handleModelsCommand: async () => null }));
vi.mock("./commands-plugin.js", () => ({ handlePluginCommand: async () => null }));
vi.mock("./commands-session.js", () => ({
  handleAbortTrigger: async () => null,
  handleActivationCommand: async () => null,
  handleRestartCommand: async () => null,
  handleSendPolicyCommand: async () => null,
  handleStopCommand: async () => null,
  handleUsageCommand: async () => null,
}));
vi.mock("./commands-subagents.js", () => ({ handleSubagentsCommand: async () => null }));
vi.mock("./commands-tts.js", () => ({ handleTtsCommands: async () => null }));

// ---- Mock routeReply so we can assert hook messages are (or aren't) surfaced ----
const routeReplyMock = vi.fn(async () => undefined);
vi.mock("./route-reply.js", () => ({ routeReply: (...args: unknown[]) => routeReplyMock(...args) }));

// ---- Mock internal hooks: create event + optionally push messages during trigger ----
type HookEvent = { messages: string[] };

const createInternalHookEventMock = vi.fn((): HookEvent => ({ messages: [] }));
let triggerMode: "EMPTY" | "ONE" | "TWO" = "EMPTY";

const triggerInternalHookMock = vi.fn(async (event: HookEvent) => {
  if (triggerMode === "ONE") event.messages.push("BLOCKED: CONFIRM_REQUIRED");
  if (triggerMode === "TWO") event.messages.push("LINE1", "LINE2");
});

vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: (...args: unknown[]) => createInternalHookEventMock(...args),
  triggerInternalHook: (...args: unknown[]) => triggerInternalHookMock(...args),
}));

// ---- Keep shouldHandleTextCommands deterministic ----
vi.mock("../commands-registry.js", () => ({
  shouldHandleTextCommands: () => true,
}));

// ---- Avoid send-policy dependencies ----
vi.mock("../../sessions/send-policy.js", () => ({
  resolveSendPolicy: () => "allow",
}));

// ---- Avoid verbose logging dependency ----
vi.mock("../../globals.js", () => ({
  logVerbose: () => undefined,
}));

describe("commands-core /new hook message surfacing", () => {
  beforeEach(() => {
    routeReplyMock.mockClear();
    createInternalHookEventMock.mockClear();
    triggerInternalHookMock.mockClear();
    triggerMode = "EMPTY";
    vi.resetModules();
  });

  function baseParams(commandBodyNormalized: string) {
    return {
      command: {
        commandBodyNormalized,
        isAuthorizedSender: true,
        surface: "chat",
        channel: "test-channel",
        from: "user-1",
        to: "bot-1",
        senderId: "user-1",
      },
      sessionKey: "session-123",
      sessionEntry: undefined,
      previousSessionEntry: undefined,
      ctx: {
        OriginatingChannel: "test-channel",
        OriginatingTo: "user-1",
        AccountId: "acct-1",
        MessageThreadId: "thread-1",
        CommandSource: "text",
      },
      cfg: {},
    } as any;
  }

  it("surfaces hookEvent.messages via routeReply when /new hook writes messages", async () => {
    triggerMode = "ONE";
    const { handleCommands } = await import("./commands-core.js");

    await handleCommands(baseParams("/new"));

    expect(triggerInternalHookMock).toHaveBeenCalledTimes(1);
    expect(routeReplyMock).toHaveBeenCalledTimes(1);

    const call = routeReplyMock.mock.calls[0]?.[0] as any;
    expect(call?.payload?.text).toBe("BLOCKED: CONFIRM_REQUIRED");
  });

  it("does not call routeReply when /new hook leaves messages empty", async () => {
    triggerMode = "EMPTY";
    const { handleCommands } = await import("./commands-core.js");

    await handleCommands(baseParams("/new"));

    expect(triggerInternalHookMock).toHaveBeenCalledTimes(1);
    expect(routeReplyMock).toHaveBeenCalledTimes(0);
  });

  it("joins multiple hook messages with blank lines", async () => {
    triggerMode = "TWO";
    const { handleCommands } = await import("./commands-core.js");

    await handleCommands(baseParams("/new"));

    expect(routeReplyMock).toHaveBeenCalledTimes(1);
    const call = routeReplyMock.mock.calls[0]?.[0] as any;
    expect(call?.payload?.text).toBe("LINE1\n\nLINE2");
  });
});
