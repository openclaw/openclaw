import { createComponent, createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { HubTabs } from "./hub-tabs.tsx";
import baseStyles from "../../styles/base.css?inline";
import hubStyles from "../../styles/hub-tabs.css?inline";
import settingsStyles from "../../styles/settings.css?inline";
import tabsStyles from "../../styles/tabs.css?inline";

it("keeps hub typography, selected ink, and compact height when native defaults load last", async () => {
  const viewport = { width: innerWidth, height: innerHeight };
  const styles = document.createElement("style");
  styles.textContent = [baseStyles, settingsStyles, hubStyles, tabsStyles].join("\n");
  document.head.append(styles);
  const [active, setActive] = createSignal("messages");
  const view = mountSolid(() => (
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
      await userEvent.hover(action);
      setActive("messages");
      flush();
      for (const animation of tabs.getAnimations({ subtree: true })) {
        animation.finish();
      }
      const label = getComputedStyle(voice);
      expect.soft(label.fontSize, `${width}px typography`).toBe("12px");
      expect.soft(label.fontWeight, `${width}px typography`).toBe("550");
      expect
        .soft(label.letterSpacing, `${width}px typography`)
        .toBe(getComputedStyle(document.body).letterSpacing);
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

const disposers: (() => void)[] = [];
const hosts: HTMLElement[] = [];

afterEach(() => {
  disposers
    .splice(0)
    .toReversed()
    .forEach((dispose) => dispose());
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
  const props = {
    id,
    active: "first",
    tabs: [
      { value: "first", label: "First" },
      { value: "second", label: "Second" },
    ],
    ariaLabel: "Sections",
    panelId: `${id}-panel`,
    onSelect,
  };
  const view = mountSolid(() => createComponent(HubTabs, props), { container });
  flush();
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    view.unmount();
    container.remove();
  };
  disposers.push(dispose);
  return { container, dispose, onSelect };
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
  return tab;
}

describe("native hub shadow styles", () => {
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
});
