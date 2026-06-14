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

    expect(state.assistantAvatar).toBeNull();
    expect(state.assistantAvatarSource).toBeNull();
    expect(state.assistantAvatarStatus).toBeNull();
    expect(state.assistantAvatarReason).toBeNull();
    expect(loadLocalAssistantIdentity().avatar).toBeNull();
  });

  it("scopes the local override to the given agentId", () => {
    const state: Parameters<typeof setAssistantAvatarOverride>[0] = {};

    setAssistantAvatarOverride(state, "data:image/png;base64,YWdlbnQx", "agent-1");

    expect(loadLocalAssistantIdentity("agent-1").avatar).toBe("data:image/png;base64,YWdlbnQx");
    expect(loadLocalAssistantIdentity("agent-2").avatar).toBeNull();
    expect(loadLocalAssistantIdentity().avatar).toBeNull();
  });

  it("clears the agent-scoped local override", () => {
    const state: Parameters<typeof setAssistantAvatarOverride>[0] = {};
    setAssistantAvatarOverride(state, "data:image/png;base64,YWdlbnQx", "agent-1");

    setAssistantAvatarOverride(state, null, "agent-1");

    expect(loadLocalAssistantIdentity("agent-1").avatar).toBeNull();
  });

  it("applies the agent-scoped local override when loading identity", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ agentId: "agent-1", name: "Agent One", avatar: "A1" });
    const state: Parameters<typeof loadAssistantIdentity>[0] = {
      client: { request } as never,
      connected: true,
      sessionKey: "agent:agent-1:main",
      assistantName: "Old",
      assistantAvatar: null,
      assistantAgentId: "agent-1",
    };
    // Pre-seed localStorage with an override for this agent
    const storage = createStorageMock();
    storage.setItem(
      "openclaw.control.assistant.v1:agent-1",
      JSON.stringify({ avatar: "data:image/png;base64,b3ZlcnJpZGU=" }),
    );
    vi.stubGlobal("localStorage", storage);

    await loadAssistantIdentity(state);

    expect(state.assistantAvatar).toBe("data:image/png;base64,b3ZlcnJpZGU=");
    expect(state.assistantAvatarStatus).toBe("data");
    expect(state.assistantAvatarReason).toBeNull();
  });
});
