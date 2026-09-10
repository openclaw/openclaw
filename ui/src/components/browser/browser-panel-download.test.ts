import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  createBrowserClient,
  createBrowserPanelTestController,
  createView,
  setupBrowserPanelTestCleanup,
} from "./browser-panel-controller-test-support.ts";

setupBrowserPanelTestCleanup();

describe("Browser panel downloads", () => {
  const source = "https://assets.example.test/Design%20review.mp4?signature=fixture";
  const makePanel = () => {
    const { client } = createBrowserClient(async () => ({}));
    return createBrowserPanelTestController(client, "video-tab", source);
  };
  const content = new Blob(["complete video bytes"], { type: "video/mp4" });
  const response = () => ({ ok: true, url: source, blob: async () => content });
  const createObjectURL = vi.fn(() => "blob:https://ui.example.test/download");
  const revokeObjectURL = vi.fn();
  const fetchFile = vi.fn();
  let downloads: Array<{ href: string; filename: string }>;

  beforeEach(() => {
    downloads = [];
    vi.useFakeTimers();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    fetchFile.mockReset().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchFile);
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function (this: HTMLAnchorElement) {
        downloads.push({ href: this.href, filename: this.download });
      },
    );
  });

  it("downloads the displayed bytes and decoded filename without navigating to the URL draft", async () => {
    const panel = makePanel();
    const view = panel.view;
    panel.urlDraft = "https://different.example.test/unfinished";
    await panel.download.save();
    expect(fetchFile).toHaveBeenCalledWith(source, {
      signal: expect.any(AbortSignal),
      credentials: "same-origin",
    });
    expect(createObjectURL).toHaveBeenCalledWith(content);
    expect(downloads).toEqual([
      { href: "blob:https://ui.example.test/download", filename: "Design review.mp4" },
    ]);
    expect(panel.view).toBe(view);
    expect(panel.urlDraft).toBe("https://different.example.test/unfinished");
    expect(panel.noticeText).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:https://ui.example.test/download");
  });

  it.each(["loading", "new tab", "blank", "unavailable", "stale view"])(
    "does not download a %s document",
    async (state) => {
      const panel = makePanel();
      if (state === "loading") panel.loading = true;
      if (state === "new tab") panel.pendingNewTab = true;
      if (state === "blank") panel.view = createView("video-tab", "about:blank");
      if (state === "stale view") panel.activeTargetId = "other-tab";
      if (state === "unavailable") panel.view = null;
      expect(panel.download.available).toBe(false);
      await panel.download.save();
      expect(fetchFile).not.toHaveBeenCalled();
    },
  );

  it.each(["HTTP", "network"])(
    "shows %s failures without saving an error page and permits retry",
    async (failure) => {
      const panel = makePanel();
      if (failure === "HTTP") fetchFile.mockResolvedValueOnce({ ok: false, status: 403 });
      else fetchFile.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await panel.download.save();
      expect(downloads).toEqual([]);
      expect(panel.errorText).toContain("Could not download this file");
      expect(panel.errorText).toContain("open it in your browser");
      expect(panel.download.available).toBe(true);
      await panel.download.save();
      expect(downloads).toHaveLength(1);
      expect(panel.errorText).toBeNull();
    },
  );

  it.each(["tab switch", "navigation", "close", "body failure"])(
    "does not save incomplete or stale bytes after %s",
    async (change) => {
      const panel = makePanel();
      const body = createDeferred<Blob>();
      fetchFile.mockResolvedValue({ ...response(), blob: () => body.promise });
      const saving = panel.download.save();
      await Promise.resolve();
      expect(panel.download.pending).toBe(true);
      await panel.download.save();
      expect(fetchFile).toHaveBeenCalledTimes(1);
      if (change === "tab switch") panel.activeTargetId = "other-tab";
      if (change === "navigation") panel.view = createView("video-tab", "https://example.test/new");
      if (change === "close") panel.suspendView();
      if (change === "body failure") body.reject(new Error("Connection closed"));
      else body.resolve(content);
      await saving;
      expect(downloads).toEqual([]);
      expect(panel.download.pending).toBe(false);
      expect(panel.noticeText).toBeNull();
      if (change === "body failure") expect(panel.errorText).toContain("Connection closed");
      else expect(panel.errorText).toBeNull();
    },
  );
});
