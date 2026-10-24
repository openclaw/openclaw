import type { TranscriptsGetResult } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { meetingEntry } from "../../test-helpers/transcripts.test-support.ts";
import { button, meetingPage, mount } from "./meetings-page.test-support.tsx";

const waitForText = (page: Element, text: string) =>
  waitForSolid(() => expect(page.textContent).toContain(text));
let detail: TranscriptsGetResult;
const summarize = vi.fn<() => Promise<typeof meetingPage>>();
const request = vi.fn(async (method: string) =>
  method === "transcripts.list"
    ? { sessions: [detail.session], nextCursor: null }
    : method === "transcripts.summarize"
      ? summarize()
      : detail,
);
beforeEach(() => {
  detail = { ...meetingPage, summary: undefined };
  summarize.mockReset();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

it("generates on open, holds failures without retry loops, and retries explicitly", async () => {
  vi.useFakeTimers();
  const pending = deferred<typeof meetingPage>();
  const retry = deferred<typeof meetingPage>();
  detail.session = { ...meetingEntry, hasSummary: false };
  summarize.mockReturnValueOnce(pending.promise).mockReturnValueOnce(retry.promise);
  const { page } = mount(request, "?selector=meeting");
  await waitForText(page, "Generating meeting summary");
  await vi.advanceTimersByTimeAsync(9_000);
  expect(summarize).toHaveBeenCalledTimes(1);
  pending.reject(new Error("Summary provider unavailable"));
  await waitForText(page, "Summary provider unavailable");
  await vi.advanceTimersByTimeAsync(9_000);
  expect(summarize).toHaveBeenCalledTimes(1);
  button(page.querySelector(".transcripts-summary")!, "Retry").click();
  await waitForText(page, "Generating meeting summary");
  expect(page.textContent).not.toContain("Summary provider unavailable");
  expect(button(page, "Transcript").disabled).toBe(false);
  detail = meetingPage;
  retry.resolve(meetingPage);
  await waitForText(page, "Reader layout discussed.");
  await vi.advanceTimersByTimeAsync(15_000);
  expect(summarize).toHaveBeenCalledTimes(2);
  expect(page.textContent).not.toContain("Summary provider unavailable");
});

it("finishes replacement notes while a cancelled summary request remains unresolved", async () => {
  const retired = deferred<typeof meetingPage>();
  const replacement = deferred<typeof meetingPage>();
  summarize.mockReturnValueOnce(retired.promise).mockReturnValueOnce(replacement.promise);
  const { page, setSearch } = mount(request, "?selector=old");
  await waitForText(page, "Generating meeting summary");

  setSearch("?selector=new");
  await waitForSolid(() => expect(summarize).toHaveBeenCalledTimes(2));
  replacement.resolve({
    ...meetingPage,
    summary: { ...meetingPage.summary, markdown: "Current meeting notes" },
  });
  await waitForText(page, "Current meeting notes");
  expect(page.textContent).not.toContain("Generating meeting summary");

  retired.resolve({
    ...meetingPage,
    summary: { ...meetingPage.summary, markdown: "Retired meeting notes" },
  });
  await retired.promise;
  flush();
  expect(page.textContent).toContain("Current meeting notes");
  expect(page.textContent).not.toContain("Retired meeting notes");
});

it.each([
  ["read-only", "No summary is available yet."],
  ["silent", "No speech captured"],
  ["saved", "Reader layout discussed."],
])("does not generate notes for a %s reader", async (kind, expected) => {
  detail.summary = kind === "saved" ? meetingPage.summary : undefined;
  detail.session = { ...meetingEntry, utteranceCount: kind === "silent" ? 0 : 2 };
  const scopes = kind === "read-only" ? ["operator.read"] : ["operator.admin"];
  const { page } = mount(request, "?selector=meeting", scopes);
  await waitForSolid(() => expect(page.querySelector(".transcripts-summary")).not.toBeNull());
  expect(summarize).not.toHaveBeenCalled();
  expect(page.textContent).toContain(expected);
});

it.each(["selection", "client", "authorization"])("fences replaced %s", async (replacement) => {
  const pending = deferred<typeof meetingPage>();
  summarize.mockReturnValue(pending.promise);
  const { page, setSearch, snapshot, notify } = mount(request, "?selector=old");
  await waitForText(page, "Generating meeting summary");
  detail = meetingPage;
  if (replacement === "selection") {
    setSearch("?selector=new");
  } else if (replacement === "client") {
    snapshot.client = { request } as unknown as GatewayBrowserClient;
    notify();
  } else {
    snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.read"] },
    } as ApplicationGatewaySnapshot["hello"];
    notify();
  }
  await waitForText(page, "Reader layout discussed.");
  const late = { ...meetingPage.summary, markdown: "Late private notes" };
  pending.resolve({ ...meetingPage, summary: late });
  await pending.promise;
  flush();
  expect(page.textContent).not.toContain("Late private notes");
  expect(page.textContent).toContain("Reader layout discussed.");
});

it("keeps same-meeting tab navigation responsive while generating a summary", async () => {
  const pending = deferred<typeof meetingPage>();
  summarize.mockReturnValue(pending.promise);
  const { page, unmount } = mount(request, "?selector=meeting");
  try {
    await waitForText(page, "Generating meeting summary");
    button(page, "Transcript").click();
    await waitForSolid(() =>
      expect(page.querySelector("#transcript-reader-tab-text")?.getAttribute("aria-selected")).toBe(
        "true",
      ),
    );
    expect(page.textContent).toContain("Keep the reader quiet and readable.");
    button(page, "Summary").click();
    await waitForText(page, "Generating meeting summary");
    expect(summarize).toHaveBeenCalledTimes(1);
    pending.resolve(meetingPage);
    await waitForText(page, "Reader layout discussed.");
  } finally {
    unmount();
    pending.resolve(meetingPage);
  }
});
