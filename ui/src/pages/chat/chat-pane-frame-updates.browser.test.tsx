import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createSessionCapabilityFixture,
  createTestChatPane,
  connectPaneTestView,
  getPaneTestRuntime,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";

// mock-isolation: Exercise runtime commit cadence without initializing the full pane renderer.
vi.mock("./chat-pane-layout-view.tsx", () => import("./chat-pane-layout.test-support.tsx"));

function FrameLayout(props: { label?: string; id?: string; stream?: string | null }) {
  return (
    <>
      <span>{props.label}</span>
      <span>{props.id}</span>
      <output>{props.stream}</output>
    </>
  );
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

async function mountPane(
  presented = true,
  readProps: (pane: TestChatPane) => Parameters<typeof FrameLayout>[0] = (pane) => ({
    label: pane.history.catalogCursor ?? pane.paneLabel,
  }),
) {
  const { pane } = createTestChatPane({
    client: { request: vi.fn() } as unknown as GatewayBrowserClient,
    sessions: createSessionCapabilityFixture(),
  });
  // Use the existing lifecycle harness, with a small render to isolate cadence.
  Object.assign(pane, {
    render: () => ({
      layout: {
        component: FrameLayout,
        props: { id: pane.paneId, ...readProps(pane) },
      },
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

it("batches projected history and pane properties into one frame", async () => {
  const { pane, updates } = await mountPane();
  await task(() => {
    pane.history.catalogCursor = "projected history";
    pane.paneId = "projected-pane";
  });
  await pane.updateComplete;
  expect(pane.textContent).toContain("projected history");
  expect(pane.textContent).toContain("projected-pane");
  expect(updates).toHaveBeenCalledOnce();
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

it("renders a presented inactive split pane property without animation frames", async () => {
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const { pane, updates } = await mountPane();
  expect(pane.active).toBe(false);
  await task(() => {
    pane.paneLabel = "immediate property";
  });
  await pane.updateComplete;
  expect(updates).toHaveBeenCalledTimes(1);
  expect(pane.textContent).toContain("immediate property");
});

it("runs a DOM completion task without causing an unchanged pane to render", async () => {
  const { pane, updates } = await mountPane();
  const effect = vi.fn();
  const lifecycle = pane.chatState.createRenderLifecycle();
  lifecycle.afterCommit(effect);
  await pane.updateComplete;
  expect(effect).toHaveBeenCalledOnce();
  expect(updates).not.toHaveBeenCalled();
});

it("projects measured pane width without an explicit redraw request", async () => {
  const { pane, updates } = await mountPane(true, (current) => ({
    label: String(getPaneTestRuntime(current).paneWidth),
  }));
  await task(() => {
    getPaneTestRuntime(pane).paneWidth = 640;
  });
  await pane.updateComplete;
  expect(updates).toHaveBeenCalledOnce();
  expect(pane.textContent).toContain("640");
});

it("updates command intent without rendering ordinary composer keystrokes", async () => {
  const { pane, updates } = await mountPane();
  const state = pane.state;

  await task(() => state.handleChatDraftChange("ordinary input"));
  await pane.updateComplete;
  expect(updates).not.toHaveBeenCalled();
  await task(() => state.handleChatDraftChange("/stop"));
  await pane.updateComplete;
  expect(updates).toHaveBeenCalledOnce();
});

it("publishes comment attachments to the pane independently of ordinary draft changes", async () => {
  const { pane, updates } = await mountPane(true, (current) => ({
    label: current.state.chatAttachments
      .map((attachment) => attachment.selectionAnnotation?.comment)
      .join(" "),
  }));
  const state = pane.state;
  const { onAttachmentsChange } = getPaneTestRuntime(pane).chatState.attachmentInputProps(state);
  const attachment = {
    id: "frame-comment",
    mimeType: "text/plain",
    dataUrl: "data:text/plain;base64,Y29tbWVudA==",
    selectionAnnotation: {
      sessionKey: state.sessionKey,
      text: "Selected text",
      start: 0,
      end: 13,
      comment: "First comment",
    },
  };
  await task(() => onAttachmentsChange([attachment]));
  await pane.updateComplete;
  expect(pane.textContent).toContain("First comment");
  expect(updates).toHaveBeenCalledOnce();

  await task(() => state.handleChatDraftChange("ordinary draft"));
  await pane.updateComplete;
  expect(updates).toHaveBeenCalledOnce();

  await task(() =>
    onAttachmentsChange([
      {
        ...attachment,
        selectionAnnotation: { ...attachment.selectionAnnotation, comment: "Edited comment" },
      },
    ]),
  );
  await pane.updateComplete;
  expect(pane.textContent).toContain("Edited comment");
  expect(pane.textContent).not.toContain("First comment");
  expect(updates).toHaveBeenCalledTimes(2);

  await task(() => onAttachmentsChange([]));
  await pane.updateComplete;
  expect(pane.textContent).not.toContain("Edited comment");
  expect(updates).toHaveBeenCalledTimes(3);
});

it("keeps an unpresented pane parked when the document becomes visible", async () => {
  let visibility: DocumentVisibilityState = "hidden";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  const { pane, updates } = await mountPane(false);
  pane.paneLabel = "parked while hidden";
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
  const { pane, updates } = await mountPane(true, (current) => ({
    label: current.paneLabel,
    stream: current.state.chatStream,
  }));
  const state = pane.state;
  chatRunPresentation(state).batch(() => {
    state.chatStream = "First stream revision";
  }, "animation-frame");
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

  chatRunPresentation(state).batch(() => {
    state.chatStream = "Next stream revision";
  }, "animation-frame");
  frames.get(state.chatStreamRenderFrame!)?.(0);
  await task(() => {});
  await pane.updateComplete;
  expect(updates).toHaveBeenCalledTimes(2);
  expect(pane.textContent).toContain("Next stream revision");
});

it("releases a disconnected pane's parked update and renders after reconnect", async () => {
  const { pane, updates } = await mountPane(false);
  pane.paneLabel = "parked before disconnect";
  await task(() => {});
  Object.defineProperty(pane, "isConnected", { configurable: true, value: false });
  pane.disconnectedCallback();
  await pane.updateComplete;
  expect(updates).not.toHaveBeenCalled();
  Object.defineProperty(pane, "isConnected", { configurable: true, value: true });
  pane.presented = true;
  connectPaneTestView(pane);
  await pane.updateComplete;
  expect(pane.textContent).toContain(pane.paneId);
  updates.mockClear();
  pane.paneLabel = "reconnected revision";
  await pane.updateComplete;
  expect(updates).toHaveBeenCalledTimes(1);
  expect(pane.textContent).toContain("reconnected revision");
});
