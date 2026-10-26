import { afterEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { meetingEntry } from "../../test-helpers/transcripts.test-support.ts";
import { button, meetingPage, mount } from "./meetings-page.test-support.tsx";

const waitForText = (page: Element, text: string) =>
  waitForSolid(() => expect(page.textContent).toContain(text));
const exported = (filename: string, text = "") => ({
  data: btoa(text),
  filename,
  mimeType: "text/markdown",
});
function requestFor(exportRequest: (selector?: string) => Promise<unknown>) {
  return vi.fn((method: string, params: { selector?: string }) => {
    if (method === "transcripts.export") {
      return exportRequest(params.selector);
    }
    if (method === "transcripts.list") {
      return Promise.resolve({ sessions: [], nextCursor: null });
    }
    return Promise.resolve({
      ...meetingPage,
      session: { ...meetingEntry, title: `Meeting ${params.selector}` },
    });
  });
}
function captureDownloads() {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = vi.fn(() => "blob:notes");
      static override revokeObjectURL = vi.fn();
    },
  );
  const downloads: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download);
  });
  return downloads;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("finishes a replacement download while a cancelled export remains unresolved", async () => {
  const retired = deferred<unknown>();
  const replacement = deferred<unknown>();
  const request = requestFor((selector) =>
    selector === "old" ? retired.promise : replacement.promise,
  );
  const downloads = captureDownloads();
  const { page, setSearch } = mount(request, "?selector=old");
  await waitForText(page, "Meeting old");
  button(page, "Download Markdown").click();
  await waitForText(page, "Preparing download");
  setSearch("?selector=new");
  await waitForText(page, "Meeting new");
  await waitForSolid(() => expect(button(page, "Download Markdown").disabled).toBe(false));
  button(page, "Download Markdown").click();
  await waitForText(page, "Preparing download");
  replacement.resolve(exported("current.md", "Current meeting notes"));
  await waitForText(page, "Download started");
  expect(downloads).toEqual(["current.md"]);
  retired.resolve(exported("retired.md", "Retired meeting notes"));
  await retired.promise;
  flush();
  expect(downloads).toEqual(["current.md"]);
  expect(page.textContent).toContain("Download started");
});

it("keeps export retries and tab navigation responsive without replacing notes or controls", async () => {
  const failed = deferred<unknown>();
  const retry = deferred<unknown>();
  let exports = 0;
  const request = requestFor(() => (++exports === 1 ? failed.promise : retry.promise));
  const downloads = captureDownloads();
  const { page, unmount } = mount(request, "?selector=meeting");
  try {
    await waitForText(page, "Reader layout discussed.");
    const control = button(page, "Download Markdown");
    const notes = page.querySelector(".meetings-notes");
    control.click();
    failed.reject(new Error("Export unavailable"));
    await waitForText(page, "Export unavailable");
    expect(button(page, "Download Markdown")).toBe(control);
    expect(control.disabled).toBe(false);
    control.click();
    await waitForText(page, "Preparing download");
    expect(page.textContent).not.toContain("Export unavailable");
    expect(page.querySelector(".meetings-notes")).toBe(notes);
    expect(button(page, "Download Markdown")).toBe(control);
    await waitForSolid(() => expect(control.disabled).toBe(true));
    for (const label of ["Transcript", "Summary"]) {
      const tab = button(page, label);
      tab.click();
      await waitForSolid(() => expect(tab.ariaSelected).toBe("true"));
      expect(control.disabled).toBe(true);
    }
    retry.resolve(exported("retry.md", "Saved notes"));
    await waitForText(page, "Download started");
    expect(control.disabled).toBe(false);
    expect(downloads).toEqual(["retry.md"]);
  } finally {
    unmount();
    retry.resolve(exported("retry.md"));
  }
});
