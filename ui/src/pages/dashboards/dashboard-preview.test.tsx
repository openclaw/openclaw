/* @vitest-environment jsdom */

import { createSignal, Show } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { stubManualIntersectionObserver } from "../chat/components/chat-media-observer.test-support.ts";
import { DashboardPreview } from "./dashboard-preview.tsx";

// mock-isolation: Exercise the lazy error boundary without registering the Board renderer or its providers.
vi.mock("../../components/board/board-document.tsx", () => ({
  OpenClawBoardDocument() {
    throw new Error("Preview unavailable");
  },
}));

afterEach(() => {
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
