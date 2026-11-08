/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, onTestFinished } from "vitest";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { createChatProps, renderChatPropsInto } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

it.each([false, true])(
  "retains the pending transcript across pane publications (cached rows: %s)",
  (cached) => {
    const messages = [{ role: "assistant", content: "Saved conversation", timestamp: 1 }];
    const props = createChatProps({
      loading: true,
      routeLoadingSkeleton: true,
      messages: cached ? messages : [],
      mobileComposer: false,
    });
    const container = createComposerContainer();
    const observer = new MutationObserver(() => {});
    observer.observe(container, { childList: true, subtree: true });
    onTestFinished(() => observer.disconnect());
    const loaders = new Set<Element>();
    const countMounts = () => {
      for (const mutation of observer.takeRecords()) {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) {
            if (node.matches(".lazy-view-state--loading")) {
              loaders.add(node);
            }
            for (const loader of node.querySelectorAll(".lazy-view-state--loading")) {
              loaders.add(loader);
            }
          }
        }
      }
    };
    renderChatPropsInto(container, props);
    countMounts();
    const thread = container.querySelector(".chat-thread");
    const skeleton = container.querySelector(".lazy-view-state--loading");
    expect(Boolean(skeleton)).toBe(!cached);
    for (let reply = 0; reply < 24; reply += 1) {
      renderChatPropsInto(container, { ...props, assistantName: `Agent ${reply}` });
      countMounts();
    }
    expect(loaders.size).toBe(cached ? 0 : 1);
    expect(container.querySelector(".chat-thread")).toBe(thread);
    expect(container.querySelector(".lazy-view-state--loading")).toBe(skeleton);
    if (cached) {
      expect(container.querySelector(".chat-virtual-row")).not.toBeNull();
    } else {
      renderChatPropsInto(container, { ...props, mobileComposer: true });
      expect(container.querySelector(".chat-conversation-loading")).not.toBeNull();
      expect(container.querySelector(".lazy-view-state--loading")).toBeNull();
    }
  },
);
