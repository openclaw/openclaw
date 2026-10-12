import type WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import { afterEach, describe, expect, it } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import "../../styles/chat/layout.css";
import { renderContextNoticeSolid } from "./components/chat-composer-context.tsx";
import { syncChatPickerOverlay } from "./components/chat-picker-overlay.ts";

const rootStyle = document.documentElement.style;
const previousStyle = rootStyle.cssText;
afterEach(() => {
  document.body.replaceChildren();
  rootStyle.cssText = previousStyle;
});

describe("mounted context usage palette", () => {
  it.each([85, 90, 95, 100])(
    "keeps the %s percent ring and bar on the current CSS palette",
    async (percent) => {
      const container = document.createElement("div");
      container.className = "agent-chat__input";
      rootStyle.setProperty("--warn", "#d97706");
      rootStyle.setProperty("--danger", "#dc2626");
      mountSolid(
        () =>
          renderContextNoticeSolid({
            key: "main",
            kind: "direct",
            updatedAt: null,
            totalTokens: percent,
            contextTokens: 100,
          }),
        { container },
      );
      document.body.append(container);
      const details = container.querySelector("details")!;
      details.open = true;
      syncChatPickerOverlay(details);
      await container.querySelector<WaPopup>("wa-popup")!.updateComplete;
      const ring = container.querySelector<HTMLElement>(".context-ring")!;
      ring.style.transition = "none";
      const fill = container.querySelector(".context-ring__fill")!;
      const bar = container.querySelector(".context-usage__bar span")!;
      const probe = document.createElement("span");
      container.append(probe);
      const dangerPercent = Math.min(Math.max((percent - 85) / 10, 0), 1) * 100;
      probe.style.color = "color-mix(in srgb, var(--warn), var(--danger) " + dangerPercent + "%)";
      // Dark, light, and imported OKLCH tokens change with no template rerender.
      for (const [warn, danger] of [
        ["#fbbf24", "#f87171"],
        ["oklch(0.75 0.15 80)", "oklch(0.78 0.16 310)"],
        ["oklch(0.48 0.12 80)", "oklch(0.48 0.18 310)"],
      ] as const) {
        rootStyle.setProperty("--warn", warn);
        rootStyle.setProperty("--danger", danger);
        const expected = getComputedStyle(probe).color;
        expect(getComputedStyle(fill).stroke).toBe(expected);
        expect(getComputedStyle(bar).backgroundColor).toBe(expected);
        expect(container.querySelector(".context-ring")).toBe(ring);
      }
    },
  );
});
