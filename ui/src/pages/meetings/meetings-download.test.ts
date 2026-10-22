import { afterEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { meetingEntry } from "../../test-helpers/transcripts.test-support.ts";
import { button, meetingPage, mount } from "./meetings-page.test-support.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("finishes a replacement download while a cancelled export remains unresolved", async () => {
  const retired = deferred<unknown>();
  const replacement = deferred<unknown>();
  const request = vi.fn((method: string, params: { selector?: string }) => {
    if (method === "transcripts.export") {
      return params.selector === "old" ? retired.promise : replacement.promise;
    }
    return Promise.resolve(
      method === "transcripts.list"
        ? { sessions: [], nextCursor: null }
        : {
            ...meetingPage,
            session: {
              ...meetingEntry,
              title: params.selector === "old" ? "Retired meeting" : "Current meeting",
            },
          },
    );
  });
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
  const { page, setSearch } = mount(request, "?selector=old");
  await waitForSolid(() => expect(page.textContent).toContain("Retired meeting"));
  button(page, "Download Markdown").click();
  await waitForSolid(() => expect(page.textContent).toContain("Preparing download"));

  setSearch("?selector=new");
  await waitForSolid(() => expect(page.textContent).toContain("Current meeting"));
  await waitForSolid(() => expect(button(page, "Download Markdown").disabled).toBe(false));
  button(page, "Download Markdown").click();
  await waitForSolid(() => expect(page.textContent).toContain("Preparing download"));
  replacement.resolve({
    data: btoa("Current meeting notes"),
    filename: "current.md",
    mimeType: "text/markdown",
  });
  await waitForSolid(() => expect(page.textContent).toContain("Download started"));
  expect(button(page, "Download Markdown").disabled).toBe(false);
  expect(downloads).toEqual(["current.md"]);

  retired.resolve({
    data: btoa("Retired meeting notes"),
    filename: "retired.md",
    mimeType: "text/markdown",
  });
  await retired.promise;
  flush();
  expect(downloads).toEqual(["current.md"]);
  expect(page.textContent).toContain("Download started");
});

it("keeps same-meeting tab navigation responsive while exporting", async () => {
  const pending = deferred<unknown>();
  const request = vi.fn((method: string) =>
    method === "transcripts.export"
      ? pending.promise
      : Promise.resolve(
          method === "transcripts.list" ? { sessions: [], nextCursor: null } : meetingPage,
        ),
  );
  const { page, unmount } = mount(request, "?selector=meeting");
  try {
    await waitForSolid(() => expect(page.textContent).toContain("Reader layout discussed."));
    button(page, "Download Markdown").click();
    await waitForSolid(() => expect(page.textContent).toContain("Preparing download"));
    button(page, "Transcript").click();
    await waitForSolid(() =>
      expect(page.querySelector("#transcript-reader-tab-text")?.getAttribute("aria-selected")).toBe(
        "true",
      ),
    );
    expect(button(page, "Download Markdown").disabled).toBe(true);
    button(page, "Summary").click();
    await waitForSolid(() =>
      expect(
        page.querySelector("#transcript-reader-tab-summary")?.getAttribute("aria-selected"),
      ).toBe("true"),
    );
    expect(button(page, "Download Markdown").disabled).toBe(true);
    expect(request.mock.calls.filter(([method]) => method === "transcripts.export")).toHaveLength(
      1,
    );
  } finally {
    unmount();
    pending.resolve({ data: "", filename: "meeting.md", mimeType: "text/markdown" });
  }
});
