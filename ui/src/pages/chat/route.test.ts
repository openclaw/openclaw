import { beforeEach, describe, expect, it, vi } from "vitest";
import { switchChatSession } from "../../ui/app-render.helpers.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { renderChat } from "../../ui/views/chat.ts";
import { page } from "./route.ts";

vi.mock("../../ui/app-chat.ts", () => ({
  clearChatHistory: vi.fn(),
  hasAbortableSessionRun: vi.fn(() => false),
  refreshChat: vi.fn(),
  refreshChatCommands: vi.fn(),
  scopedAgentParamsForSession: vi.fn(() => ({ agentId: "main" })),
}));

vi.mock("../../ui/app-render.helpers.ts", () => ({
  createChatSession: vi.fn(),
  dismissChatError: vi.fn(),
  dismissRealtimeTalkError: vi.fn(),
  isCurrentChatSessionArchived: vi.fn(() => false),
  openCurrentSessionCheckpoints: vi.fn(),
  renderChatControls: vi.fn(),
  resolveAssistantAttachmentAuthToken: vi.fn(),
  switchChatSession: vi.fn(),
}));

vi.mock("../../ui/app-scroll.ts", () => ({
  scheduleChatScroll: vi.fn(),
}));

vi.mock("../../ui/views/chat.ts", () => ({
  renderChat: vi.fn(() => undefined),
  resetChatViewState: vi.fn(),
}));

vi.mock("../loaders.ts", () => ({
  loadChatPage: vi.fn(),
}));

vi.mock("./avatar.ts", () => ({
  resolveChatAgentId: vi.fn(() => "main"),
  resolveChatAvatarUrl: vi.fn(() => null),
}));

vi.mock("./session-workspace.ts", () => ({
  createSessionWorkspaceProps: vi.fn(() => undefined),
}));

describe("chat route", () => {
  beforeEach(() => {
    vi.mocked(renderChat).mockClear();
  });

  it("threads reply state and mutations into the chat view", async () => {
    const requestUpdate = vi.fn();
    const replyTarget = { messageId: "message-1", text: "hello", senderLabel: "User" };
    const state = {
      settings: { chatShowThinking: true, chatShowToolCalls: true },
      sessionKey: "agent:main:main",
      connected: true,
      chatReplyTarget: replyTarget,
      requestUpdate,
    } as unknown as AppViewState;
    const module = await page.component();

    module.render({ state, navigate: vi.fn() });

    const props = vi.mocked(renderChat).mock.calls[0]?.[0];
    expect(props?.replyTarget).toBe(replyTarget);
    const nextTarget = { messageId: "message-2", text: "next" };
    props?.onSetReply?.(nextTarget);
    expect(state.chatReplyTarget).toBe(nextTarget);
    props?.onClearReply?.();
    expect(state.chatReplyTarget).toBeNull();
    expect(requestUpdate).toHaveBeenCalledTimes(2);
  });

  it("synchronizes session selections with the router", async () => {
    const state = {
      settings: { chatShowThinking: true, chatShowToolCalls: true },
      sessionKey: "agent:main:old",
      connected: true,
    } as unknown as AppViewState;
    const navigate = vi.fn();
    const module = await page.component();

    module.render({ state, navigate });
    vi.mocked(renderChat).mock.calls[0]?.[0].onSessionKeyChange("agent:main:new");

    expect(switchChatSession).toHaveBeenCalledWith(state, "agent:main:new");
    expect(navigate).toHaveBeenCalledWith("chat", { history: "none" });
  });
});
