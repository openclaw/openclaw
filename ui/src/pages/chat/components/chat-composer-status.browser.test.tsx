import type { CDPSession } from "@vitest/browser-playwright";
import { createSignal, type Setter } from "solid-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cdp } from "vitest/browser";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import "../../../components/tooltip.ts";
import { buildCompactionActivityItem } from "../chat-progress.ts";
import { ChatCompactionActivity } from "./chat-compaction-activity.tsx";
import { renderFallbackIndicatorSolid } from "./chat-composer-status.tsx";
import baseStyles from "../../../styles/base.css?inline";
import composerStatusStyles from "../../../styles/chat/composer-status.css?inline";
import chatComposerStyles from "../../../styles/chat/composer.css?inline";
import groupedStyles from "../../../styles/chat/grouped.css?inline";
import chatLayoutStyles from "../../../styles/chat/layout.css?inline";
import toolCardStyles from "../../../styles/chat/tool-cards.css?inline";
import componentStyles from "../../../styles/components.css?inline";

function mountCompaction(container: HTMLElement) {
  let setPhase!: Setter<"active" | "complete">;
  mountSolid(
    () => {
      const [phase, updatePhase] = createSignal<"active" | "complete">("active");
      setPhase = updatePhase;
      return <ChatCompactionActivity item={buildCompactionActivityItem({}, 1_000, 0, phase())} />;
    },
    { container },
  );
  return (phase: "active" | "complete") => {
    setPhase(phase);
    flush();
  };
}

describe("inline compaction status", () => {
  let container: HTMLDivElement;
  let styles: HTMLStyleElement;
  let session: CDPSession;

  beforeEach(async () => {
    session = cdp();
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
    });
    styles = document.createElement("style");
    styles.textContent = [
      baseStyles,
      componentStyles,
      groupedStyles,
      chatLayoutStyles,
      chatComposerStyles,
      composerStatusStyles,
      toolCardStyles,
    ].join("\n");
    document.head.append(styles);
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(async () => {
    container.replaceChildren();
    container.remove();
    styles.remove();
    await session.send("Emulation.setEmulatedMedia", { features: [] });
  });

  it.each(["no-preference", "reduce"])(
    "keeps Layers and phase text with motion preference %s",
    async (motion) => {
      await session.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: motion }],
      });
      const setPhase = mountCompaction(container);
      const icon = container.querySelector<SVGElement>(".chat-tool-msg-summary__icon svg")!;
      const label = container.querySelector<HTMLElement>(".chat-tool-row__title")!;
      expect(icon.querySelector("path")?.getAttribute("d")).toBe("m12 3 10 5-10 5L2 8Z");
      expect(icon.getBoundingClientRect()).toMatchObject({ width: 16, height: 16 });
      expect(label.textContent).toBe("Compacting");
      expect(label.classList.contains("text-shimmer")).toBe(true);
      if (motion === "reduce") {
        expect(getComputedStyle(label).webkitTextFillColor).not.toBe("rgba(0, 0, 0, 0)");
      }
      setPhase("complete");
      expect(container.querySelector(".chat-tool-msg-summary__icon svg")).toBe(icon);
      expect(label.textContent).toBe("Compacted context");
      expect(label.classList.contains("text-shimmer")).toBe(false);
    },
  );

  it("keeps the expanded compaction savings readable in a narrow pane", async () => {
    container.style.width = "260px";
    mountSolid(
      () => (
        <ChatCompactionActivity
          item={buildCompactionActivityItem(
            { tokensBefore: 101_000, tokensAfter: 52_100 },
            1_000,
            0,
          )}
        />
      ),
      { container },
    );
    const row = container.querySelector<HTMLDetailsElement>(".chat-compaction-activity")!;
    row.open = true;
    await expect.poll(() => row.textContent).toContain("saved 48.9k tokens (48.4%)");
    const title = row.querySelector(".chat-tool-row__title")!.getBoundingClientRect();
    const metric = row.querySelector(".chat-tool-kv > div")!;
    const range = document.createRange();
    range.selectNodeContents(metric);
    const rects = [...range.getClientRects()];
    expect(rects).toHaveLength(1);
    expect(rects[0]!.top).toBeGreaterThanOrEqual(title.bottom);
    expect(rects[0]!.right).toBeLessThanOrEqual(container.getBoundingClientRect().right);
  });

  it.each(["active", "cleared"] as const)("preserves the %s fallback pill", async (phase) => {
    mountSolid(
      () =>
        renderFallbackIndicatorSolid({
          phase,
          selected: "provider/selected",
          active: "provider/active",
          attempts: [],
          occurredAt: Date.now(),
        }),
      { container },
    );
    await container.querySelector("openclaw-tooltip")!.updateComplete;
    const indicator = container.querySelector<HTMLElement>(".compaction-indicator")!;
    const icon = indicator.querySelector("svg")!;
    expect(getComputedStyle(indicator).borderTopWidth).toBe("1px");
    expect(getComputedStyle(indicator).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(icon).width).toBe("16px");
    expect(indicator.querySelector(".compaction-indicator__glyph")).toBeNull();
    expect(indicator.getAttribute("role")).toBe("status");
  });
});
