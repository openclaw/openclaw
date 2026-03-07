import { describe, expect, it, vi } from "vitest";
import { createCommandHandlers } from "./tui-command-handlers.js";

const { resolveTuiModelSelection } = vi.hoisted(() => ({
  resolveTuiModelSelection: vi.fn(),
}));

vi.mock("./tui-model-selection.js", () => ({
  resolveTuiModelSelection,
}));

describe("tui command handlers", () => {
  it("forwards unknown slash commands to the gateway", async () => {
    const sendChat = vi.fn().mockResolvedValue({ runId: "r1" });
    const addUser = vi.fn();
    const addSystem = vi.fn();
    const requestRender = vi.fn();
    const setActivityStatus = vi.fn();

    const { handleCommand } = createCommandHandlers({
      client: { sendChat } as never,
      chatLog: { addUser, addSystem } as never,
      tui: { requestRender } as never,
      opts: {},
      state: {
        currentSessionKey: "agent:main:main",
        activeChatRunId: null,
        interactionMode: "chat",
        sessionInfo: {},
      } as never,
      deliverDefault: false,
      openOverlay: vi.fn(),
      closeOverlay: vi.fn(),
      updateFooter: vi.fn(),
      refreshSessionInfo: vi.fn(),
      loadHistory: vi.fn(),
      setSession: vi.fn(),
      refreshAgents: vi.fn(),
      abortActive: vi.fn(),
      setActivityStatus,
      formatSessionKey: vi.fn(),
      applySessionInfoFromPatch: vi.fn(),
      noteLocalRunId: vi.fn(),
    });

    await handleCommand("/context");

    expect(addSystem).not.toHaveBeenCalled();
    expect(addUser).toHaveBeenCalledWith("/context");
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        message: "/context",
      }),
    );
    expect(requestRender).toHaveBeenCalled();
  });

  it("passes reset reason when handling /new and /reset", async () => {
    const resetSession = vi.fn().mockResolvedValue({ ok: true });
    const addSystem = vi.fn();
    const requestRender = vi.fn();
    const loadHistory = vi.fn().mockResolvedValue(undefined);

    const { handleCommand } = createCommandHandlers({
      client: { resetSession } as never,
      chatLog: { addSystem } as never,
      tui: { requestRender } as never,
      opts: {},
      state: {
        currentSessionKey: "agent:main:main",
        activeChatRunId: null,
        interactionMode: "chat",
        sessionInfo: {},
      } as never,
      deliverDefault: false,
      openOverlay: vi.fn(),
      closeOverlay: vi.fn(),
      updateFooter: vi.fn(),
      refreshSessionInfo: vi.fn(),
      loadHistory,
      setSession: vi.fn(),
      refreshAgents: vi.fn(),
      abortActive: vi.fn(),
      setActivityStatus: vi.fn(),
      formatSessionKey: vi.fn(),
      applySessionInfoFromPatch: vi.fn(),
      noteLocalRunId: vi.fn(),
    });

    await handleCommand("/new");
    await handleCommand("/reset");

    expect(resetSession).toHaveBeenNthCalledWith(1, "agent:main:main", "new");
    expect(resetSession).toHaveBeenNthCalledWith(2, "agent:main:main", "reset");
    expect(loadHistory).toHaveBeenCalledTimes(2);
  });

  it("toggles plan mode and sends plan-mode messages", async () => {
    const sendChat = vi.fn().mockResolvedValue({ runId: "r1" });
    const addSystem = vi.fn();
    const requestRender = vi.fn();
    const updateFooter = vi.fn();
    const state: {
      currentSessionKey: string;
      activeChatRunId: string | null;
      interactionMode: "chat" | "plan";
      sessionInfo: Record<string, unknown>;
    } = {
      currentSessionKey: "agent:main:main",
      activeChatRunId: null,
      interactionMode: "chat",
      sessionInfo: {},
    };

    const { handleCommand, sendMessage } = createCommandHandlers({
      client: { sendChat } as never,
      chatLog: { addSystem, addUser: vi.fn() } as never,
      tui: { requestRender } as never,
      opts: {},
      state: state as never,
      deliverDefault: false,
      openOverlay: vi.fn(),
      closeOverlay: vi.fn(),
      updateFooter,
      refreshSessionInfo: vi.fn(),
      loadHistory: vi.fn(),
      setSession: vi.fn(),
      refreshAgents: vi.fn(),
      abortActive: vi.fn(),
      setActivityStatus: vi.fn(),
      formatSessionKey: vi.fn(),
      applySessionInfoFromPatch: vi.fn(),
      noteLocalRunId: vi.fn(),
    });

    await handleCommand("/plan");
    expect(state.interactionMode).toBe("plan");
    expect(addSystem).toHaveBeenCalledWith("plan mode enabled");

    await sendMessage("outline the work");
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "outline the work",
        interactionMode: "plan",
      }),
    );

    await handleCommand("/implement");
    expect(state.interactionMode).toBe("chat");
    expect(addSystem).toHaveBeenCalledWith("plan mode disabled; next message will run normally");
    expect(updateFooter).toHaveBeenCalledTimes(2);
  });

  it("resolves model aliases before patching the session", async () => {
    resolveTuiModelSelection.mockResolvedValue({
      selection: {
        provider: "openai-codex",
        model: "gpt-5.4",
        alias: "gpt-5.4",
        isDefault: false,
      },
    });
    const patchSession = vi.fn().mockResolvedValue({
      ok: true,
      key: "agent:main:main",
      entry: {},
    });
    const addSystem = vi.fn();

    const { handleCommand } = createCommandHandlers({
      client: { patchSession } as never,
      chatLog: { addSystem } as never,
      tui: { requestRender: vi.fn() } as never,
      opts: {},
      state: {
        currentSessionKey: "agent:main:main",
        activeChatRunId: null,
        interactionMode: "chat",
        sessionInfo: {
          modelProvider: "vllm",
          model: "cyankiwi/Qwen3.5-27B-AWQ-4bit",
        },
      } as never,
      deliverDefault: false,
      openOverlay: vi.fn(),
      closeOverlay: vi.fn(),
      updateFooter: vi.fn(),
      refreshSessionInfo: vi.fn(),
      loadHistory: vi.fn(),
      setSession: vi.fn(),
      refreshAgents: vi.fn(),
      abortActive: vi.fn(),
      setActivityStatus: vi.fn(),
      formatSessionKey: vi.fn(),
      applySessionInfoFromPatch: vi.fn(),
      noteLocalRunId: vi.fn(),
    });

    await handleCommand("/model gpt-5.4");

    expect(resolveTuiModelSelection).toHaveBeenCalledWith({
      raw: "gpt-5.4",
      currentProvider: "vllm",
      currentModel: "cyankiwi/Qwen3.5-27B-AWQ-4bit",
    });
    expect(patchSession).toHaveBeenCalledWith({
      key: "agent:main:main",
      model: "openai-codex/gpt-5.4",
    });
    expect(addSystem).toHaveBeenCalledWith("model set to gpt-5.4 (openai-codex/gpt-5.4)");
  });
});
