/* @vitest-environment jsdom */

import { createSignal, Show } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { DashboardPreview } from "./dashboard-preview.tsx";

afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
});

it("resumes near-viewport rendering after being unmounted and remounted", () => {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  let setVisible!: (value: boolean) => void;
  const { container } = mountSolid(() => {
    const [visible, set] = createSignal(true);
    setVisible = set;
    return (
      <Show when={visible()}>
        <DashboardPreview error="Preview unavailable" />
      </Show>
    );
  });

  flush();
  frames.shift()?.(0);
  flush();
  expect(container.textContent).toContain("Preview unavailable");

  setVisible(false);
  flush();
  expect(container.textContent).not.toContain("Preview unavailable");

  setVisible(true);
  flush();
  frames.shift()?.(0);
  flush();
  expect(container.textContent).toContain("Preview unavailable");
});
