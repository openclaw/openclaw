/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SessionDiscussionInfoLoader,
  SessionDiscussionOpener,
  SessionDiscussionStateListener,
} from "./session-discussion-panel.ts";
import "./session-discussion-panel.ts";

type DiscussionPanelElement = HTMLElement & {
  sessionKey: string;
  canOpen: boolean;
  loadInfo: SessionDiscussionInfoLoader;
  openDiscussion: SessionDiscussionOpener;
  onStateChange: SessionDiscussionStateListener;
  updateComplete: Promise<unknown>;
};

const panels: DiscussionPanelElement[] = [];

afterEach(() => {
  panels.splice(0).forEach((panel) => panel.remove());
});

function mount(params: {
  loadInfo: SessionDiscussionInfoLoader;
  openDiscussion: SessionDiscussionOpener;
  onStateChange?: SessionDiscussionStateListener;
}): DiscussionPanelElement {
  const panel = document.createElement("openclaw-session-discussion") as DiscussionPanelElement;
  panel.sessionKey = "agent:main:first";
  panel.loadInfo = params.loadInfo;
  panel.openDiscussion = params.openDiscussion;
  panel.onStateChange = params.onStateChange ?? vi.fn();
  document.body.append(panel);
  panels.push(panel);
  return panel;
}

describe("session discussion panel", () => {
  it("loads once, opens an available discussion, and renders both URLs", async () => {
    const loadInfo = vi.fn<SessionDiscussionInfoLoader>().mockResolvedValue({
      state: "available",
    });
    const openDiscussion = vi.fn<SessionDiscussionOpener>().mockResolvedValue({
      state: "open",
      embedUrl: "https://discussion.example/embed/thread",
      openUrl: "https://discussion.example/thread",
    });
    const panel = mount({ loadInfo, openDiscussion });

    await vi.waitFor(() => {
      expect(panel.querySelector("button")?.textContent).toContain("Open discussion");
    });
    expect(loadInfo).toHaveBeenCalledTimes(1);

    panel.querySelector<HTMLButtonElement>("button")?.click();

    await vi.waitFor(() => {
      expect(panel.querySelector("iframe")?.getAttribute("src")).toBe(
        "https://discussion.example/embed/thread",
      );
      expect(panel.querySelector("iframe")?.getAttribute("sandbox")).toBe(
        "allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts",
      );
    });
    const external = panel.querySelector<HTMLAnchorElement>("a");
    expect(openDiscussion).toHaveBeenCalledWith("agent:main:first");
    expect(external?.href).toBe("https://discussion.example/thread");
    expect(external?.target).toBe("_blank");
    expect(external?.rel).toBe("noopener");
  });

  it("refetches on session switch and reports a hidden discussion", async () => {
    const loadInfo = vi
      .fn<SessionDiscussionInfoLoader>()
      .mockResolvedValueOnce({ state: "available" })
      .mockResolvedValueOnce({ state: "none" });
    const onStateChange = vi.fn<SessionDiscussionStateListener>();
    const panel = mount({ loadInfo, openDiscussion: vi.fn(), onStateChange });
    await vi.waitFor(() => expect(loadInfo).toHaveBeenCalledTimes(1));

    panel.sessionKey = "agent:main:second";

    await vi.waitFor(() => {
      expect(loadInfo).toHaveBeenNthCalledWith(2, "agent:main:second");
      expect(onStateChange).toHaveBeenLastCalledWith("agent:main:second", "none");
    });
    expect(panel.querySelector("button")).toBeNull();
    expect(panel.querySelector("iframe")).toBeNull();
  });

  it("clears an in-flight open state when the session changes", async () => {
    const loadInfo = vi.fn<SessionDiscussionInfoLoader>().mockResolvedValue({
      state: "available",
    });
    const openDiscussion = vi
      .fn<SessionDiscussionOpener>()
      .mockImplementation(() => new Promise(() => {}));
    const panel = mount({ loadInfo, openDiscussion });
    await vi.waitFor(() => expect(panel.querySelector("button")?.disabled).toBe(false));

    panel.querySelector<HTMLButtonElement>("button")?.click();
    await vi.waitFor(() => expect(panel.querySelector("button")?.disabled).toBe(true));
    panel.sessionKey = "agent:main:second";

    await vi.waitFor(() => {
      expect(loadInfo).toHaveBeenCalledTimes(2);
      expect(panel.querySelector("button")?.disabled).toBe(false);
      expect(panel.querySelector("button")?.textContent).toContain("Open discussion");
    });
  });

  it("does not render non-HTTP discussion URLs", async () => {
    const panel = mount({
      loadInfo: vi.fn().mockResolvedValue({
        state: "open",
        embedUrl: "javascript:alert(1)",
        openUrl: "data:text/html,unsafe",
      }),
      openDiscussion: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(panel.textContent).toContain("cannot be embedded");
    });
    expect(panel.querySelector("iframe")).toBeNull();
    expect(panel.querySelector("a")).toBeNull();
  });
});
