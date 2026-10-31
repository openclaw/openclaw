/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page.test/"} */

import { expect, it, vi } from "vitest";

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
import { createChatPageFixture, useChatPageFixture } from "./chat-page-lifecycle.test-support.ts";
import { createChatPageSnapshot } from "./chat-page-pane-render.tsx";
import { createSessionTitleSource, createSplitLayout } from "./chat-page.test-support.ts";

useChatPageFixture(true);

function watchRenders(settlePage: () => Promise<void>) {
  const render = vi.mocked(createChatPageSnapshot).mockClear();
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  return {
    render,
    settle: async () => {
      frames.splice(0).forEach((frame) => frame(0));
      await settlePage();
    },
  };
}

it("leaves roster presentation updates with mounted panes", async () => {
  const { page, navigation, mount, settle: settlePage } = createChatPageFixture();
  const source = createSessionTitleSource();
  Object.assign(navigation.context, { sessions: source.sessions });
  patchSettings({ chatSplitLayout: createSplitLayout(page.data.sessionKey) });
  await mount();
  const panes = [...page.querySelectorAll("openclaw-chat-pane")];
  const { render, settle } = watchRenders(settlePage);

  for (const key of ["agent:main:other", page.data.sessionKey]) {
    source.publish(key, "Updated conversation");
    await settle();
  }

  expect(render).not.toHaveBeenCalled();
  expect([...page.querySelectorAll("openclaw-chat-pane")]).toEqual(panes);
  page.remove();
  await settlePage();
  expect(source.listeners.size).toBe(0);
});

it("refreshes route defaults on hello changes while leaving profile updates with children", async () => {
  const { navigation, mount, settle: settlePage } = createChatPageFixture();
  const listeners = new Set<(snapshot: typeof navigation.context.gateway.snapshot) => void>();
  const gateway = {
    ...navigation.context.gateway,
    subscribe: (listener: (snapshot: typeof navigation.context.gateway.snapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  Object.assign(navigation.context, { gateway });
  await mount();
  const { render, settle } = watchRenders(settlePage);

  const publish = async (patch: Partial<typeof gateway.snapshot>) => {
    gateway.snapshot = { ...gateway.snapshot, ...patch };
    listeners.forEach((listener) => listener(gateway.snapshot));
    await settle();
  };

  await publish({ selfUser: { id: "viewer", name: "Updated viewer" } });
  expect(render).not.toHaveBeenCalled();

  await publish({ hello: gatewayHelloForMethods([]) });
  expect(render).toHaveBeenCalledTimes(1);
});
