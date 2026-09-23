import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { meetingEntry } from "../../test-helpers/transcripts.test-support.ts";
import { button, meetingPage, mount } from "./meetings-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("meeting summary generation", () => {
  it("generates missing notes on open, keeps failures visible without retry loops, and retries explicitly", async () => {
    vi.useFakeTimers();
    const pending = deferred<typeof meetingPage>();
    let generated = false;
    let attempts = 0;
    const missing = {
      ...meetingPage,
      summary: undefined,
      session: { ...meetingEntry, hasSummary: false },
    };
    const request = vi.fn(async (method: string) => {
      if (method === "transcripts.list") {
        return { sessions: [meetingEntry], nextCursor: null };
      }
      if (method === "transcripts.summarize") {
        if (++attempts === 1) {
          return pending.promise;
        }
        generated = true;
      }
      return generated ? meetingPage : missing;
    });
    const { page } = mount(request, "?selector=meeting");
    await vi.waitFor(() => expect(page.textContent).toContain("Generating meeting summary"));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(attempts).toBe(1);
    pending.reject(new Error("Summary provider unavailable"));
    await vi.waitFor(() => expect(page.textContent).toContain("Summary provider unavailable"));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(attempts).toBe(1);
    button(page.querySelector(".transcripts-summary")!, "Retry").click();
    await vi.waitFor(() => expect(page.textContent).toContain("Reader layout discussed."));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(attempts).toBe(2);
    expect(page.textContent).not.toContain("Summary provider unavailable");
  });

  it.each(["read-only", "silent", "saved"])(
    "does not generate notes for a %s meeting reader",
    async (kind) => {
      const detail = {
        ...meetingPage,
        summary: kind === "saved" ? meetingPage.summary : undefined,
        session: { ...meetingEntry, utteranceCount: kind === "silent" ? 0 : 2 },
      };
      const request = vi.fn(async (method: string) =>
        method === "transcripts.list" ? { sessions: [detail.session], nextCursor: null } : detail,
      );
      const { page } = mount(
        request,
        "?selector=meeting",
        kind === "read-only" ? ["operator.read"] : ["operator.admin"],
      );
      await vi.waitFor(() => expect(page.querySelector(".transcripts-summary")).not.toBeNull());
      expect(request.mock.calls.some(([method]) => method === "transcripts.summarize")).toBe(false);
      expect(page.textContent).toContain(
        kind === "saved"
          ? "Reader layout discussed."
          : kind === "silent"
            ? "No speech captured"
            : "No summary is available yet.",
      );
    },
  );

  it.each(["selection", "client", "authorization"])(
    "ignores summary generation after the %s changes",
    async (replacement) => {
      const pending = deferred<typeof meetingPage>();
      let replaced = false;
      const request = vi.fn(async (method: string) => {
        if (method === "transcripts.list") {
          return { sessions: [], nextCursor: null };
        }
        if (method === "transcripts.summarize") {
          return pending.promise;
        }
        return replaced ? meetingPage : { ...meetingPage, summary: undefined };
      });
      const { page, snapshot, notify } = mount(request, "?selector=old");
      await vi.waitFor(() => expect(page.textContent).toContain("Generating meeting summary"));
      replaced = true;
      if (replacement === "selection") {
        page.routeSearch = "?selector=new";
      } else if (replacement === "client") {
        snapshot.client = { request } as unknown as GatewayBrowserClient;
        notify();
      } else {
        snapshot.hello = {
          ...snapshot.hello,
          auth: { role: "operator", scopes: ["operator.read"] },
        } as ApplicationGatewaySnapshot["hello"];
        notify();
      }
      await vi.waitFor(() => expect(page.textContent).toContain("Reader layout discussed."));
      pending.resolve({
        ...meetingPage,
        summary: { ...meetingPage.summary, markdown: "Late private notes" },
      });
      await pending.promise;
      await page.updateComplete;
      expect(page.textContent).not.toContain("Late private notes");
      expect(page.textContent).toContain("Reader layout discussed.");
    },
  );
});
