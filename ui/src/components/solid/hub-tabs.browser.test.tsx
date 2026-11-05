import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { HubTabs } from "./hub-tabs.tsx";
import baseStyles from "../../styles/base.css?inline";
import hubStyles from "../../styles/hub-tabs.css?inline";
import settingsControlStyles from "../../styles/settings-controls.css?inline";
import settingsStyles from "../../styles/settings.css?inline";
import tabsStyles from "../../styles/tabs.css?inline";

function hubProps(id: string, onSelect: (value: string) => void, labels = ["First", "Second"]) {
  return {
    id,
    onSelect,
    ariaLabel: "Sections",
    panelId: `${id}-panel`,
    tabs: labels.map((label) => ({ value: label.toLowerCase(), label })),
  };
}

it("preserves hub styling when native defaults load last", async () => {
  const viewport = { width: innerWidth, height: innerHeight };
  const styles = document.createElement("style");
  styles.textContent = [
    baseStyles,
    settingsControlStyles,
    settingsStyles,
    hubStyles,
    tabsStyles,
  ].join("\n");
  document.head.append(styles);
  const [active, setActive] = createSignal("messages");
  const view = mountSolid(() => (
    <section class="shell--settings">
      <HubTabs
        {...hubProps("parity", setActive, ["Messages", "Voice"])}
        active={active()}
        ariaLabel="Communications"
        panelId="communications-content"
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
      await userEvent.hover(action);
      setActive("messages");
      flush();
      for (const animation of tabs.getAnimations({ subtree: true })) {
        animation.finish();
      }
      const label = getComputedStyle(voice);
      expect.soft(label.fontSize).toBe("12px");
      expect.soft(label.fontWeight).toBe("550");
      expect.soft(label.letterSpacing).toBe(getComputedStyle(document.body).letterSpacing);
      expect.soft(label.color).toBe(tokenColor("muted"));
      expect.soft(tabs.getBoundingClientRect().height).toBeCloseTo(32.6, 1);
      expect
        .soft(messages.getBoundingClientRect().bottom + 2)
        .toBeLessThanOrEqual(tabs.getBoundingClientRect().bottom);
      messages.focus();
      await userEvent.keyboard("{ArrowRight}{Enter}");
      flush();
      expect.soft(voice.getAttribute("aria-selected")).toBe("true");
      expect
        .soft(getComputedStyle(voice).boxShadow)
        .toContain(`${tokenColor("accent")} 0px 2px 0px 0px`);
    }
  } finally {
    styles.remove();
    await page.viewport(viewport.width, viewport.height);
  }
});

it.each([
  ["settings first", settingsStyles, hubStyles],
  ["settings last", hubStyles, settingsStyles],
])("keeps the stacked workspace gap with %s", (_order, first, second) => {
  const styles = document.createElement("style");
  styles.textContent = [baseStyles, first, second].join("\n");
  document.head.append(styles);
  const view = mountSolid(() => (
    <>
      <section class="content-header hub-page-header hub-page-header--stacked">
        Stacked header
      </section>
      <section class="settings-workspace">Stacked workspace</section>
      <section class="content-header">Ordinary header</section>
      <section class="settings-workspace">Ordinary workspace</section>
    </>
  ));
  flush();
  try {
    expect(getComputedStyle(view.getByText("Stacked workspace")).marginTop).toBe("0px");
    expect(getComputedStyle(view.getByText("Ordinary workspace")).marginTop).toBe("20px");
  } finally {
    view.unmount();
    styles.remove();
  }
});

it.each(["ltr", "rtl"] as const)(
  "reveals the active tab only at phone width in %s",
  async (direction) => {
    const viewport = { width: innerWidth, height: innerHeight };
    const styles = document.createElement("style");
    styles.textContent = [baseStyles, hubStyles, tabsStyles].join("\n");
    document.head.append(styles);
    const [active, setActive] = createSignal("alpha");
    const view = mountSolid(() => (
      <div dir={direction} style="width:160px">
        <HubTabs
          {...hubProps("reveal", setActive, ["Alpha", "Bravo", "Charlie", "Delta", "Echo"])}
          active={active()}
        />
      </div>
    ));
    flush();
    const strip = view.getByRole("tablist");
    const select = async (value: string) => {
      setActive(value);
      flush();
      await nextFrame();
      await nextFrame();
    };
    const farEdge = direction === "rtl" ? "atStart" : "atEnd";
    try {
      await page.viewport(390, 844);
      await vi.waitFor(() => expect(strip.dataset[farEdge]).toBe("false"));

      await select("charlie");
      const charlie = view.getByRole("tab", { name: "Charlie" }).getBoundingClientRect();
      const bounds = strip.getBoundingClientRect();
      const padding = getComputedStyle(strip);
      expect(charlie.left).toBeGreaterThanOrEqual(
        bounds.left + Number.parseFloat(padding.scrollPaddingLeft) - 1,
      );
      expect(charlie.right).toBeLessThanOrEqual(
        bounds.right - Number.parseFloat(padding.scrollPaddingRight) + 1,
      );

      await select("echo");
      const echo = view.getByRole("tab", { name: "Echo" }).getBoundingClientRect();
      expect(Math.abs(strip.scrollLeft)).toBeGreaterThan(0);
      expect(echo.left).toBeGreaterThanOrEqual(strip.getBoundingClientRect().left - 1);
      expect(echo.right).toBeLessThanOrEqual(strip.getBoundingClientRect().right + 1);
      await vi.waitFor(() => expect(strip.dataset[farEdge]).toBe("true"));

      await select("alpha");
      expect(Math.abs(strip.scrollLeft)).toBeLessThanOrEqual(1);

      await page.viewport(1440, 900);
      const desktopPosition = strip.scrollLeft;
      await select("echo");
      expect(strip.scrollLeft).toBe(desktopPosition);
    } finally {
      await page.viewport(viewport.width, viewport.height);
      view.unmount();
      styles.remove();
    }
  },
);

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

const hosts: HTMLElement[] = [];

afterEach(() => {
  cleanupSolid();
  hosts.splice(0).forEach((host) => host.remove());
  vi.restoreAllMocks();
});

it("applies the hub skin and keeps one keyboard owner inside a closed shadow root", async () => {
  const host = document.createElement("section");
  host.style.cssText =
    "--control-ui-text-sm:19px;--space-1:4px;--space-2:8px;--muted:rgb(90 90 90)";
  document.body.append(host);
  hosts.push(host);
  const root = host.attachShadow({ mode: "closed" });
  const container = root.appendChild(document.createElement("div"));
  const onSelect = vi.fn();
  mountSolid(() => <HubTabs {...hubProps("shadow", onSelect)} active="first" />, { container });
  flush();
  await Promise.resolve();
  const tab = container.querySelector<HTMLButtonElement>(".hub-tab")!;
  expect(getComputedStyle(tab)).toMatchObject({
    appearance: "none",
    borderTopWidth: "0px",
    display: "flex",
    fontSize: "19px",
    paddingTop: "4px",
  });
  container
    .querySelector("#shadow-tab-second")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("second");
});
