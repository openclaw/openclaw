// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { setChatAvatarUrl } from "../app-chat.ts";
import { loadLocalAssistantIdentity } from "../storage.ts";
import { loadAssistantIdentity, setAssistantAvatarOverride } from "./assistant-identity.ts";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("loadAssistantIdentity", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ignores stale identity responses after the active session changes", async () => {
    const first = createDeferred<unknown>();
    const second = createDeferred<unknown>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const state: Parameters<typeof loadAssistantIdentity>[0] = {
      client: { request } as never,
      connected: true,
      sessionKey: "agent:main:main",
      assistantName: "Main",
      assistantAvatar: null,
      assistantAgentId: "main",
    };

    const firstLoad = loadAssistantIdentity(state);
    state.sessionKey = "agent:worker:main";
    const secondLoad = loadAssistantIdentity(state);

    second.resolve({ agentId: "worker", name: "Worker", avatar: "W" });
    await secondLoad;
    expect(state.assistantName).toBe("Worker");
    expect(state.assistantAgentId).toBe("worker");

    first.resolve({ agentId: "main", name: "Main After", avatar: "M" });
    await firstLoad;

    expect(state.assistantName).toBe("Worker");
    expect(state.assistantAvatar).toBe("W");
    expect(state.assistantAgentId).toBe("worker");
    expect(request).toHaveBeenNthCalledWith(1, "agent.identity.get", {
      sessionKey: "agent:main:main",
    });
    expect(request).toHaveBeenNthCalledWith(2, "agent.identity.get", {
      sessionKey: "agent:worker:main",
    });
  });
});

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
    expect(state.chatAvatarUrl).toBe("data:image/png;base64,YXZhdGFy");
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

  it("revokes managed blob URLs when changing or clearing the override", () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static revokeObjectURL = revokeObjectURL;
      },
    );
    const state: Parameters<typeof setAssistantAvatarOverride>[0] = {};

    setChatAvatarUrl(state, "blob:server-avatar");
    setAssistantAvatarOverride(state, "data:image/png;base64,YXZhdGFy");

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:server-avatar");

    setChatAvatarUrl(state, "blob:next-server-avatar");
    setAssistantAvatarOverride(state, null);

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:next-server-avatar");
  });
});
