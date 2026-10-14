/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { SolidBridgeElement } from "../../lit/solid-bridge.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { DashboardPreviewProps } from "./dashboard-preview.tsx";
import "./dashboard-preview.ts";

type DashboardPreviewElement = SolidBridgeElement<DashboardPreviewProps>;

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("resumes near-viewport rendering after being detached and reattached", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  const element = document.createElement("openclaw-dashboard-preview") as DashboardPreviewElement;
  element.error = "Preview unavailable";

  document.body.append(element);
  await element.updateComplete;
  frames.shift()?.(0);
  flush();
  expect(element.textContent).toContain("Preview unavailable");

  element.remove();
  await Promise.resolve();
  flush();
  expect(element.textContent).not.toContain("Preview unavailable");

  document.body.append(element);
  await element.updateComplete;
  frames.shift()?.(0);
  flush();
  expect(element.textContent).toContain("Preview unavailable");
});
