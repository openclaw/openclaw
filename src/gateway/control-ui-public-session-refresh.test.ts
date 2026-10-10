import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { PUBLIC_SESSION_ENTRY_SCRIPT } from "./control-ui-public-session-render.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  const listeners = new Map<string, () => void>();
  let enabled = true;
  const replaceWith = vi.fn((next: { enabled: boolean }) => {
    enabled = next.enabled;
  });
  const clearPending = vi.fn();
  const document = {
    hidden: false,
    title: "Before",
    getElementById: () => null,
    // The copy-control enhancer scans the document and each refreshed main; this stub has no code blocks.
    querySelectorAll: () => [],
    querySelector: (selector: string) =>
      selector.includes("entry-pending")
        ? null
        : selector.includes("refresh")
          ? enabled
            ? {}
            : null
          : { replaceWith },
    addEventListener: (name: string, callback: () => void) => {
      listeners.set(name, callback);
    },
  };
  const fetch = vi.fn<typeof globalThis.fetch>();
  const response = (status: number, body = "updated", etag = '"revision-1"') =>
    new Response(status === 304 ? null : body, { status, headers: { ETag: etag } });
  fetch.mockResolvedValue(response(200));
  runInNewContext(PUBLIC_SESSION_ENTRY_SCRIPT, {
    document,
    fetch,
    location: { href: "https://example.test/chat/main/topic" },
    Math: { random: () => 0.5, floor: Math.floor, max: Math.max },
    Number,
    Date,
    AbortSignal,
    setTimeout,
    clearTimeout,
    DOMParser: class {
      parseFromString(body: string) {
        return {
          title: body,
          querySelector: () => ({
            enabled: body !== "revoked",
            hasAttribute: () => body === "revoked",
            removeAttribute: clearPending,
            querySelectorAll: () => [],
            querySelector: () => ({ textContent: "Conversation unavailable" }),
          }),
        };
      }
    },
  });
  const visibility = (hidden: boolean) => {
    document.hidden = hidden;
    listeners.get("visibilitychange")?.();
  };
  return { document, fetch, response, replaceWith, visibility, clearPending };
}

describe("public reader refresh lifecycle", () => {
  it("jitters conditional reads, retains ETag manually, and catches up only when visible", async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.document.title).toBe("updated");
    f.fetch.mockResolvedValue(f.response(304));
    await vi.advanceTimersByTimeAsync(16500);
    expect(f.fetch).toHaveBeenLastCalledWith(
      "https://example.test/chat/main/topic",
      expect.objectContaining({
        cache: "no-store",
        redirect: "error",
        headers: { "If-None-Match": '"revision-1"' },
      }),
    );
    expect(f.replaceWith).toHaveBeenCalledTimes(1);
    f.visibility(true);
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    f.visibility(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetch).toHaveBeenCalledTimes(3);
  });
  it("replaces a revoked publication with the generic login page and stops polling", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(f.response(404, "revoked"));
    await vi.advanceTimersByTimeAsync(16500);
    expect(f.document.title).toBe("Conversation unavailable · OpenClaw");
    expect(f.clearPending).toHaveBeenCalledExactlyOnceWith("data-entry-pending");
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("does not publish a read that settles after the tab becomes hidden", async () => {
    const f = fixture();
    const pending = createDeferred<Response>();
    f.fetch.mockReturnValue(pending.promise);
    await vi.advanceTimersByTimeAsync(16500);
    f.visibility(true);
    pending.resolve(f.response(200));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.replaceWith).not.toHaveBeenCalled();
    expect(f.document.title).toBe("Before");
  });
  it("honors Retry-After without replacing the readable transcript", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(
      new Response("busy", { status: 429, headers: { "Retry-After": "60" } }),
    );
    await vi.advanceTimersByTimeAsync(16500);
    f.visibility(true);
    f.visibility(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.document.title).toBe("Before");
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
});
