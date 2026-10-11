import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { HubTabs } from "./hub-tabs.tsx";
import baseStyles from "../../styles/base.css?inline";
import hubStyles from "../../styles/hub-tabs.css?inline";
import settingsStyles from "../../styles/settings.css?inline";
import tabsStyles from "../../styles/tabs.css?inline";

afterEach(cleanup);

it("keeps hub typography, selected ink, and compact height when native defaults load last", async () => {
  const viewport = { width: innerWidth, height: innerHeight };
  const styles = document.createElement("style");
  styles.textContent = [baseStyles, settingsStyles, hubStyles, tabsStyles].join("\n");
  document.head.append(styles);
  const [active, setActive] = createSignal("messages");
  const view = render(() => (
    <section class="shell--settings">
      <HubTabs
        id="parity"
        active={active()}
        tabs={[
          { value: "messages", label: "Messages" },
          { value: "voice", label: "Voice" },
        ]}
        ariaLabel="Communications"
        panelId="communications-content"
        onSelect={setActive}
      />
      <button type="button">Ordinary setting action</button>
    </section>
  ));
  flush();
  const tabs = view.getByRole("tablist");
  const messages = view.getByRole("tab", { name: "Messages" });
  const voice = view.getByRole("tab", { name: "Voice" });
  const action = view.getByRole("button", { name: "Ordinary setting action" });
  const tokenColor = (token: string) => {
    const probe = document.createElement("span");
    probe.style.color = `var(--${token})`;
    tabs.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  };
  try {
    for (const width of [1440, 390]) {
      await page.viewport(width, 900);
      setActive("messages");
      flush();
      for (const animation of tabs.getAnimations({ subtree: true })) {
        animation.finish();
      }
      const label = getComputedStyle(voice);
      expect.soft(label.fontSize, `${width}px typography`).toBe("12px");
      expect.soft(label.fontWeight, `${width}px typography`).toBe("550");
      expect.soft(label.color, `${width}px unselected ink`).toBe(tokenColor("muted"));
      expect
        .soft(tabs.getBoundingClientRect().height, `${width}px track height`)
        .toBeCloseTo(32.6, 1);
      expect
        .soft(
          messages.getBoundingClientRect().bottom + 2,
          `${width}px selected underline stays inside the scrollport`,
        )
        .toBeLessThanOrEqual(tabs.getBoundingClientRect().bottom);
      if (width === 390) {
        expect
          .soft(action.getBoundingClientRect().height, "ordinary touch target")
          .toBeGreaterThanOrEqual(44);
      }
      messages.focus();
      await userEvent.keyboard("{ArrowRight}{Enter}");
      flush();
      expect.soft(voice.getAttribute("aria-selected")).toBe("true");
      expect
        .soft(getComputedStyle(voice).boxShadow, "selection survives the keyboard focus ring")
        .toContain(`${tokenColor("accent")} 0px 2px 0px 0px`);
    }
  } finally {
    styles.remove();
    await page.viewport(viewport.width, viewport.height);
  }
});
