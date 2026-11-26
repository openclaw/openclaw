/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, onTestFinished } from "vitest";
import { LoadingState } from "../../components/solid/loading-state.tsx";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
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

it("keeps the pre-history chat shell neutral without removing its composer", () => {
  const { container } = mountSolid(() => <LoadingState route composer />);
  expect(container.querySelector(".loading-skeleton__message")).toBeNull();
  expect(container.querySelector(".loading-skeleton__composer")).not.toBeNull();
});

it.each([false, true])(
  "retains the pending transcript across pane publications (cached rows: %s)",
  async (cached) => {
    const messages = [{ role: "assistant", content: "Saved conversation", timestamp: 1 }];
    const props = createChatProps({
      selectedSession: { key: "agent:main:main", kind: "direct", updatedAt: 1, hasMessages: true },
      loading: true,
      routeLoadingSkeleton: true,
      messages: cached ? messages : [],
      mobileComposer: false,
    });
    const container = createComposerContainer();
    const observer = new MutationObserver(countMounts);
    observer.observe(container, { childList: true, subtree: true });
    onTestFinished(() => observer.disconnect());
    const loaders = new Set<Element>();
    function countMounts(records = observer.takeRecords()) {
      for (const mutation of records) {
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
    }
    renderChatPropsInto(container, props);
    await waitForSolid(() =>
      expect(
        container.querySelector(cached ? ".chat-virtual-row" : ".lazy-view-state--loading"),
      ).not.toBeNull(),
    );
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

it.each([false, undefined])(
  "keeps empty or unknown history neutral during construction (%s)",
  async (hasMessages) => {
    const container = createComposerContainer();
    const selector =
      ".chat-conversation-loading, .loading-skeleton, openclaw-panel-loading-skeleton";
    let sawPlaceholder = false;
    const observer = new MutationObserver((records) => {
      sawPlaceholder ||= records.some(({ addedNodes }) =>
        [...addedNodes].some(
          (node) =>
            node instanceof Element &&
            (node.matches(selector) || node.querySelector(selector) !== null),
        ),
      );
    });
    observer.observe(container, { childList: true, subtree: true });
    onTestFinished(() => observer.disconnect());
    renderChatPropsInto(
      container,
      createChatProps({
        loading: true,
        selectedSession: { key: "agent:main:main", kind: "direct", updatedAt: 1, hasMessages },
        messages: [],
      }),
    );
    await waitForSolid(() => expect(container.querySelector(".chat-thread-inner")).not.toBeNull());
    expect(sawPlaceholder).toBe(false);
    expect(container.querySelector(selector)).toBeNull();
  },
);

it("does not announce saved history as a new reply after a neutral loading frame", async () => {
  const container = createComposerContainer();
  const props = createChatProps({ loading: true, messages: [] });
  renderChatPropsInto(container, props);
  await waitForSolid(() => expect(container.querySelector(".chat-thread-inner")).not.toBeNull());
  const messages = [{ role: "assistant", content: "Saved conversation", timestamp: 1 }];
  renderChatPropsInto(container, { ...props, loading: false, messages });
  await waitForSolid(() =>
    expect(container.querySelector(".chat-text")?.textContent).toContain("Saved conversation"),
  );
  expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe("");

  renderChatPropsInto(container, {
    ...props,
    loading: false,
    messages: [...messages, { role: "assistant", content: "New reply", timestamp: 2 }],
  });
  await waitForSolid(() =>
    expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe("New reply"),
  );
});
