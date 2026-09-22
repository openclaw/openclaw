/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsSearchResult } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionsListResult } from "../api/types.ts";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import {
  createContext,
  createGateway,
  createSessionResult,
  enterQuery,
  findPaletteOption,
  mountPalette,
} from "./command-palette.test-support.ts";
import "./command-palette.ts";

describe("CommandPalette pending searches", () => {
  let restoreDialogPolyfill: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    restoreDialogPolyfill = installDialogPolyfill();
  });

  afterEach(() => {
    document.body.replaceChildren();
    restoreDialogPolyfill();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["match", "empty", "failure"])(
    "announces session search through debounce and deferred settlement: %s",
    async (outcome) => {
      const deferred = createDeferred<SessionsListResult | null>();
      const { gateway } = createGateway(true);
      const list = vi.fn(() => deferred.promise);
      const { palette } = await mountPalette(createContext(gateway, list));
      await enterQuery(palette, "zzfixtureunique");
      const results = palette.querySelector('[role="listbox"]')!;
      expect(results.getAttribute("aria-busy")).toBe("true");
      expect(palette.querySelector('[role="status"]')?.textContent).toContain("Searching sessions");
      expect(palette.textContent).not.toContain("No results");
      await vi.advanceTimersByTimeAsync(49);
      expect(list).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(list).toHaveBeenCalledOnce();
      expect(results.getAttribute("aria-busy")).toBe("true");
      expect(palette.querySelectorAll('[role="option"]')).toHaveLength(0);
      if (outcome === "failure") {
        deferred.reject(new Error("Search failed"));
      } else {
        deferred.resolve(
          outcome === "match"
            ? createSessionResult("agent:main:fixture", "zzfixtureunique session")
            : { ...createSessionResult("agent:main:fixture", "Unused"), sessions: [] },
        );
      }
      await vi.advanceTimersByTimeAsync(0);
      await palette.updateComplete;
      expect(results.getAttribute("aria-busy")).toBe("false");
      expect(palette.textContent).not.toContain("Searching sessions");
      if (outcome === "match") {
        findPaletteOption(palette, "zzfixtureunique session")!.click();
        expect(palette.onSelectSession).toHaveBeenCalledWith("agent:main:fixture");
      } else if (outcome === "empty") {
        expect(palette.textContent).toContain("No results");
      } else {
        expect(palette.textContent).toContain("Chat search failed");
        expect(palette.textContent).not.toContain("No results");
      }
    },
  );

  it("waits for uncached command sources without announcing a session search when unavailable", async () => {
    const catalog = createDeferred<{ models: { id: string; provider: string; name: string }[] }>();
    const request = vi.fn(() => catalog.promise);
    const { gateway } = createGateway(true, { request });
    const list = vi.fn(async () => null);
    const { palette } = await mountPalette(createContext(gateway, list));
    palette.onSelectSession = undefined;
    await enterQuery(palette, "zzcatalog");
    expect(palette.textContent).toContain("Searching commands");
    expect(palette.textContent).not.toContain("Searching sessions");
    await vi.advanceTimersByTimeAsync(50);
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("true");
    expect(palette.textContent).not.toContain("No results");
    const input = palette.querySelector("input")!;
    input.value = "z";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await palette.updateComplete;
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("true");
    expect(palette.textContent).not.toContain("No results");
    catalog.resolve({ models: [{ id: "fixture", provider: "fixture", name: "zzcatalog model" }] });
    await vi.advanceTimersByTimeAsync(0);
    await palette.updateComplete;
    expect(findPaletteOption(palette, "zzcatalog model")).toBeDefined();
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("false");
    await enterQuery(palette, "zzmissing");
    await vi.advanceTimersByTimeAsync(50);
    await palette.updateComplete;
    expect(palette.textContent).toContain("No results");
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("false");
    expect(request).toHaveBeenCalledOnce();
    expect(list).not.toHaveBeenCalled();
  });

  it("waits for the transcript source after metadata settles", async () => {
    const transcript = createDeferred<SessionsSearchResult>();
    const roster = createSessionResult("agent:main:fixture", "Unrelated title");
    const list = vi.fn<ApplicationContext<RouteId>["sessions"]["list"]>(async (options) =>
      options?.search ? { ...roster, sessions: [] } : roster,
    );
    const { gateway } = createGateway(true, {
      methods: ["sessions.search"],
      request: (method) => (method === "sessions.search" ? transcript.promise : { models: [] }),
    });
    const { palette } = await mountPalette(createContext(gateway, list));
    await enterQuery(palette, "zzfixtureunique");
    await vi.advanceTimersByTimeAsync(50);
    expect(list).toHaveBeenCalledTimes(2);
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("true");
    expect(palette.textContent).not.toContain("No results");
    transcript.resolve({
      results: [
        {
          sessionKey: "agent:main:fixture",
          sessionId: "fixture",
          messageId: "message",
          role: "assistant",
          timestamp: 1,
          score: 1,
          snippet: "zzfixtureunique transcript match",
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(0);
    await palette.updateComplete;
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("false");
    expect(findPaletteOption(palette, "Unrelated title")?.textContent).toContain(
      "zzfixtureunique transcript match",
    );
  });

  it("keeps static commands usable while session search is pending", async () => {
    const { gateway } = createGateway(true);
    const { palette } = await mountPalette(createContext(gateway, () => new Promise(() => {})));
    await enterQuery(palette, "plugins");
    expect(palette.textContent).toContain("Searching sessions");
    findPaletteOption(palette, "Plugins")!.click();
    expect(palette.onNavigate).toHaveBeenCalledWith("plugins");
  });

  it("does not let an old query settle or select rows during a newer debounce", async () => {
    const old = createDeferred<SessionsListResult | null>();
    const current = createDeferred<SessionsListResult | null>();
    const { gateway } = createGateway(true);
    const list = vi
      .fn<ApplicationContext<RouteId>["sessions"]["list"]>()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const { palette } = await mountPalette(createContext(gateway, list));
    await enterQuery(palette, "zzold");
    await vi.advanceTimersByTimeAsync(50);
    const input = palette.querySelector("input")!;
    input.value = "zznew";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    old.resolve(createSessionResult("agent:main:old", "zzold match"));
    await vi.advanceTimersByTimeAsync(0);
    await palette.updateComplete;
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("true");
    expect(palette.querySelectorAll('[role="option"]')).toHaveLength(0);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(palette.onSelectSession).not.toHaveBeenCalled();
    expect(palette.isOpen).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    current.resolve(createSessionResult("agent:main:new", "zznew match"));
    await vi.advanceTimersByTimeAsync(0);
    await palette.updateComplete;
    expect(palette.textContent).not.toContain("zzold match");
    expect(findPaletteOption(palette, "zznew match")).toBeDefined();
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("false");
  });

  it.each(["close", "detach", "short-query", "disconnect"])(
    "clears pending search on %s and ignores its late completion",
    async (action) => {
      const deferred = createDeferred<SessionsListResult | null>();
      const harness = createGateway(true);
      const { palette, provider } = await mountPalette(
        createContext(harness.gateway, () => deferred.promise),
      );
      await enterQuery(palette, "zzfixtureunique");
      await vi.advanceTimersByTimeAsync(50);
      if (action === "close") {
        palette.togglePalette();
        palette.openPalette();
      } else if (action === "detach") {
        palette.remove();
        provider.append(palette);
        palette.openPalette();
      } else if (action === "disconnect") {
        harness.setConnected(false);
      } else {
        const input = palette.querySelector("input")!;
        input.value = "z";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await palette.updateComplete;
      expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("false");
      deferred.resolve(createSessionResult("agent:main:stale", "zzfixtureunique stale"));
      await vi.advanceTimersByTimeAsync(0);
      await palette.updateComplete;
      expect(palette.textContent).not.toContain("Searching sessions");
      expect(findPaletteOption(palette, "zzfixtureunique stale")).toBeUndefined();
    },
  );
});
