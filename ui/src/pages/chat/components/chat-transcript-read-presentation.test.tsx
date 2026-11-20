/* @vitest-environment jsdom */
import { useContext } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../../app/context-types.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { createChatCompletionReadRef } from "./chat-completion-read.ts";
import { ChatTranscriptRenderer } from "./chat-transcript-layout-solid.tsx";
import type { TranscriptLayoutProps } from "./chat-transcript-layout.ts";
import { footprintLayout, mountedVirtualizer } from "./chat-transcript-layout.test-support.ts";
import { createTranscriptMessageElements } from "./chat-transcript-message-elements.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it("admits reads only from settled active rows, not hidden or resource-preparing rows", () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const deliveries: Array<() => void> = [];
  vi.stubGlobal(
    "IntersectionObserver",
    vi.fn(function (callback: IntersectionObserverCallback) {
      const observer = {
        observe(target: Element) {
          // Keep callbacks after unobserve to exercise already-queued deliveries.
          deliveries.push(() =>
            callback(
              [
                {
                  target,
                  isIntersecting: true,
                  intersectionRect: { width: 20, height: 20 },
                } as IntersectionObserverEntry,
              ],
              observer as unknown as IntersectionObserver,
            ),
          );
        },
        unobserve() {},
        disconnect() {},
        takeRecords: () => [],
      };
      return observer;
    }),
  );
  const viewed = vi.fn();
  const app = { webPush: { viewed } } as unknown as ApplicationContext;
  const renderer = new ChatTranscriptRenderer();
  const { layout } = footprintLayout();
  const virtual = mountedVirtualizer(layout);
  let pending = true;
  const Bubble = () => {
    const preparing = useContext(ContentPresentation);
    const ref = createChatCompletionReadRef(
      () => ({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Done" }],
        __openclaw: { id: "row", runId: "run", idempotencyKey: "final" },
      }),
      () => ({
        agentId: "a",
        sessionKey: "agent:a:s",
        isStreaming: false,
        showReasoning: false,
        presented: true,
        transcriptVisible: true,
      }),
    );
    return (
      <div ref={ref} data-resource-presented={String(preparing())}>
        Done
      </div>
    );
  };
  let snapshot: TranscriptLayoutProps = {
    applicationContext: app,
    messageElements: createTranscriptMessageElements(() => undefined),
    rows: [{ kind: "item", key: "row", item: null }],
    getContent: () => () => <Bubble />,
    activeRowKeys: new Set(["row"]),
    virtualizer: virtual.instance,
    overlay: null,
    header: null,
    scrollElementRef: () => {},
    captureInteractionResize: () => {},
    measureRowRefFor: () => () => {},
    initialPositionPending: () => pending,
    layout,
    headerHeight: 0,
    presented: true,
    onCommit: () => {},
  };
  const element = renderer.render(snapshot);
  document.body.append(element);
  renderer.connect();
  try {
    flush();
    expect(element.style.visibility).toBe("hidden");
    expect(element.querySelector('[data-resource-presented="true"]')).not.toBeNull();
    expect(deliveries).toHaveLength(0);

    pending = false;
    renderer.syncInitialPosition();
    flush();
    expect(element.style.visibility).toBe("");
    expect(deliveries.length).toBeGreaterThan(0);
    deliveries.at(-1)!();
    expect(viewed).toHaveBeenCalledTimes(1);
    const stillPresented = viewed.mock.calls[0][1];
    viewed.mockClear();

    for (const preparation of [
      { preparingRowKey: "row" },
      { forecastRowKeys: new Set(["row"]) },
    ]) {
      snapshot = { ...snapshot, ...preparation, activeRowKeys: new Set() };
      renderer.render(snapshot);
      expect(stillPresented()).toBe(false); // Owner fences before Solid flush.
      deliveries.forEach((deliver) => deliver());
      flush();
      expect(element.querySelector('[data-resource-presented="true"]')).not.toBeNull();
      expect(viewed).not.toHaveBeenCalled();
    }

    snapshot = { ...snapshot, activeRowKeys: new Set(["row"]) };
    renderer.render(snapshot);
    flush();
    deliveries.at(-1)!();
    expect(viewed).toHaveBeenCalledTimes(1);
    viewed.mockClear();
    pending = true;
    renderer.syncInitialPosition();
    deliveries.forEach((deliver) => deliver());
    expect(viewed).not.toHaveBeenCalled();
    pending = false;
    renderer.syncInitialPosition();
    flush();

    snapshot = { ...snapshot, presented: false };
    renderer.render(snapshot);
    deliveries.forEach((deliver) => deliver());
    expect(viewed).not.toHaveBeenCalled();
    renderer.dispose();
    deliveries.forEach((deliver) => deliver());
    expect(viewed).not.toHaveBeenCalled();
  } finally {
    renderer.dispose();
    element.remove();
    virtual.dispose();
    layout.disconnect();
  }
});
