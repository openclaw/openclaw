/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  expectedEmbedUrl,
  mount,
  resetDiscussionPanelTestState,
  type SessionDiscussionInfoLoader,
  type SessionDiscussionOpener,
  type SessionDiscussionStateListener,
} from "./session-discussion-panel.test-support.ts";

afterEach(resetDiscussionPanelTestState);

function emptyStateText(panel: HTMLElement): string {
  const empty = panel.querySelector("openclaw-panel-empty-state");
  expect(empty).not.toBeNull();
  return empty!.textContent ?? "";
}
const frame = (panel: HTMLElement) => panel.querySelector<HTMLIFrameElement>("iframe");
const expectFrame = (panel: HTMLElement, url: string) =>
  vi.waitFor(() => expect(frame(panel)?.getAttribute("src")).toBe(expectedEmbedUrl(url)));
const skeleton = (panel: HTMLElement) =>
  panel.querySelector('openclaw-panel-loading-skeleton[data-panel-skeleton="discussion"]');
const openInfo = (embedUrl: string) => ({ state: "open" as const, embedUrl });

describe("session discussion panel", () => {
  it("does not render a skeleton without a loadable discussion", async () => {
    const panel = document.createElement("openclaw-session-discussion") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    document.body.append(panel);
    onTestFinished(() => panel.remove());
    await panel.updateComplete;
    expect(panel.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
  });

  it("opens once write access is granted after the discussion resolved", async () => {
    const openDiscussion = vi.fn<SessionDiscussionOpener>().mockResolvedValue({
      state: "open",
      embedUrl: "https://clack.example.com/embed/channel/T1/C1",
    });
    const panel = mount({
      loadInfo: vi.fn().mockResolvedValue({ state: "available" }),
      openDiscussion,
      canOpen: false,
      presentation: "desktop",
    });
    await vi.waitFor(async () => {
      expect(emptyStateText(panel)).toContain("Operator write access is required");
    });
    expect(openDiscussion).not.toHaveBeenCalled();
    expect(panel.querySelector("button")).toBeNull();

    panel.canOpen = true;

    await vi.waitFor(() => expect(openDiscussion).toHaveBeenCalledTimes(1));
  });

  it("preserves a held discussion read and frame theme updates across same-turn moves", async () => {
    const result = Promise.withResolvers<ReturnType<typeof openInfo>>();
    const loadInfo = vi.fn<SessionDiscussionInfoLoader>().mockReturnValue(result.promise);
    const panel = mount({ loadInfo, openDiscussion: vi.fn() });
    await vi.waitFor(() => expect(loadInfo).toHaveBeenCalledTimes(1));

    panel.remove();
    document.body.append(panel);
    await Promise.resolve();
    result.resolve(openInfo("https://discussion.example/retained"));
    await expectFrame(panel, "https://discussion.example/retained");
    const retainedFrame = frame(panel)!;
    panel.remove();
    document.body.append(panel);
    await Promise.resolve();
    const postMessage = vi.spyOn(retainedFrame.contentWindow!, "postMessage");

    document.documentElement.dataset.themeMode = "light";

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "openclaw:widget-theme", mode: "light" }),
        "https://discussion.example",
      );
    });
    expect(frame(panel)).toBe(retainedFrame);
    expect(loadInfo).toHaveBeenCalledTimes(1);
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
      expect(onStateChange).toHaveBeenLastCalledWith("agent:main:second", "none", null);
    });
    expect(panel.querySelector("button")).toBeNull();
    expect(panel.querySelector("iframe")).toBeNull();
  });

  it("replaces source-owned content when the gateway generation changes", async () => {
    const loadInfo = vi
      .fn<SessionDiscussionInfoLoader>()
      .mockResolvedValueOnce(openInfo("https://old.example/embed/thread"))
      .mockResolvedValueOnce(openInfo("https://new.example/embed/thread"));
    const panel = mount({ loadInfo, openDiscussion: vi.fn() });
    await expectFrame(panel, "https://old.example/embed/thread");

    panel.sourceGeneration += 1;

    await expectFrame(panel, "https://new.example/embed/thread");
    expect(loadInfo).toHaveBeenCalledTimes(2);
  });

  it("ignores an in-flight open result after the session changes", async () => {
    const firstOpen = Promise.withResolvers<ReturnType<typeof openInfo>>();
    const loadInfo = vi
      .fn<SessionDiscussionInfoLoader>()
      .mockResolvedValueOnce({ state: "available" })
      .mockResolvedValueOnce({ state: "none" });
    const openDiscussion = vi.fn<SessionDiscussionOpener>().mockReturnValueOnce(firstOpen.promise);
    const panel = mount({ loadInfo, openDiscussion });
    await vi.waitFor(() => expect(openDiscussion).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(skeleton(panel)?.getAttribute("aria-label")).toBe("Opening discussion…"),
    );
    panel.sessionKey = "agent:main:second";

    await vi.waitFor(() => {
      expect(loadInfo).toHaveBeenCalledTimes(2);
    });
    firstOpen.resolve(openInfo("https://discussion.example/stale"));
    await panel.updateComplete;

    expect(openDiscussion).toHaveBeenCalledTimes(1);
    expect(panel.querySelector("iframe")).toBeNull();
    expect(skeleton(panel)).toBeNull();
  });

  it("does not auto-open a superseded available resolution", async () => {
    const firstLoad = Promise.withResolvers<{ state: "available" }>();
    const loadInfo = vi
      .fn<SessionDiscussionInfoLoader>()
      .mockReturnValueOnce(firstLoad.promise)
      .mockResolvedValueOnce({ state: "none" });
    const openDiscussion = vi.fn<SessionDiscussionOpener>();
    const panel = mount({ loadInfo, openDiscussion });
    await vi.waitFor(() => expect(loadInfo).toHaveBeenCalledTimes(1));

    panel.sessionKey = "agent:main:second";
    await vi.waitFor(() => expect(loadInfo).toHaveBeenCalledTimes(2));
    firstLoad.resolve({ state: "available" });
    await panel.updateComplete;

    expect(openDiscussion).not.toHaveBeenCalled();
  });

  it("does not open after the available-state callback revokes write access", async () => {
    const openDiscussion = vi.fn<SessionDiscussionOpener>();
    const panel = mount({
      loadInfo: vi.fn().mockResolvedValue({ state: "available" }),
      openDiscussion,
      onStateChange: () => {
        panel.canOpen = false;
      },
    });

    await vi.waitFor(() => expect(panel.canOpen).toBe(false));
    expect(openDiscussion).not.toHaveBeenCalled();
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

    await vi.waitFor(async () => {
      expect(emptyStateText(panel)).toContain("cannot be embedded");
    });
    expect(panel.querySelector("iframe")).toBeNull();
    expect(panel.querySelector("a")).toBeNull();
  });

  it("recovers a failed discussion read when its source is replaced", async () => {
    const loadInfo = vi
      .fn<SessionDiscussionInfoLoader>()
      .mockRejectedValueOnce(new Error("Discussion provider unavailable"))
      .mockResolvedValueOnce(openInfo("https://discussion.example/recovered"));
    const panel = mount({ loadInfo, openDiscussion: vi.fn() });
    await vi.waitFor(() => {
      expect(panel.querySelector(".callout.danger")?.textContent).toContain(
        "Discussion provider unavailable",
      );
    });

    panel.sourceGeneration += 1;

    await expectFrame(panel, "https://discussion.example/recovered");
    expect(panel.querySelector(".callout.danger")).toBeNull();
    expect(loadInfo).toHaveBeenCalledTimes(2);
  });
});
