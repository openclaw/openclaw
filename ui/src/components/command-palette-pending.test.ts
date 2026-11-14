/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { SessionsSearchResult } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionsListResult } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import {
  createSessionResult,
  enterQuery,
  expectPalettePromptMode,
  findPaletteOption,
  mountSearch,
  searchPalette,
  settlePalette,
  paletteInput,
  setInputValue,
  pressKey,
  registerCommandPaletteTestHooks,
  transcriptResult,
} from "./command-palette.test-support.ts";
import "./command-palette.tsx";

registerCommandPaletteTestHooks({ mockScroll: false });

describe("CommandPalette pending searches", () => {
  it.each([false, true])(
    "debounces input until the final key or IME commit: %s",
    async (composing) => {
      const request = vi.fn(async (_method: string) => ({ sessions: [], results: [], models: [] }));
      const list = vi.fn(async () => null);
      const { palette, query } = await mountSearch({ methods: ["sessions.search"], request }, list);
      await enterQuery(palette, composing ? "plugins" : "");
      const original = query(".cmd-palette__search")!.textContent;
      const input = paletteInput(palette);
      if (composing) {
        input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      }
      for (const value of composing
        ? ["plugin"]
        : ["p", "pl", "plu", "plug", "plugi", "plugin", "plugins"]) {
        setInputValue(input, value);
        await palette.updateComplete;
        expect(input.value).toBe(value);
        expect(query(".cmd-palette__search")!.textContent).toBe(original);
        await vi.advanceTimersByTimeAsync(100);
        expect([list.mock.calls, request.mock.calls]).toEqual([[], []]);
      }
      if (composing) {
        await vi.advanceTimersByTimeAsync(200);
        expect(list).not.toHaveBeenCalled();
        input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
        await vi.advanceTimersByTimeAsync(100);
      }
      await vi.advanceTimersByTimeAsync(99);
      expect(list).not.toHaveBeenCalled();
      await settlePalette(palette, 1);
      const search = composing ? "plugin" : "plugins";
      expect(list).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ search }));
      expect(request.mock.calls.filter(([method]) => method === "sessions.search")).toHaveLength(1);
      expect(request).toHaveBeenCalledWith(
        "sessions.search",
        expect.objectContaining({ query: search }),
      );
      expect(findPaletteOption(palette, "Plugins", true)).toBeDefined();
    },
  );

  it.each([false, true])(
    "cancels prompt search before dispatch or ignores late results: %s",
    async (dispatched) => {
      const metadata = createDeferred<SessionsListResult | null>();
      const transcript = createDeferred<SessionsSearchResult>();
      const catalog = createDeferred<{
        models: { id: string; provider: string; name: string }[];
        refreshFailed: boolean;
      }>();
      const prompt = "zzfixtureunique\nExplain the findings in a new session.";
      const request = vi.fn((method: string) =>
        method === "sessions.search" ? transcript.promise : catalog.promise,
      );
      const list = vi.fn(() => metadata.promise);
      const { palette, query } = await mountSearch({ methods: ["sessions.search"], request }, list);
      await enterQuery(palette, "zzfixtureunique");
      await settlePalette(palette, dispatched ? 200 : 199);
      expect(list).toHaveBeenCalledTimes(dispatched ? 1 : 0);
      expect(request).toHaveBeenCalledTimes(dispatched ? 2 : 0);

      const input = paletteInput(palette);
      setInputValue(input, prompt);
      await palette.updateComplete;
      const stale = createSessionResult("agent:main:stale", "zzfixtureunique stale session");
      metadata.resolve(stale);
      transcript.resolve({
        ...transcriptResult(stale, "zzfixtureunique stale transcript"),
        indexing: true,
        archivedTranscriptsExcluded: 2,
      });
      catalog.resolve({
        models: [{ id: "stale", provider: "fixture", name: prompt }],
        refreshFailed: true,
      });
      await settlePalette(palette, 100);

      expectPalettePromptMode(palette);
      expect(input.value).toBe(prompt);

      // An automatic Compose holds until the draft is emptied.
      setInputValue(input, "zzfixtureunique");
      await palette.updateComplete;
      expectPalettePromptMode(palette);
      setInputValue(input, "");
      setInputValue(input, "zzfixtureunique");
      await palette.updateComplete;
      expect(query('[inert][aria-hidden="true"]')).toBeNull();
      // Emptying the draft settled the navigation list; no stale row may return.
      expect(palette.querySelector('[role="listbox"]')?.textContent).not.toContain("stale");
      expect(query(".cmd-palette__source-error")).toBeNull();
      expect(list).toHaveBeenCalledTimes(dispatched ? 1 : 0);
      expect(request).toHaveBeenCalledTimes(dispatched ? 2 : 0);
    },
  );

  it("announces session search until an empty result settles", async () => {
    const deferred = createDeferred<SessionsListResult | null>();
    const list = vi.fn(() => deferred.promise);
    const { palette, query, queryAll } = await mountSearch({}, list);
    await enterQuery(palette, "zzfixtureunique");
    const results = query('.cmd-palette__results[role="listbox"]')!;
    expect(results.getAttribute("aria-busy")).toBe("true");
    expect(palette.textContent).not.toMatch(/Searching sessions|No results/);
    await settlePalette(palette);
    expect(query('.cmd-palette__search [role="status"]')?.textContent).toContain(
      "Searching sessions",
    );
    expect(results.getAttribute("aria-busy")).toBe("true");
    expect(queryAll('[role="option"]')).toHaveLength(0);
    deferred.resolve({ ...createSessionResult("agent:main:fixture", "Unused"), sessions: [] });
    await settlePalette(palette, 0);
    expect(results.getAttribute("aria-busy")).toBe("false");
    expect(palette.textContent).not.toContain("Searching sessions");
    const empty = query(".cmd-palette__no-results")!;
    expect(empty.querySelector("h2")?.textContent).toBe("No results match your search.");
    expect(empty.textContent).toContain("to compose a new session.");
    expect(empty.querySelector("button")).toBeNull();
  });

  it.each(["plugins", "models"])(
    "retains pending %s through typing and reopening without session search",
    async (source) => {
      const loaded = {
        models: [{ id: "fixture", provider: "fixture", name: "zzcatalog models" }],
        plugins: [{ id: "fixture", name: "zzcatalog plugins" }],
      };
      const catalog = createDeferred<typeof loaded>();
      const request = vi.fn((method: string) =>
        method === source + ".list" ? catalog.promise : { models: [], plugins: [] },
      );
      const list = vi.fn(async () => null);
      const { palette, query } = await mountSearch({ methods: ["plugins.list"], request }, list);
      palette.onSelectSession = undefined;
      await enterQuery(palette, "");
      expect(findPaletteOption(palette, "Plugins")).toBeDefined();
      expect(query('[aria-busy="true"]')).toBeNull();
      await searchPalette(palette, "zzcatalog");
      expect(palette.textContent).toContain("Searching commands");
      expect(palette.textContent).not.toMatch(/Searching sessions|No results/);
      setInputValue(paletteInput(palette), "z");
      await palette.updateComplete;
      expect(query('.cmd-palette__results[role="listbox"]')?.getAttribute("aria-busy")).toBe(
        "true",
      );
      palette.togglePalette();
      palette.openPalette({
        value: "plugins",
        selectionStart: 7,
        selectionEnd: 7,
        selectionDirection: "none",
      });
      await settlePalette(palette);
      expect(paletteInput(palette).value).toBe("plugins");
      expect(findPaletteOption(palette, "Plugins")).toBeDefined();
      expect(findPaletteOption(palette, "New session", true)).toBeUndefined();
      expect(palette.textContent).toContain("Searching commands");
      expect(query('.cmd-palette__results[role="listbox"]')?.getAttribute("aria-busy")).toBe(
        "true",
      );
      setInputValue(paletteInput(palette), "zzcatalog");
      catalog.resolve(loaded);
      await settlePalette(palette);
      expect(findPaletteOption(palette, "zzcatalog " + source)).toBeDefined();
      expect(query('.cmd-palette__results[role="listbox"]')?.getAttribute("aria-busy")).toBe(
        "false",
      );
      await searchPalette(palette, "zzmissing");
      expect(palette.textContent).toContain("No results match your search.");
      expect(request).toHaveBeenCalledTimes(2);
      expect(list).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["partial", {}, "Couldn’t search messages"],
    ["model failure", {}, "Couldn’t search models"],
    ["indexing", { indexing: true }, "Results may be incomplete. Search again shortly."],
    ["archived", { archivedTranscriptsExcluded: 2 }, "Archived sessions"],
  ] as const)(
    "does not announce empty success for %s transcript results",
    async (name, result, notice) => {
      const roster = createSessionResult("agent:main:fixture", "Unused");
      const list = vi.fn<ApplicationContext["sessions"]["list"]>(async (options) =>
        options?.search ? { ...roster, sessions: [] } : roster,
      );
      const { palette, query } = await mountSearch(
        {
          methods: ["sessions.search"],
          request: (method) => {
            if (method !== "sessions.search") {
              if (name === "model failure") {
                throw new Error("Model source unavailable");
              }
              return { models: [] };
            }
            if (name === "partial") {
              throw new Error("Transcript source unavailable");
            }
            return { results: [], ...result };
          },
        },
        list,
      );
      await searchPalette(palette, "zzfixtureunique");
      expect(palette.textContent).toContain(notice);
      expect(query(".cmd-palette__no-results")).toBeNull();
    },
  );

  it("does not let an old query settle or select rows during a newer debounce", async () => {
    const old = createDeferred<SessionsListResult | null>();
    const current = createDeferred<SessionsListResult | null>();
    const list = vi
      .fn<ApplicationContext["sessions"]["list"]>()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const { palette, query, queryAll } = await mountSearch({}, list);
    await searchPalette(palette, "zzold");
    const input = paletteInput(palette);
    setInputValue(input, "zznew");
    old.resolve(createSessionResult("agent:main:old", "zzold match"));
    await settlePalette(palette, 0);
    expect(query('.cmd-palette__results[role="listbox"]')?.getAttribute("aria-busy")).toBe("true");
    expect(queryAll('[role="option"]')).toHaveLength(0);
    pressKey(input, "Enter");
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ search: "zznew" }));
    expect(palette.onSelectSession).not.toHaveBeenCalled();
    expect(palette.isOpen).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(list).toHaveBeenCalledTimes(2);
    current.resolve(createSessionResult("agent:main:new", "zznew match"));
    await settlePalette(palette, 0);
    expect(palette.textContent).not.toContain("zzold match");
    expect(findPaletteOption(palette, "zznew match")).toBeDefined();
    expect(query('.cmd-palette__results[role="listbox"]')?.getAttribute("aria-busy")).toBe("false");
    pressKey(input, "Enter");
    expect(palette.onSelectSession).toHaveBeenCalledExactlyOnceWith("agent:main:new");
  });

  it.each(["close", "detach", "short-query", "disconnect"])(
    "clears pending search on %s and ignores its late completion",
    async (action) => {
      const deferred = createDeferred<SessionsListResult | null>();
      const { palette, provider, query, setConnected } = await mountSearch(
        {},
        () => deferred.promise,
      );
      await searchPalette(palette, "zzfixtureunique");
      if (action === "close") {
        palette.togglePalette();
        palette.openPalette();
      } else if (action === "detach") {
        palette.remove();
        provider.append(palette);
        palette.openPalette();
      } else if (action === "disconnect") {
        setConnected(false);
      } else {
        setInputValue(paletteInput(palette), "z");
      }
      await palette.updateComplete;
      if (action === "short-query") {
        expect(query('.cmd-palette__results[role="listbox"]')?.getAttribute("aria-busy")).toBe(
          "true",
        );
        await vi.advanceTimersByTimeAsync(200);
      }
      expect(query('.cmd-palette__results[role="listbox"]')?.getAttribute("aria-busy")).toBe(
        "false",
      );
      deferred.resolve(createSessionResult("agent:main:stale", "zzfixtureunique stale"));
      await settlePalette(palette, 0);
      expect(palette.textContent).not.toContain("Searching sessions");
      expect(findPaletteOption(palette, "zzfixtureunique stale")).toBeUndefined();
    },
  );
});

describe("CommandPalette session search", () => {
  it("waits for transcripts after metadata settles and merges both sources", async () => {
    const metadata = createSessionResult("agent:main:metadata", "needle");
    const contextOnly = createSessionResult("agent:main:context", "Unrelated title");
    const roster = {
      ...metadata,
      count: 2,
      totalCount: 2,
      sessions: [...metadata.sessions, ...contextOnly.sessions],
    };
    const list = vi.fn(async () => roster);
    const transcript = createDeferred<SessionsSearchResult>();
    const request = vi.fn((method: string) =>
      method === "models.list" ? { models: [] } : transcript.promise,
    );
    const { palette } = await mountSearch({ methods: ["sessions.search"], request }, list);
    await searchPalette(palette, "needle");
    expect(list).toHaveBeenCalledOnce();
    expect(
      palette.querySelector('.cmd-palette__results[role="listbox"]')?.getAttribute("aria-busy"),
    ).toBe("true");
    expect(palette.textContent).not.toContain("No results");
    transcript.resolve(
      transcriptResult(contextOnly, "The needle appears only in the conversation body."),
    );
    await settlePalette(palette, 0);
    expect(
      palette.querySelector('.cmd-palette__results[role="listbox"]')?.getAttribute("aria-busy"),
    ).toBe("false");
    const items = [...palette.querySelectorAll<HTMLElement>(".cmd-palette__item")];
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("needle");
    expect(items[1]?.textContent).toContain("Unrelated title");
    expect(items[1]?.textContent).toContain("needle appears only in the conversation body");
    expect(palette.textContent).not.toMatch(
      /Search notices|may be incomplete|Couldn’t search sessions/,
    );
    findPaletteOption(palette, "needle")!.click();
    expect(palette.onSelectSession).toHaveBeenCalledWith("agent:main:metadata");
  });
});
