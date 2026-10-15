import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { solidContent } from "../../lit/solid-content.tsx";
import {
  createInitializationContext,
  createTestChatPane,
  connectPaneTestView,
} from "./chat-pane.test-support.ts";
import { createPageState } from "./chat-state-page.ts";
import { requestChatPageUpdate } from "./chat-state-render.ts";

function PaneLabels(props: { label: string | undefined; id: string }) {
  return (
    <>
      <span>{props.label}</span>
      <span>{props.id}</span>
    </>
  );
}

function StreamOutput(props: { value: string | null }) {
  return <output>{props.value}</output>;
}

// MessageChannel supplies distinct browser tasks without a timer or a real-frame race.
async function task(action: () => void) {
  const channel = new MessageChannel();
  try {
    await new Promise<void>((resolve, reject) => {
      channel.port1.addEventListener(
        "message",
        () => {
          try {
            action();
            resolve();
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        { once: true },
      );
      channel.port1.start();
      channel.port2.postMessage(null);
    });
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
}

async function mountPane(presented = true) {
  const { pane } = createTestChatPane({
    client: { request: vi.fn() } as unknown as GatewayBrowserClient,
    sessions: {} as SessionCapability,
  });
  // Use the existing lifecycle harness, with a small render to isolate cadence.
  Object.assign(pane, {
    render: () => ({
      layout: solidContent(PaneLabels, { label: pane.paneLabel, id: pane.paneId }),
    }),
    presentedChanged: () => {},
  });
  pane.presented = presented;
  const updates = vi.spyOn(pane, "render");
  connectPaneTestView(pane);
  await pane.updateComplete;
  expect(updates).toHaveBeenCalledTimes(1);
  expect(pane.textContent).toContain(pane.paneId);
  updates.mockClear();
  return { pane, updates };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "parks property changes until presented and settles updateComplete (initially presented: %s)",
  async (initiallyPresented) => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { pane, updates } = await mountPane(initiallyPresented);
    pane.presented = false;
    for (let index = 0; index < 6; index++) {
      await task(() => {
        pane.paneLabel = `hidden revision ${index}`;
        pane.paneId = `parked-pane-${index}`;
        pane.requestUpdate();
      });
    }
    let completed = false;
    const completion = pane.updateComplete.then(() => {
      completed = true;
    });
    await task(() => {});
    expect(updates).not.toHaveBeenCalled();
    expect(completed).toBe(false);
    pane.presented = true;
    await completion;
    expect(updates).toHaveBeenCalledTimes(1);
    expect(pane.textContent).toContain("hidden revision 5");
    expect(pane.textContent).toContain("parked-pane-5");
  },
);

it.each(["request", "property", "state"] as const)(
  "renders a presented inactive split pane immediately for a %s without animation frames",
  async (trigger) => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { pane, updates } = await mountPane();
    expect(pane.active).toBe(false);
    const lifecycle = pane.chatState.createRenderLifecycle();
    await task(() => {
      if (trigger === "property") {
        pane.paneLabel = "immediate property";
      } else if (trigger === "state") {
        lifecycle.invalidate();
      } else {
        pane.requestUpdate();
      }
    });
    await pane.updateComplete;
    expect(updates).toHaveBeenCalledTimes(1);
    if (trigger === "property") {
      expect(pane.textContent).toContain("immediate property");
    }
  },
);

it("keeps an unpresented pane parked when the document becomes visible", async () => {
  let visibility: DocumentVisibilityState = "hidden";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  const { pane, updates } = await mountPane(false);
  pane.requestUpdate();
  await task(() => {});
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  await task(() => {});
  expect(updates).not.toHaveBeenCalled();
  pane.presented = true;
  await pane.updateComplete;
  expect(updates).toHaveBeenCalledTimes(1);
});

it("absorbs a queued stream frame into a property commit and accepts the next stream", async () => {
  let nextFrame = 1;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const { pane } = await mountPane();
  const state = createPageState(
    createInitializationContext(),
    pane.chatState.createRenderLifecycle(),
    pane,
  );
  pane.state = state;
  pane.chatState.attach(state);
  Object.assign(pane, {
    render: () => ({ layout: solidContent(StreamOutput, { value: state.chatStream }) }),
  });
  const updates = vi.spyOn(pane, "render");
  state.chatStream = "First stream revision";
  requestChatPageUpdate(state, "animation-frame");
  const queuedFrame = frames.get(state.chatStreamRenderFrame!);
  expect(queuedFrame).toBeDefined();

  await task(() => {
    pane.paneLabel = "Property revision";
  });
  await pane.updateComplete;
  expect(pane.textContent).toContain("First stream revision");
  expect(updates).toHaveBeenCalledOnce();
  queuedFrame?.(0);
  await task(() => {});
  await pane.updateComplete;
  expect(updates).toHaveBeenCalledOnce();

  state.chatStream = "Next stream revision";
  requestChatPageUpdate(state, "animation-frame");
  frames.get(state.chatStreamRenderFrame!)?.(0);
  await task(() => {});
  await pane.updateComplete;
  expect(updates).toHaveBeenCalledTimes(2);
  expect(pane.textContent).toContain("Next stream revision");
});

it("releases a disconnected pane's parked update and renders after reconnect", async () => {
  const { pane, updates } = await mountPane(false);
  pane.requestUpdate();
  await task(() => {});
  Object.defineProperty(pane, "isConnected", { configurable: true, value: false });
  pane.disconnectedCallback();
  await pane.updateComplete;
  expect(updates).not.toHaveBeenCalled();
  Object.defineProperty(pane, "isConnected", { configurable: true, value: true });
  pane.presented = true;
  connectPaneTestView(pane);
  pane.requestUpdate();
  await pane.updateComplete;
  expect(pane.textContent).toContain(pane.paneId);
  updates.mockClear();
  pane.paneLabel = "reconnected revision";
  await pane.updateComplete;
  expect(updates).toHaveBeenCalledTimes(1);
  expect(pane.textContent).toContain("reconnected revision");
});
