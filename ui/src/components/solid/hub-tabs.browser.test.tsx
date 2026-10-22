import { createComponent, createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { HubTabs } from "./hub-tabs.tsx";
import baseStyles from "../../styles/base.css?inline";
import hubStyles from "../../styles/hub-tabs.css?inline";
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
  styles.textContent = [baseStyles, settingsStyles, hubStyles, tabsStyles].join("\n");
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
      if (width === 390) {
        expect.soft(action.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      }
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

const hosts: HTMLElement[] = [];

afterEach(() => {
  cleanupSolid();
  hosts.splice(0).forEach((host) => host.remove());
  vi.restoreAllMocks();
});

function shadow() {
  const host = document.createElement("section");
  host.style.cssText =
    "--control-ui-text-sm:19px;--space-1:4px;--space-2:8px;--muted:rgb(90 90 90)";
  document.body.append(host);
  hosts.push(host);
  return host.attachShadow({ mode: "closed" });
}

function mountShadowHub(root: ShadowRoot, id: string) {
  const container = document.createElement("div");
  root.append(container);
  const onSelect = vi.fn();
  const props = { ...hubProps(id, onSelect), active: "first" };
  const view = mountSolid(() => createComponent(HubTabs, props), { container });
  flush();
  return { container, dispose: view.unmount, onSelect };
}

function sheets(root: ShadowRoot) {
  return [...root.querySelectorAll<HTMLStyleElement>("style[data-openclaw-overlay-style]")];
}

function expectSkin(container: HTMLElement) {
  const tab = container.querySelector<HTMLButtonElement>(".hub-tab")!;
  const style = getComputedStyle(tab);
  expect(style.appearance).toBe("none");
  expect(style.borderTopWidth).toBe("0px");
  expect(style.display).toBe("flex");
  expect(style.fontSize).toBe("19px");
  expect(style.paddingTop).toBe("4px");
}

it("shares tab skins and keeps one keyboard owner inside a closed shadow root", async () => {
  const first = shadow();
  const moved = mountShadowHub(first, "moved");
  const retained = mountShadowHub(first, "retained");
  await Promise.resolve();
  expectSkin(moved.container);
  expectSkin(retained.container);
  expect(sheets(first)).toHaveLength(2);

  moved.container
    .querySelector("#moved-tab-second")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(moved.onSelect).toHaveBeenCalledExactlyOnceWith("second");

  retained.dispose();
  expect(sheets(first)).toHaveLength(2);
  moved.dispose();
  expect(sheets(first)).toHaveLength(0);
});
