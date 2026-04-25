// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { loadLocalAssistantIdentity } from "../storage.ts";
import { setAssistantAvatarOverride } from "./assistant-identity.ts";

describe("setAssistantAvatarOverride", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists the assistant avatar locally and mirrors the user avatar pattern", () => {
    const state: Parameters<typeof setAssistantAvatarOverride>[0] = {};

    setAssistantAvatarOverride(state, "data:image/png;base64,YXZhdGFy");

    expect(state.assistantAvatar).toBe("data:image/png;base64,YXZhdGFy");
    expect(state.assistantAvatarSource).toBe("data:image/png;base64,YXZhdGFy");
    expect(state.assistantAvatarStatus).toBe("data");
    expect(state.assistantAvatarReason).toBeNull();
    expect(state.chatAvatarUrl).toBeNull();
    expect(state.chatAvatarSource).toBe("data:image/png;base64,YXZhdGFy");
    expect(state.chatAvatarStatus).toBe("data");
    expect(state.chatAvatarReason).toBeNull();
    expect(loadLocalAssistantIdentity().avatar).toBe("data:image/png;base64,YXZhdGFy");
  });

  it("clears the local override", () => {
    const state: Parameters<typeof setAssistantAvatarOverride>[0] = {
      assistantAvatar: "data:image/png;base64,YXZhdGFy",
      assistantAvatarSource: "data:image/png;base64,YXZhdGFy",
      assistantAvatarStatus: "data",
      chatAvatarUrl: "blob:server-avatar",
      chatAvatarSource: "server-avatar.png",
      chatAvatarStatus: "local",
    };
    setAssistantAvatarOverride(state, "data:image/png;base64,YXZhdGFy");

    setAssistantAvatarOverride(state, null);

    expect(state.assistantAvatar).toBeNull();
    expect(state.assistantAvatarSource).toBeNull();
    expect(state.assistantAvatarStatus).toBeNull();
    expect(state.assistantAvatarReason).toBeNull();
    expect(state.chatAvatarUrl).toBeNull();
    expect(state.chatAvatarSource).toBeNull();
    expect(state.chatAvatarStatus).toBeNull();
    expect(state.chatAvatarReason).toBeNull();
    expect(loadLocalAssistantIdentity().avatar).toBeNull();
  });
});
