import { flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatDetailsDesktopContent } from "./chat-details-desktop-body.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";

function mount(cachedReady = true) {
  const container = document.body.appendChild(document.createElement("div"));
  const chat: ChatDetailsProps = {
    sessionKey: "agent:main:cached-details-scroll",
    currentAgentId: "main",
    selectedSession: undefined,
    messages: [],
    cachedDetails: cachedReady
      ? { locale: "en", environment: { branch: "feature/cached", worktree: false } }
      : undefined,
    sessionFactsReady: !cachedReady,
    detailsWorkspace: { root: "/workspace/details", label: "details", branch: "feature/cached" },
  };
  function Content(props: { chat: ChatDetailsProps; cachedReady: boolean }) {
    return (
      <ChatDetailsDesktopContent
        chat={props.chat}
        presented
        dismissed={false}
        cachedReady={props.cachedReady}
        progressMenuRef={() => {}}
        onHideProgress={() => {}}
      />
    );
  }
  const view = mountSolid(Content, { chat, cachedReady }, container);
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

it("adds no handoff measurements or animations to cached and settled scrolling", async () => {
  const animations = vi.spyOn(Element.prototype, "animate");
  onTestFinished(() => animations.mockRestore());
  const prepared = mount(false);
  expect(prepared.container.querySelector("openclaw-panel-loading-skeleton")).not.toBeNull();
  await waitForSolid(() =>
    expect(prepared.container.querySelector(".chat-environment__branch-name")?.textContent).toBe(
      "feature/cached",
    ),
  );
  await document.fonts.ready;
  await nextFrame();
  await nextFrame();
  // Retargeting cancels the previous animation; wait for the real handoff to finish.
  for (
    let pending = prepared.body.getAnimations();
    pending.length;
    pending = prepared.body.getAnimations()
  ) {
    await Promise.all(
      pending.map((animation) =>
        animation.finished.catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            throw error;
          }
        }),
      ),
    );
    await nextFrame();
  }
  expect(
    animations.mock.contexts.filter((element) => element === prepared.body).length,
  ).toBeGreaterThan(0);
  const settledReads = trackHandoffReads(prepared.body);
  prepared.body.dispatchEvent(new Event("scroll"));
  await nextFrame();
  for (const read of settledReads) {
    expect(read).not.toHaveBeenCalled();
  }
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
    cachedReady: true,
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
