// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { loadLocalAssistantIdentity } from "../storage.ts";
import { loadAssistantIdentity, setAssistantAvatarOverride } from "./assistant-identity.ts";

function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  if (!resolve) {
    throw new Error("Expected deferred resolver to be initialized");
  }
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

  it("applies a scoped identity request while its expected UI session remains active", async () => {
    const request = vi.fn().mockResolvedValue({
      agentId: "alpha",
      name: "Alpha",
      avatar: "A",
    });
    const state: Parameters<typeof loadAssistantIdentity>[0] = {
      client: { request } as never,
      connected: true,
      sessionKey: "main",
      assistantName: "Worker",
      assistantAvatar: null,
      assistantAgentId: "worker",
    };

    await loadAssistantIdentity(state, {
      sessionKey: "agent:alpha:main",
      expectedSessionKey: "main",
    });

    expect(state.assistantName).toBe("Alpha");
    expect(state.assistantAvatar).toBe("A");
    expect(state.assistantAgentId).toBe("alpha");
    expect(request).toHaveBeenCalledWith("agent.identity.get", {
      sessionKey: "agent:alpha:main",
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

    setAssistantAvatarOverride(state, "data:image/png;base64,YXZhdGFy", "main");

    expect(state.assistantAvatar).toBe("data:image/png;base64,YXZhdGFy");
    expect(state.assistantAvatarSource).toBe("data:image/png;base64,YXZhdGFy");
    expect(state.assistantAvatarStatus).toBe("data");
    expect(state.assistantAvatarReason).toBeNull();
    expect(loadLocalAssistantIdentity({ agentId: "main" }).avatar).toBe(
      "data:image/png;base64,YXZhdGFy",
    );
  });

  it("clears the local override", () => {
    const state: Parameters<typeof setAssistantAvatarOverride>[0] = {
      assistantAvatar: "data:image/png;base64,YXZhdGFy",
      assistantAvatarSource: "data:image/png;base64,YXZhdGFy",
      assistantAvatarStatus: "data",
    };
    setAssistantAvatarOverride(state, "data:image/png;base64,YXZhdGFy", "main");

    setAssistantAvatarOverride(state, null, "main");

    expect(state.assistantAvatar).toBeNull();
    expect(state.assistantAvatarSource).toBeNull();
    expect(state.assistantAvatarStatus).toBeNull();
    expect(state.assistantAvatarReason).toBeNull();
    expect(loadLocalAssistantIdentity({ agentId: "main" }).avatar).toBeNull();
  });

  it("keeps assistant avatar overrides isolated by agent", () => {
    setAssistantAvatarOverride({}, "data:image/png;base64,bWFpbg==", "main");
    setAssistantAvatarOverride({}, "data:image/png;base64,d29ya2Vy", "worker");

    expect(loadLocalAssistantIdentity({ agentId: "main" }).avatar).toBe(
      "data:image/png;base64,bWFpbg==",
    );
    expect(loadLocalAssistantIdentity({ agentId: "worker" }).avatar).toBe(
      "data:image/png;base64,d29ya2Vy",
    );

    setAssistantAvatarOverride({}, null, "worker");

    expect(loadLocalAssistantIdentity({ agentId: "main" }).avatar).toBe(
      "data:image/png;base64,bWFpbg==",
    );
    expect(loadLocalAssistantIdentity({ agentId: "worker" }).avatar).toBeNull();
  });

  it("migrates the legacy global override to the first loaded agent", () => {
    localStorage.setItem(
      "openclaw.control.assistant.v1",
      JSON.stringify({ avatar: "data:image/png;base64,bGVnYWN5" }),
    );

    expect(loadLocalAssistantIdentity({ agentId: "main" }).avatar).toBe(
      "data:image/png;base64,bGVnYWN5",
    );
    expect(loadLocalAssistantIdentity({ agentId: "worker" }).avatar).toBeNull();
  });

  it("supports prototype-like agent IDs without inherited avatar values", () => {
    setAssistantAvatarOverride({}, "data:image/png;base64,Y29uc3RydWN0b3I=", "constructor");
    setAssistantAvatarOverride({}, "data:image/png;base64,cHJvdG8=", "__proto__");

    expect(loadLocalAssistantIdentity({ agentId: "constructor" }).avatar).toBe(
      "data:image/png;base64,Y29uc3RydWN0b3I=",
    );
    expect(loadLocalAssistantIdentity({ agentId: "__proto__" }).avatar).toBe(
      "data:image/png;base64,cHJvdG8=",
    );
    expect(loadLocalAssistantIdentity({ agentId: "toString" }).avatar).toBeNull();
  });

  it("scopes avatar storage per agent ID (regression #90890)", () => {
    const mainState: Parameters<typeof setAssistantAvatarOverride>[0] = {
      assistantAgentId: "main",
    };
    const workerState: Parameters<typeof setAssistantAvatarOverride>[0] = {
      assistantAgentId: "worker",
    };

    setAssistantAvatarOverride(mainState, "data:image/png;base64,bWFpbg==");
    setAssistantAvatarOverride(workerState, "data:image/png;base64,d29ya2Vy");

    // Each agent should have its own avatar.
    expect(loadLocalAssistantIdentity("main").avatar).toBe("data:image/png;base64,bWFpbg==");
    expect(loadLocalAssistantIdentity("worker").avatar).toBe("data:image/png;base64,d29ya2Vy");

    // Clearing one agent should not affect the other.
    setAssistantAvatarOverride(mainState, null);
    expect(loadLocalAssistantIdentity("main").avatar).toBeNull();
    expect(loadLocalAssistantIdentity("worker").avatar).toBe("data:image/png;base64,d29ya2Vy");
  });

  it("falls back to global key when agent-specific key is not set", () => {
    // Set a global avatar (no agent ID).
    setAssistantAvatarOverride({}, "data:image/png;base64,Z2xvYmFs");

    // An agent with no specific avatar should fall back to the global key.
    expect(loadLocalAssistantIdentity("new-agent").avatar).toBe("data:image/png;base64,Z2xvYmFs");
  });

  it("handles legacy global key after scoped clear (upgrade scenario)", () => {
    // Simulate legacy state: global avatar exists from before the scoping fix.
    setAssistantAvatarOverride({}, "data:image/png;base64,bGVnYWN5");

    // Agent "main" should see the legacy global avatar.
    expect(loadLocalAssistantIdentity("main").avatar).toBe("data:image/png;base64,bGVnYWN5");

    // Set a scoped avatar for "main".
    const mainState: Parameters<typeof setAssistantAvatarOverride>[0] = {
      assistantAgentId: "main",
    };
    setAssistantAvatarOverride(mainState, "data:image/png;base64,c2NvcGVk");
    expect(loadLocalAssistantIdentity("main").avatar).toBe("data:image/png;base64,c2NvcGVk");

    // Clear the scoped avatar for "main".
    setAssistantAvatarOverride(mainState, null);
    expect(loadLocalAssistantIdentity("main").avatar).toBeNull();

    // The legacy global avatar should still be available for other agents.
    expect(loadLocalAssistantIdentity("other-agent").avatar).toBe("data:image/png;base64,bGVnYWN5");

    // After clearing scoped, "main" should NOT fall back to global
    // (the scoped key exists with null value, which blocks fallback).
    expect(loadLocalAssistantIdentity("main").avatar).toBeNull();
  });
});
