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

  it.each(["openPalette", "togglePalette"] as const)(
    "clears a disconnected palette and honors early %s",
    async (method) => {
      vi.stubGlobal("webkit", {
        messageHandlers: { openclawBrowser: { postMessage: vi.fn() } },
      });
      const list = vi.fn(async () => createSessionResult("agent:main:old", "Old chat"));
      const { palette, provider, query } = await mountSearch({}, list);
      const changes = vi.fn();
      onTestFinished(subscribeNativeOverlayOcclusion(changes, () => null));
      await openPalette(palette);
      await query("openclaw-modal-dialog")?.updateComplete;
      expect(changes.mock.calls).toEqual([[false], [true]]);
      pressKey(paletteInput(palette), "Escape", { cancelable: true });
      await palette.updateComplete;
      expect(changes).toHaveBeenLastCalledWith(false);
      await searchPalette(palette, "old");
      await query("openclaw-modal-dialog")?.updateComplete;
      expect(changes).toHaveBeenLastCalledWith(true);
      expect(palette.textContent).toContain("Old chat");
      const dialog = query("openclaw-modal-dialog")?.querySelector("dialog");
      palette.remove();
      expect(changes).toHaveBeenLastCalledWith(false);
      expect([palette.isOpen, dialog?.open]).toEqual([false, false]);
      provider.append(palette);
      await palette.updateComplete;
      expect(query("dialog[open]")).toBeNull();
      palette.remove();
      await palette.updateComplete;
      provider.append(palette);
      palette[method]();
      await palette.updateComplete;
      expect(palette.isOpen).toBe(true);
      expect(paletteInput(palette).value).toBe("");
      expect(palette.textContent).not.toContain("Old chat");
    },
  );

  it("keeps local filtering usable if the connection drops during typing", async () => {
    const list = vi.fn(async () => null);
    const { palette, setConnected } = await mountSearch({}, list);
    await enterQuery(palette, "plugins");
    await vi.advanceTimersByTimeAsync(100);
    setConnected(false);
    await palette.updateComplete;
    await settlePalette(palette);
    expect(list).not.toHaveBeenCalled();
    expect(palette.textContent).toContain("Reconnect to search Gateway content.");
    expect(palette.querySelector(".cmd-palette__no-results")).toBeNull();
    findPaletteOption(palette, "Plugins", true)!.click();
    expect(palette.onNavigate).toHaveBeenCalledWith("plugins");
  });

  it.each(["reconnect", "replacement"])(
    "retires stale search results across a Gateway %s",
    async (change) => {
      const stale = createDeferred<SessionsListResult | null>();
      const fresh = vi.fn(async () => createSessionResult("agent:main:fresh", "Fresh chat"));
      const list = vi
        .fn<ApplicationContext["sessions"]["list"]>()
        .mockImplementationOnce(() => stale.promise)
        .mockImplementation(fresh);
      const harness = await mountSearch({}, list);
      const { palette, provider, query } = harness;
      await searchPalette(palette, "retry");
      expect(list).toHaveBeenCalledOnce();

      if (change === "reconnect") {
        harness.setConnected(false);
      } else {
        provider.setContext(createContext(createGateway(true).gateway, fresh));
      }
      stale.resolve(createSessionResult("agent:main:stale", "Stale chat"));
      await palette.updateComplete;
      await settlePalette(palette);
      expect(palette.textContent).not.toContain("Stale chat");
      if (change === "reconnect") {
        harness.setConnected(true);
        await settlePalette(palette);
        expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ search: "retry" }));
      } else {
        expect(palette.isOpen).toBe(false);
        expect(query(".cmd-palette__input")).toBeNull();
        await openPalette(palette);
        expect(paletteInput(palette).value).toBe("");
        expect(fresh).not.toHaveBeenCalled();
        await searchPalette(palette, "retry");
      }
      expect(fresh).toHaveBeenCalledOnce();
      expect(palette.textContent).toContain("Fresh chat");
    },
  );

  it.each(["reconnect", "config.changed", "chat.metadata.changed", "agent"])(
    "keeps Compose searches stopped through %s and resumes in Search",
    async (change) => {
      const request = vi.fn(async (method: string) =>
        method === "sessions.search"
          ? { results: [], sessions: [] }
          : { models: [{ id: "fixture", provider: "fixture", name: "Needle model" }] },
      );
      const list = vi.fn(async () => createSessionResult("agent:main:needle", "Needle session"));
      const harness = await mountSearch({ methods: ["sessions.search"], request }, list);
      const { palette, context } = harness;
      const prompt = "needle\nSummarize the discussion and prepare a follow-up task.";
      await openPalette(palette);
      pressKey(paletteInput(palette), "Tab", { cancelable: true });
      setInputValue(paletteInput(palette), prompt);
      await settlePalette(palette);
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
      pressKey(input, "Tab", { cancelable: true });
      await settlePalette(palette);
      expect(findPaletteOption(palette, "Needle session")).toBeDefined();
      expect(findPaletteOption(palette, "Needle model")).toBeDefined();
    },
  );
});
