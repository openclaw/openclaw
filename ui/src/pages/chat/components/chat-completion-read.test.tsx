/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../../app/context-types.ts";
import { ApplicationProvider } from "../../../lib/reactive/context.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { createChatCompletionReadRef } from "./chat-completion-read.ts";
import type { GroupedMessageOptions } from "./chat-message-bubble-options.ts";
import { TranscriptReadPresentation } from "./chat-transcript-read-presentation.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("admits a persisted final only when its source bubble is presented and intersecting", () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const deliveries: Array<(visible: boolean) => void> = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "0px";
      readonly scrollMargin = "0px";
      readonly thresholds = [0];
      targets = new Set<Element>();
      constructor(readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.targets.add(target);
        deliveries.push((visible) => {
          if (this.targets.has(target)) {
            this.callback(
              [
                {
                  target,
                  isIntersecting: visible,
                  intersectionRect: { width: visible ? 20 : 0, height: visible ? 20 : 0 },
                } as IntersectionObserverEntry,
              ],
              this,
            );
          }
        });
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
      takeRecords() {
        return [];
      }
    },
  );
  const viewed = vi.fn();
  const app = { webPush: { viewed } } as unknown as ApplicationContext;
  const [presented, setPresented] = createSignal(false);
  const [restrictions, setRestrictions] = createSignal<Partial<GroupedMessageOptions>>({});
  const [message, setMessage] = createSignal({
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "Done" }],
    __openclaw: { id: "row-1", runId: "run-1", idempotencyKey: "final-key" },
  });
  const Bubble = () => {
    const ref = createChatCompletionReadRef(message, () => ({
      agentId: "a",
      sessionKey: "agent:a:s",
      isStreaming: false,
      showReasoning: false,
      presented: presented(),
      transcriptVisible: presented(),
      ...restrictions(),
    }));
    return <div ref={ref}>Done</div>;
  };
  const mounted = mountSolid(() => (
    <ApplicationProvider value={app}>
      <TranscriptReadPresentation value={() => true}>
        <Bubble />
      </TranscriptReadPresentation>
    </ApplicationProvider>
  ));
  try {
    flush();
    expect(deliveries).toHaveLength(0);
    setPresented(true);
    flush();
    expect(deliveries.length).toBeGreaterThan(0);
    deliveries.at(-1)!(false);
    expect(viewed).not.toHaveBeenCalled();
    deliveries.at(-1)!(true);
    expect(viewed).toHaveBeenCalledWith(
      {
        agentId: "a",
        sessionKey: "agent:a:s",
        runId: "run-1",
        messageId: "key:final-key",
      },
      expect.any(Function),
    );
    const stillPresented = viewed.mock.calls[0][1];
    deliveries.at(-1)!(false);
    expect(stillPresented()).toBe(false);
    setPresented(false);
    flush();
    expect(stillPresented()).toBe(false);
    viewed.mockClear();
    setPresented(true);
    for (const restriction of [
      { isStreaming: true },
      { isForwarded: true },
      { searchResult: true },
      { assistantMessageDisclosure: { expanded: false } },
    ]) {
      setRestrictions(restriction);
      flush();
      deliveries.forEach((deliver) => deliver(true));
      expect(viewed).not.toHaveBeenCalled();
    }
    setRestrictions({});
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    flush();
    deliveries.forEach((deliver) => deliver(true));
    expect(viewed).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    setMessage((current) => ({ ...current, stopReason: "toolUse" }));
    setPresented(true);
    flush();
    deliveries.forEach((deliver) => deliver(true));
    expect(viewed).not.toHaveBeenCalled();
  } finally {
    mounted.unmount();
  }
});
