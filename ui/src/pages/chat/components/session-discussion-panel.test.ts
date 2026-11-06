/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { mount, resetDiscussionPanelTestState } from "./session-discussion-panel.test-support.ts";

afterEach(resetDiscussionPanelTestState);

function mountOpen(embedUrl: string, openUrl?: string, presentation?: "desktop") {
  return mount({
    presentation,
    loadInfo: vi.fn().mockResolvedValue({ state: "open", embedUrl, openUrl }),
    openDiscussion: vi.fn(),
  });
}

it("preserves signed provider URLs even when their routes resemble ClickClack", async () => {
  const signedUrl =
    "https://discussion.example/embed/channel/a/b?signature=abc%2B123&expires=1785200000#thread";
  document.documentElement.dataset.themeMode = "light";
  const panel = mountOpen(signedUrl);
  await vi.waitFor(() =>
    expect(panel.querySelector<HTMLIFrameElement>("iframe")?.src).toBe(signedUrl),
  );
  const frame = panel.querySelector<HTMLIFrameElement>("iframe")!;
  expect(frame.getAttribute("sandbox")).toBe(
    "allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts",
  );
});

it("offers the valid open URL when a same-origin embed is rejected", async () => {
  const openUrl = "https://discussion.example/thread";
  const panel = mountOpen(
    new URL("/embed/thread", window.location.origin).href,
    openUrl,
    "desktop",
  );

  const empty = await vi.waitFor(() => {
    const candidate = panel.querySelector("openclaw-panel-empty-state");
    expect(candidate).not.toBeNull();
    return candidate!;
  });
  expect(empty.textContent).toContain("This discussion cannot be embedded");
  const external = panel.querySelector<HTMLAnchorElement>("a");
  expect(panel.querySelector("iframe")).toBeNull();
  expect(external?.textContent).toContain("Open discussion in a new tab");
  expect(external?.href).toBe(openUrl);
  expect(external?.target).toBe("_blank");
  expect(external?.rel).toBe("noopener");
});
