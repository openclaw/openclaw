import { describe, expect, it, vi } from "vitest";
import { resolveChatAvatarUrl, type ChatPageHost } from "./chat-state.ts";

vi.mock("../../app/assistant-identity.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/assistant-identity.ts")>()),
  loadLocalAssistantIdentity: () => ({ avatar: "data:image/png;base64,bG9jYWw=" }),
}));

describe("resolveChatAvatarUrl", () => {
  it("prefers the authenticated avatar blob over persisted and protected URLs", () => {
    const state = {
      sessionKey: "agent:main:main",
      chatAvatarUrl: "blob:authenticated-avatar",
      assistantAvatar: "/avatar/main",
      assistantAgentId: "main",
    } as unknown as ChatPageHost;

    expect(resolveChatAvatarUrl(state)).toBe("blob:authenticated-avatar");
  });
});
