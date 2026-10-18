/* @vitest-environment jsdom */

import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionsListResult } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { subscribeNativeOverlayOcclusion } from "../lib/native-overlay-occlusion.ts";
import {
  openPalette,
  createContext,
  createGateway,
  createSessionResult,
  enterQuery,
  expectPalettePromptMode,
  findPaletteOption,
  mountPalette,
  mountSearch,
  searchPalette,
  registerCommandPaletteTestHooks,
  settlePalette,
  paletteInput,
  setInputValue,
  pressKey,
} from "./command-palette.test-support.ts";
import "./command-palette.tsx";

describe("CommandPalette lifecycle", () => {
  registerCommandPaletteTestHooks();

  it("hides native browser overlays while the palette is open and releases on close or disconnect", async () => {
    vi.stubGlobal("webkit", {
      messageHandlers: { openclawBrowser: { postMessage: vi.fn() } },
    });
    const { palette, query } = await mountPalette();
    const changes = vi.fn();
    onTestFinished(subscribeNativeOverlayOcclusion(changes, () => null));
    await openPalette(palette);
    await query("openclaw-modal-dialog")?.updateComplete;
    expect(changes.mock.calls).toEqual([[false], [true]]);
    pressKey(paletteInput(palette), "Escape", { cancelable: true });
    await palette.updateComplete;
    expect(changes).toHaveBeenLastCalledWith(false);
    await openPalette(palette);
    await query("openclaw-modal-dialog")?.updateComplete;
    expect(changes).toHaveBeenLastCalledWith(true);
    palette.remove();
    expect(changes).toHaveBeenLastCalledWith(false);
  });

  it("closes and clears its query before a retained element reconnects", async () => {
    const list = vi.fn(async () => createSessionResult("agent:main:old", "Old chat"));
    const { palette, provider, query } = await mountSearch({}, list);
    await searchPalette(palette, "old");
    expect(palette.textContent).toContain("Old chat");

    const dialog = query("openclaw-modal-dialog")?.querySelector("dialog");
    palette.remove();
    expect([palette.isOpen, dialog?.open]).toEqual([false, false]);
    provider.append(palette);
    await palette.updateComplete;

    expect(query("dialog[open]")).toBeNull();
    await openPalette(palette);
    expect(paletteInput(palette).value).toBe("");
    expect(palette.textContent).not.toContain("Old chat");
  });

  it("keeps local filtering usable if the connection drops during typing", async () => {
    const list = vi.fn(async () => null);
    const { palette, setConnected } = await mountSearch({}, list);
    await enterQuery(palette, "plugins");
    await vi.advanceTimersByTimeAsync(100);
    setConnected(false);
    await palette.updateComplete;
    await settlePalette(palette);
    expect(list).not.toHaveBeenCalled();
    findPaletteOption(palette, "Plugins", true)!.click();
    expect(palette.onNavigate).toHaveBeenCalledWith("plugins");
  });

  it.each(["reconnect", "replacement"])(
    "retires stale search results across a Gateway %s",
    async (change) => {
      const stale = createDeferred<SessionsListResult | null>();
      const list = vi
        .fn<ApplicationContext["sessions"]["list"]>()
        .mockImplementationOnce(() => stale.promise)
        .mockResolvedValueOnce(createSessionResult("agent:main:retry", "Retry chat"));
      const harness = await mountSearch({}, list);
      const { palette, provider, query } = harness;
      await searchPalette(palette, "retry");
      expect(list).toHaveBeenCalledOnce();

      if (change === "reconnect") {
        harness.setConnected(false);
      }
      stale.resolve(createSessionResult("agent:main:stale", "Stale chat"));
      const replacementList = vi.fn(async () =>
        createSessionResult("agent:main:fresh", "Fresh chat"),
      );
      if (change === "replacement") {
        provider.setContext(createContext(createGateway(true).gateway, replacementList));
      } else {
        await Promise.resolve();
        expect(palette.textContent).not.toContain("Stale chat");
        harness.setConnected(true);
      }
      await palette.updateComplete;
      await settlePalette(palette);

      if (change === "reconnect") {
        expect(list).toHaveBeenCalledTimes(2);
        expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ search: "retry" }));
        expect(palette.textContent).toContain("Retry chat");
      } else {
        expect(palette.isOpen).toBe(false);
        expect(query(".cmd-palette__input")).toBeNull();
        await openPalette(palette);
        expect(paletteInput(palette).value).toBe("");
        expect(replacementList).not.toHaveBeenCalled();
        expect(palette.textContent).not.toContain("Stale chat");
        await searchPalette(palette, "retry");
        expect(replacementList).toHaveBeenCalledOnce();
        expect(palette.textContent).toContain("Fresh chat");
      }
    },
  );

  it.each(["reconnect", "config.changed", "chat.metadata.changed", "agent"])(
    "keeps prompt searches stopped through %s and resumes when shortened",
    async (change) => {
      const request = vi.fn(async (method: string) =>
        method === "sessions.search"
          ? { results: [], sessions: [] }
          : { models: [{ id: "fixture", provider: "fixture", name: "Needle model" }] },
      );
      const list = vi.fn(async () => createSessionResult("agent:main:needle", "Needle session"));
      const harness = await mountSearch({ methods: ["sessions.search"], request }, list);
      const { palette, context, queryAll } = harness;
      const prompt = "needle\nSummarize the discussion and prepare a follow-up task.";
      await searchPalette(palette, prompt);
      expect([list.mock.calls, request.mock.calls]).toEqual([[], []]);

      if (change === "reconnect") {
        harness.setConnected(false);
        await palette.updateComplete;
        harness.setConnected(true);
      } else if (change === "agent") {
        context.agentSelection.set("reviewer");
      } else {
        harness.emit(change);
      }
      await palette.updateComplete;
      await settlePalette(palette);
      const input = paletteInput(palette);
      expect(input.value).toBe(prompt);
      expect([list.mock.calls, request.mock.calls]).toEqual([[], []]);
      expectPalettePromptMode(palette);

      setInputValue(input, "needle");
      await settlePalette(palette);
      expect(list).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ search: "needle" }));
      expect(request).toHaveBeenCalledWith(
        "sessions.search",
        expect.objectContaining({ query: "needle" }),
      );
      expect(request).toHaveBeenCalledWith("models.list", expect.anything());
      expect(findPaletteOption(palette, "Needle session")).toBeDefined();
      expect(findPaletteOption(palette, "Needle model")).toBeDefined();
      expect(queryAll(".cmd-palette__filter")).toHaveLength(3);
    },
  );
});
