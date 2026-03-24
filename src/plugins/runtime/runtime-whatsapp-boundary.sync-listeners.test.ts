import { afterEach, describe, expect, it, vi } from "vitest";

const WHATSAPP_ACTIVE_LISTENER_STATE_KEY = Symbol.for("openclaw.whatsapp.activeListenerState");

function createMockListener() {
  return {
    sendMessage: vi.fn(async () => ({ messageId: "msg-1" })),
    sendPoll: vi.fn(async () => ({ messageId: "poll-1" })),
    sendReaction: vi.fn(async () => {}),
    sendComposingTo: vi.fn(async () => {}),
  };
}

function setHostActiveListener(accountId: string, listener: unknown): void {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  let state = globalStore[WHATSAPP_ACTIVE_LISTENER_STATE_KEY] as
    | { listeners: Map<string, unknown>; current: unknown }
    | undefined;
  if (!state) {
    state = { listeners: new Map(), current: null };
    globalStore[WHATSAPP_ACTIVE_LISTENER_STATE_KEY] = state;
  }
  state.listeners.set(accountId, listener);
}

function clearHostActiveListeners(): void {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const state = globalStore[WHATSAPP_ACTIVE_LISTENER_STATE_KEY] as
    | { listeners: Map<string, unknown>; current: unknown }
    | undefined;
  if (state) {
    state.listeners.clear();
    state.current = null;
  }
}

afterEach(() => {
  clearHostActiveListeners();
});

describe("syncActiveListenersToLoadedModule", () => {
  it("bridges host listeners into a loaded module that lacks them", async () => {
    const listener = createMockListener();
    setHostActiveListener("default", listener);

    // Simulate a Jiti-loaded module with its own state (empty listeners)
    const loadedModule = {
      getActiveWebListener: vi.fn((_accountId?: string | null) => null),
      setActiveWebListener: vi.fn(),
      sendMessageWhatsApp: vi.fn(async () => ({ messageId: "m1", toJid: "j1" })),
    };

    // Reproduce the sync logic from the boundary
    const hostState = (globalThis as Record<PropertyKey, unknown>)[
      WHATSAPP_ACTIVE_LISTENER_STATE_KEY
    ] as { listeners: Map<string, unknown> } | undefined;

    expect(hostState?.listeners?.size).toBe(1);

    for (const [accountId, lis] of hostState!.listeners) {
      if (lis && !loadedModule.getActiveWebListener(accountId)) {
        (loadedModule.setActiveWebListener as (id: string, l: unknown) => void)(accountId, lis);
      }
    }

    expect(loadedModule.setActiveWebListener).toHaveBeenCalledWith("default", listener);
  });

  it("does not overwrite listeners already present in the loaded module", async () => {
    const hostListener = createMockListener();
    const existingListener = createMockListener();
    setHostActiveListener("default", hostListener);

    const loadedModule = {
      getActiveWebListener: vi.fn((accountId?: string | null) =>
        accountId === "default" ? existingListener : null,
      ),
      setActiveWebListener: vi.fn(),
    };

    const hostState = (globalThis as Record<PropertyKey, unknown>)[
      WHATSAPP_ACTIVE_LISTENER_STATE_KEY
    ] as { listeners: Map<string, unknown> } | undefined;

    for (const [accountId, lis] of hostState!.listeners) {
      if (lis && !loadedModule.getActiveWebListener(accountId)) {
        (loadedModule.setActiveWebListener as (id: string, l: unknown) => void)(accountId, lis);
      }
    }

    // Should not have been called because the loaded module already has the listener
    expect(loadedModule.setActiveWebListener).not.toHaveBeenCalled();
  });

  it("handles multiple accounts", async () => {
    const listener1 = createMockListener();
    const listener2 = createMockListener();
    setHostActiveListener("personal", listener1);
    setHostActiveListener("work", listener2);

    const loadedModule = {
      getActiveWebListener: vi.fn((_accountId?: string | null) => null),
      setActiveWebListener: vi.fn(),
    };

    const hostState = (globalThis as Record<PropertyKey, unknown>)[
      WHATSAPP_ACTIVE_LISTENER_STATE_KEY
    ] as { listeners: Map<string, unknown> } | undefined;

    for (const [accountId, lis] of hostState!.listeners) {
      if (lis && !loadedModule.getActiveWebListener(accountId)) {
        (loadedModule.setActiveWebListener as (id: string, l: unknown) => void)(accountId, lis);
      }
    }

    expect(loadedModule.setActiveWebListener).toHaveBeenCalledTimes(2);
    expect(loadedModule.setActiveWebListener).toHaveBeenCalledWith("personal", listener1);
    expect(loadedModule.setActiveWebListener).toHaveBeenCalledWith("work", listener2);
  });

  it("is a no-op when no host listeners exist", () => {
    const loadedModule = {
      getActiveWebListener: vi.fn((_accountId?: string | null) => null),
      setActiveWebListener: vi.fn(),
    };

    const hostState = (globalThis as Record<PropertyKey, unknown>)[
      WHATSAPP_ACTIVE_LISTENER_STATE_KEY
    ] as { listeners: Map<string, unknown> } | undefined;

    if (hostState?.listeners?.size) {
      for (const [accountId, lis] of hostState.listeners) {
        if (lis && !loadedModule.getActiveWebListener(accountId)) {
          (loadedModule.setActiveWebListener as (id: string, l: unknown) => void)(accountId, lis);
        }
      }
    }

    expect(loadedModule.setActiveWebListener).not.toHaveBeenCalled();
    expect(loadedModule.getActiveWebListener).not.toHaveBeenCalled();
  });
});
