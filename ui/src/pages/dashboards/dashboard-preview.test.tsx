/* @vitest-environment jsdom */

import { createSignal, Show } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { stubManualIntersectionObserver } from "../chat/components/chat-media-observer.test-support.ts";
import { DashboardPreview } from "./dashboard-preview.tsx";

const failure = vi.hoisted(() => ({ message: "Preview unavailable" }));

// mock-isolation: Exercise the lazy error boundary without registering the Board renderer or its providers.
vi.mock("../../components/board/board-document.tsx", () => ({
  OpenClawBoardDocument() {
    throw new Error(failure.message);
  },
}));

afterEach(() => {
  failure.message = "Preview unavailable";
  cleanupSolid();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("resumes near-viewport rendering and its error boundary after being remounted", async () => {
  const observations: ((isIntersecting: boolean) => void)[] = [];
  stubManualIntersectionObserver((_target, notify) => observations.push(notify));
  let setVisible!: (value: boolean) => void;
  const { container } = mountSolid(() => {
    const [visible, set] = createSignal(true);
    setVisible = set;
    return (
      <Show when={visible()}>
        <DashboardPreview />
      </Show>
    );
  });

  for (const count of [1, 2]) {
    setVisible(true);
    flush();
    expect(observations).toHaveLength(count);
    expect(container.textContent).not.toContain("Preview unavailable");
    observations[count - 1]!(true);
    await waitForSolid(() => expect(container.textContent).toContain("Preview unavailable"));
    observations[count - 1]!(false);
    flush();
    expect(container.textContent).not.toContain("Preview unavailable");
    setVisible(false);
    flush();
    expect(container.textContent).not.toContain("Preview unavailable");
  }
});

it("shows reload guidance rather than an asset URL when the preview module fails", async () => {
  failure.message =
    "Failed to fetch dynamically imported module: https://example.test/assets/board-document-abcdef.js";
  let enter!: (isIntersecting: boolean) => void;
  stubManualIntersectionObserver((_target, notify) => {
    enter = notify;
  });
  const { container } = mountSolid(() => <DashboardPreview />);
  flush();
  enter(true);
  await waitForSolid(() =>
    expect(container.querySelector(".dashboard-preview__error")?.textContent).toBe(
      "Some interface files could not be downloaded. Check your connection, then reload.",
    ),
  );
});
