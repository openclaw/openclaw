import { flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatDetailsDesktopContent } from "./chat-details-desktop-body.tsx";
import { loadChatDetailsDesktopComposition } from "./chat-details-desktop-loader.ts";
import type { ChatDetailsProps } from "./chat-details-types.ts";

function mount(overrides: Partial<ChatDetailsProps> = {}, cachedReady = true) {
  const container = document.body.appendChild(document.createElement("div"));
  const chat: ChatDetailsProps = {
    sessionKey: "agent:main:cached-details-scroll",
    currentAgentId: "main",
    selectedSession: undefined,
    messages: [],
    cachedDetails: { locale: "en", environment: { branch: "feature/cached", worktree: false } },
    sessionFactsReady: false,
    detailsWorkspace: { root: "/workspace/details", label: "details", branch: "feature/cached" },
    ...overrides,
  };
  function Content(props: { chat: ChatDetailsProps }) {
    return (
      <ChatDetailsDesktopContent
        chat={props.chat}
        presented
        dismissed={false}
        cachedReady={cachedReady}
        progressMenuRef={() => {}}
        onHideProgress={() => {}}
      />
    );
  }
  const view = mountSolid(Content, { chat }, container);
  onTestFinished(() => {
    view.dispose();
    container.remove();
  });
  return {
    ...view,
    chat,
    body: container.querySelector<HTMLDivElement>(".chat-details-desktop-body")!,
  };
}

function trackHandoffReads(body: HTMLDivElement) {
  const content = body.querySelector<HTMLDivElement>(".chat-details-desktop-body__content")!;
  const reads = [
    vi.spyOn(body, "getBoundingClientRect"),
    vi.spyOn(content, "getBoundingClientRect"),
    vi.spyOn(body, "offsetWidth", "get"),
    vi.spyOn(body, "clientWidth", "get"),
  ];
  onTestFinished(() => reads.forEach((read) => read.mockRestore()));
  return reads;
}

async function nextFrame() {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  flush();
}

it("keeps the compact floor when first facts and Environment arrive together", async () => {
  await loadChatDetailsDesktopComposition();
  const view = mount(
    { cachedDetails: undefined, detailsWorkspace: undefined, sessionFactsReady: false },
    false,
  );
  await waitForSolid(() =>
    expect(view.container.querySelector(".chat-details-desktop-loading")).not.toBeNull(),
  );
  const floor = view.body.getBoundingClientRect().height;
  expect(floor).toBeGreaterThan(0);
  view.update({
    chat: {
      ...view.chat,
      sessionFactsReady: true,
      selectedSession: { key: view.chat.sessionKey, kind: "direct", sessionId: "arrived" },
      detailsWorkspace: { root: "/workspace/details", label: "details", branch: "feature/arrived" },
    },
  });
  await waitForSolid(() =>
    expect(view.container.querySelector(".chat-environment__branch-name")?.textContent).toBe(
      "feature/arrived",
    ),
  );
  const heights = [view.body.getBoundingClientRect().height];
  for (let frame = 0; frame < 20; frame++) {
    await nextFrame();
    heights.push(view.body.getBoundingClientRect().height);
  }
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(floor - 1);
  expect(heights.at(-1)).toBeGreaterThan(floor);
});

it("adds no handoff measurements or animations to cached and settled scrolling", async () => {
  // Cached admission resolves both real lazy modules before interaction measurement.
  await loadChatDetailsDesktopComposition();
  const animations = vi.spyOn(Element.prototype, "animate");
  onTestFinished(() => animations.mockRestore());
  // The shared browser graph may already have loaded these modules in another file.
  const prepared = mount();
  await waitForSolid(() =>
    expect(prepared.container.querySelector(".chat-environment__branch-name")?.textContent).toBe(
      "feature/cached",
    ),
  );
  await document.fonts.ready;
  await nextFrame();
  await nextFrame();
  prepared.dispose();
  const view = mount();
  expect(view.container.querySelector(".chat-environment__branch-name")?.textContent).toBe(
    "feature/cached",
  );
  const reads = trackHandoffReads(view.body);
  await nextFrame();
  view.body.dispatchEvent(new Event("scroll"));
  await nextFrame();
  view.update({
    chat: {
      ...view.chat,
      sessionFactsReady: true,
      detailsWorkspace: { root: "/workspace/details", label: "details", branch: "feature/updated" },
    },
  });
  await nextFrame();
  expect(view.container.querySelector(".chat-environment__branch-name")?.textContent).toBe(
    "feature/updated",
  );
  view.body.dispatchEvent(new Event("focusin"));
  for (const read of reads) {
    expect(read).not.toHaveBeenCalled();
  }
  expect(animations.mock.contexts.filter((element) => element === view.body)).toHaveLength(0);
  expect(view.body.style.height).toBe("");
});
