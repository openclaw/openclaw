// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { loadLocalAssistantIdentity } from "../storage.ts";
import { loadAssistantIdentity, setAssistantAvatarOverride } from "./assistant-identity.ts";

function createAssistantIdentityState(
  overrides: Partial<Parameters<typeof loadAssistantIdentity>[0]> = {},
) {
  return {
    client: {
      request: vi.fn().mockResolvedValue({
        agentId: "lottery",
        name: "Lottery",
        avatar: "L",
        avatarSource: "avatars/lottery.png",
        avatarStatus: "local",
        avatarReason: null,
      }),
    },
    connected: true,
    sessionKey: "agent:lottery:main",
    assistantName: "Assistant",
    assistantAvatar: null,
    assistantAvatarSource: null,
    assistantAvatarStatus: null,
    assistantAvatarReason: null,
    assistantAgentId: null,
    ...overrides,
  } as Parameters<typeof loadAssistantIdentity>[0];
}

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
    expect(loadLocalAssistantIdentity().avatar).toBe("data:image/png;base64,YXZhdGFy");
  });

  it("clears the local override", () => {
    const state: Parameters<typeof setAssistantAvatarOverride>[0] = {
      assistantAvatar: "data:image/png;base64,YXZhdGFy",
      assistantAvatarSource: "data:image/png;base64,YXZhdGFy",
      assistantAvatarStatus: "data",
    };
    setAssistantAvatarOverride(state, "data:image/png;base64,YXZhdGFy");

    setAssistantAvatarOverride(state, null);

    expect(state.assistantAvatarSource).toBeNull();
    expect(state.assistantAvatarStatus).toBeNull();
    expect(state.assistantAvatarReason).toBeNull();
    expect(loadLocalAssistantIdentity().avatar).toBeNull();
  });
});

describe("loadAssistantIdentity", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests identity for the current session key", async () => {
    const state = createAssistantIdentityState();

    await loadAssistantIdentity(state);

    expect(state.client?.request).toHaveBeenCalledWith("agent.identity.get", {
      sessionKey: "agent:lottery:main",
    });
  });

  it("uses an explicit session key instead of reading current mutable state", async () => {
    const state = createAssistantIdentityState({ sessionKey: "agent:main:main" });

    await loadAssistantIdentity(state, { sessionKey: "agent:lottery:main" });

    expect(state.client?.request).toHaveBeenCalledWith("agent.identity.get", {
      sessionKey: "agent:lottery:main",
    });
  });

  it("writes returned identity fields to state", async () => {
    const state = createAssistantIdentityState();

    await loadAssistantIdentity(state);

    expect(state.assistantName).toBe("Lottery");
    expect(state.assistantAvatar).toBe("L");
    expect(state.assistantAvatarSource).toBe("avatars/lottery.png");
    expect(state.assistantAvatarStatus).toBe("local");
    expect(state.assistantAvatarReason).toBeNull();
    expect(state.assistantAgentId).toBe("lottery");
  });

  it("ignores stale implicit identity results after the active session changes", async () => {
    let resolveRequest:
      | ((value: { agentId: string; name: string; avatar: string }) => void)
      | undefined;
    const state = createAssistantIdentityState({
      client: {
        request: vi.fn(
          () =>
            new Promise((resolve) => {
              resolveRequest = resolve;
            }),
        ),
      } as unknown as Parameters<typeof loadAssistantIdentity>[0]["client"],
    });

    const pending = loadAssistantIdentity(state);
    state.sessionKey = "agent:main:main";
    resolveRequest?.({
      agentId: "lottery",
      name: "Lottery",
      avatar: "L",
    });
    await pending;

    expect(state.assistantName).toBe("Assistant");
    expect(state.assistantAvatar).toBeNull();
    expect(state.assistantAgentId).toBeNull();
  });

  it("applies explicit session key results even if the active session changes", async () => {
    let resolveRequest:
      | ((value: { agentId: string; name: string; avatar: string }) => void)
      | undefined;
    const state = createAssistantIdentityState({
      sessionKey: "agent:main:main",
      client: {
        request: vi.fn(
          () =>
            new Promise((resolve) => {
              resolveRequest = resolve;
            }),
        ),
      } as unknown as Parameters<typeof loadAssistantIdentity>[0]["client"],
    });

    const pending = loadAssistantIdentity(state, { sessionKey: "agent:lottery:main" });
    state.sessionKey = "agent:main:main";
    resolveRequest?.({
      agentId: "lottery",
      name: "Lottery",
      avatar: "L",
    });
    await pending;

    expect(state.assistantName).toBe("Lottery");
    expect(state.assistantAvatar).toBe("L");
    expect(state.assistantAgentId).toBe("lottery");
  });
});
