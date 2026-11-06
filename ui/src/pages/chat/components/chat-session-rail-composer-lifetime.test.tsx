/* @vitest-environment jsdom */

import { createRoot, onSettled } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { SessionRailComposer } from "./chat-session-rail-composer.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

function fixture() {
  const observations = new Map<Element, () => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      disconnect = vi.fn();
      observe = (element: Element) => observations.set(element, this.disconnect);
      unobserve() {}
    },
  );
  const request = vi.fn(async (method: string) =>
    method === "talk.catalog" ? { transcription: { ready: true }, realtime: { ready: true } } : {},
  );
  const props = {
    sessionKey: "agent:test:main",
    client: createTestGatewayClient(request),
    presented: true,
    textareaRef: () => {},
    companion: { draft: "A follow-up", turns: [], loading: false },
    connected: true,
    pending: false,
    sendShortcut: "enter",
    attachmentProps: {},
    submit: vi.fn(),
  } satisfies Parameters<typeof SessionRailComposer>[0];
  return { props, request, observations };
}

it("does not acquire textarea or dictation resources before the rail settles", () => {
  const { props, request, observations } = fixture();
  let settled = false;
  const view = mountSolid(() => {
    createRoot((dispose) => {
      onSettled(() => {
        settled = true;
      });
      const content = <SessionRailComposer {...props} />;
      dispose();
      return content;
    });
    return null;
  });
  try {
    expect(settled).toBe(false);
    expect({
      requests: request.mock.calls.length,
      textareaObservers: [...observations.keys()].filter(
        (element) => element.tagName === "TEXTAREA",
      ).length,
    }).toEqual({ requests: 0, textareaObservers: 0 });
  } finally {
    view.unmount();
  }
});

it("observes the mounted textarea and retires dictation focus refresh with the rail", async () => {
  const { props, request, observations } = fixture();
  const view = mountSolid(() => <SessionRailComposer {...props} />);
  try {
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
    const textarea = view.container.querySelector("textarea")!;
    const disconnect = observations.get(textarea);
    expect(disconnect).toBeDefined();
    expect(view.container.querySelector(".chat-send-btn--voice")).not.toBeNull();
    window.dispatchEvent(new Event("focus"));
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(4));
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("focus"));
    expect(request).toHaveBeenCalledTimes(4);
  } finally {
    view.unmount();
  }
});
