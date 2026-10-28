import type { OverlayHandle } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createBtwPresenter } from "./tui-btw-overlay.js";
import {
  createBaseState,
  createTestSessionActions,
  makeTuiBackend,
} from "./tui-session-actions-test-support.js";

describe("tui session actions btw", () => {
  it("keeps an open btw answer through a same-session history reload", async () => {
    const closeOverlay = vi.fn();
    const btw = createBtwPresenter({
      screenReader: true,
      chatLog: { showBtw: vi.fn(), dismissBtw: vi.fn(), addSystem: vi.fn() },
      tui: { requestRender: vi.fn() },
      openOverlay: vi.fn(() => ({ hide: vi.fn() }) as unknown as OverlayHandle),
      closeOverlay,
    });
    btw.showResult({ question: "q", text: "answer" });
    const { loadHistory } = createTestSessionActions({
      btw,
      client: makeTuiBackend({
        loadHistory: vi.fn().mockResolvedValue({ messages: [], sessionId: "session-main" }),
      }),
      state: createBaseState({ historyLoaded: true }),
    });

    await loadHistory();

    expect(closeOverlay).not.toHaveBeenCalled();
    btw.clear();
    expect(closeOverlay).toHaveBeenCalledTimes(1);
  });
});
