/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionsListResult } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { subscribeNativeOverlayOcclusion } from "../lib/native-overlay-occlusion.ts";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import {
  createContext,
  createGateway,
  createSessionResult,
  enterQuery,
  expectPalettePromptMode,
  findPaletteOption,
  mountPalette,
} from "./command-palette.test-support.ts";
import "./command-palette.ts";

describe("CommandPalette lifecycle", () => {
  let restoreDialogPolyfill: () => void;
  let scrollIntoViewDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    restoreDialogPolyfill = installDialogPolyfill();
    scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    restoreDialogPolyfill();
    if (scrollIntoViewDescriptor) {
      Object.defineProperty(Element.prototype, "scrollIntoView", scrollIntoViewDescriptor);
    } else {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("hides native browser overlays while the palette is open and releases on close or disconnect", async () => {
    vi.stubGlobal("webkit", {
      messageHandlers: { openclawBrowser: { postMessage: vi.fn() } },
    });
    const { gateway } = createGateway(true);
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => null),
      ),
    );
    const changes = vi.fn();
    const unsubscribe = subscribeNativeOverlayOcclusion(changes, () => null);
    try {
      palette.openPalette();
      await palette.updateComplete;
      await palette.querySelector("openclaw-modal-dialog")?.updateComplete;
      expect(changes.mock.calls).toEqual([[false], [true]]);

      palette
        .querySelector(".cmd-palette__input")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      await palette.updateComplete;
      expect(changes).toHaveBeenLastCalledWith(false);
      palette.openPalette();
      await palette.updateComplete;
      await palette.querySelector("openclaw-modal-dialog")?.updateComplete;
      expect(changes).toHaveBeenLastCalledWith(true);
      palette.remove();
      expect(changes).toHaveBeenLastCalledWith(false);
    } finally {
      unsubscribe();
    }
  });

  it("closes and clears its query before a retained element reconnects", async () => {
    const { gateway } = createGateway(true);
    const list = vi.fn(async () => createSessionResult("agent:main:old", "Old chat"));
    const { palette, provider } = await mountPalette(createContext(gateway, list));
    await enterQuery(palette, "old");
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;
    expect(palette.textContent).toContain("Old chat");

    palette.remove();
    provider.append(palette);
    const modal = palette.querySelector("openclaw-modal-dialog");
    const dialog = modal?.shadowRoot
      ?.querySelector("wa-dialog")
      ?.shadowRoot?.querySelector("dialog");
    expect(dialog?.open).toBe(false);
    await palette.updateComplete;

    expect(palette.querySelector("dialog")).toBeNull();
    palette.openPalette();
    await palette.updateComplete;
    expect(palette.querySelector<HTMLTextAreaElement>(".cmd-palette__input")?.value).toBe("");
    expect(palette.textContent).not.toContain("Old chat");
  });

  it("keeps local filtering usable if the connection drops during typing", async () => {
    const { gateway, setConnected } = createGateway(true);
    const list = vi.fn(async () => null);
    const { palette } = await mountPalette(createContext(gateway, list));
    await enterQuery(palette, "plugins");
    await vi.advanceTimersByTimeAsync(100);
    setConnected(false);
    await palette.updateComplete;
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;
    expect(list).not.toHaveBeenCalled();
    findPaletteOption(palette, "Plugins", true)!.click();
    expect(palette.onNavigate).toHaveBeenCalledWith("plugins");
  });

  it("retries the pending query after the gateway reconnects", async () => {
    const harness = createGateway(true);
    const stale = createDeferred<SessionsListResult | null>();
    const list = vi
      .fn<ApplicationContext["sessions"]["list"]>()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce(createSessionResult("agent:main:retry", "Retry chat"));
    const { palette } = await mountPalette(createContext(harness.gateway, list));
    await enterQuery(palette, "retry");
    await vi.advanceTimersByTimeAsync(200);
    expect(list).toHaveBeenCalledOnce();

    harness.setConnected(false);
    stale.resolve(createSessionResult("agent:main:stale", "Stale chat"));
    await Promise.resolve();
    expect(palette.textContent).not.toContain("Stale chat");

    harness.setConnected(true);
    await palette.updateComplete;
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;

    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ search: "retry" }));
    expect(palette.textContent).toContain("Retry chat");
  });

  it.each(["reconnect", "config.changed", "chat.metadata.changed", "agent"])(
    "keeps prompt searches stopped through %s and resumes when shortened",
    async (change) => {
      const request = vi.fn(async (method: string) =>
        method === "sessions.search"
          ? { results: [], sessions: [] }
          : { models: [{ id: "fixture", provider: "fixture", name: "Needle model" }] },
      );
      const harness = createGateway(true, { methods: ["sessions.search"], request });
      const list = vi.fn(async () => createSessionResult("agent:main:needle", "Needle session"));
      const context = createContext(harness.gateway, list);
      const { palette } = await mountPalette(context);
      const prompt = "needle\nSummarize the discussion and prepare a follow-up task.";
      await enterQuery(palette, prompt);
      await vi.advanceTimersByTimeAsync(200);
      expect(list).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();

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
      await vi.advanceTimersByTimeAsync(200);
      await palette.updateComplete;
      const input = palette.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;
      expect(input.value).toBe(prompt);
      expect(list).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expectPalettePromptMode(palette);

      input.value = "needle";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(200);
      await palette.updateComplete;
      expect(list).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ search: "needle" }));
      expect(request).toHaveBeenCalledWith(
        "sessions.search",
        expect.objectContaining({ query: "needle" }),
      );
      expect(request).toHaveBeenCalledWith("models.list", expect.anything());
      expect(findPaletteOption(palette, "Needle session")).toBeDefined();
      expect(findPaletteOption(palette, "Needle model")).toBeDefined();
      expect(palette.querySelectorAll(".cmd-palette__filter")).toHaveLength(3);
    },
  );

  it("clears the old Gateway prompt before searching the replacement context", async () => {
    const initial = createGateway(true);
    const replacement = createGateway(true);
    const stale = createDeferred<SessionsListResult | null>();
    const initialList = vi.fn(() => stale.promise);
    const replacementList = vi.fn(async () =>
      createSessionResult("agent:main:fresh", "Fresh chat"),
    );
    const { palette, provider } = await mountPalette(createContext(initial.gateway, initialList));
    await enterQuery(palette, "chat");
    await vi.advanceTimersByTimeAsync(200);
    expect(initialList).toHaveBeenCalledOnce();

    stale.resolve(createSessionResult("agent:main:stale", "Stale chat"));
    provider.setContext(createContext(replacement.gateway, replacementList));
    await palette.updateComplete;
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;

    expect(palette.isOpen).toBe(false);
    expect(palette.querySelector(".cmd-palette__input")).toBeNull();
    palette.openPalette();
    await palette.updateComplete;
    expect(palette.querySelector<HTMLTextAreaElement>(".cmd-palette__input")?.value).toBe("");
    expect(replacementList).not.toHaveBeenCalled();
    expect(palette.textContent).not.toContain("Stale chat");

    await enterQuery(palette, "chat");
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;
    expect(replacementList).toHaveBeenCalledOnce();
    expect(palette.textContent).toContain("Fresh chat");
  });
});
