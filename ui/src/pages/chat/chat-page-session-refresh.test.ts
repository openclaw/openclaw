/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page.test/"} */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mock-isolation: Observe page publications without mounting panes that start session requests.
vi.mock("./chat-pane.tsx", async () => {
  const { mockChatPagePane } = await import("./chat-page-pane.test-support.ts");
  return { ChatPaneView: mockChatPagePane };
});

// mock-isolation: Count page snapshot publications while retaining the real keyed DOM renderer.
vi.mock("./chat-page-pane-render.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-page-pane-render.tsx")>();
  return { ...actual, createChatPageSnapshot: vi.fn(actual.createChatPageSnapshot) };
});

import { patchSettings } from "../../app/settings.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createChatPageSnapshot } from "./chat-page-pane-render.tsx";
import {
  settleChatPage,
  createSessionTitleSource,
  createSplitLayout,
  setNavigationContext,
  stubMatchMedia,
} from "./chat-page.test-support.ts";
import { ChatPage } from "./chat-page.ts";

describe("chat page session refresh", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    stubMatchMedia(false);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("leaves roster presentation updates with mounted panes", async () => {
    const page = new ChatPage();
    const source = createSessionTitleSource();
    const navigation = setNavigationContext(page);
    Object.assign(navigation.context, { sessions: source.sessions });
    page.data = { sessionKey: "agent:main:current" };
    patchSettings({ chatSplitLayout: createSplitLayout(page.data.sessionKey) });
    document.body.append(page);
    await settleChatPage(page);
    const panes = [...page.querySelectorAll("openclaw-chat-pane")];
    const render = vi.mocked(createChatPageSnapshot).mockClear();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );

    for (const key of ["agent:main:other", page.data.sessionKey]) {
      source.publish(key, "Updated conversation");
      for (const frame of frames.splice(0)) {
        frame(0);
      }
      await settleChatPage(page);
    }

    expect(render).not.toHaveBeenCalled();
    expect([...page.querySelectorAll("openclaw-chat-pane")]).toEqual(panes);
    page.remove();
    await settleChatPage(page);
    expect(source.listeners.size).toBe(0);
  });

  it("refreshes route defaults on hello changes while leaving profile updates with children", async () => {
    const page = new ChatPage();
    const navigation = setNavigationContext(page);
    const listeners = new Set<(snapshot: typeof navigation.context.gateway.snapshot) => void>();
    const gateway = {
      ...navigation.context.gateway,
      subscribe: (listener: (snapshot: typeof navigation.context.gateway.snapshot) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    Object.assign(navigation.context, { gateway });
    page.data = { sessionKey: "agent:main:current" };
    document.body.append(page);
    await settleChatPage(page);
    const render = vi.mocked(createChatPageSnapshot).mockClear();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );

    gateway.snapshot = { ...gateway.snapshot, selfUser: { id: "viewer", name: "Updated viewer" } };
    for (const listener of listeners) {
      listener(gateway.snapshot);
    }
    for (const frame of frames.splice(0)) {
      frame(0);
    }
    await settleChatPage(page);
    expect(render).not.toHaveBeenCalled();

    gateway.snapshot = { ...gateway.snapshot, hello: gatewayHelloForMethods([]) };
    for (const listener of listeners) {
      listener(gateway.snapshot);
    }
    for (const frame of frames.splice(0)) {
      frame(0);
    }
    await settleChatPage(page);
    expect(render).toHaveBeenCalledTimes(1);
  });
});
