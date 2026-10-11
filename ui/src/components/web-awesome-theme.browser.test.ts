import { html, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { renderSidebarIdentityMenu } from "./app-sidebar-identity-menu.ts";
import "./web-awesome-select.ts";
import "./web-awesome-tabs.ts";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "../styles/base.css";
import "../styles/layout.css";
import "../../public/themes/absolutely.css";
import "../../public/themes/phosphor.css";

const root = document.documentElement;
const originalTheme = root.getAttribute("data-theme");
const originalMode = root.getAttribute("data-theme-mode");
const originalClass = root.className;
const originalStyle = root.style.cssText;

afterEach(() => {
  document.body.replaceChildren();
  for (const [name, value] of [
    ["data-theme", originalTheme],
    ["data-theme-mode", originalMode],
  ] as const) {
    if (value === null) {
      root.removeAttribute(name);
    } else {
      root.setAttribute(name, value);
    }
  }
  root.className = originalClass;
  root.style.cssText = originalStyle;
});

function color(token: string) {
  const probe = document.createElement("span");
  probe.style.color = `var(--${token})`;
  document.body.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}

function controlStyle(
  element: Element,
  surface:
    | "submenu indicator"
    | "item description"
    | "menu"
    | "options"
    | "select indicator"
    | "selected value"
    | "clear selection",
) {
  // This adapter is the only palette-test dependency on the current renderer.
  const name = {
    "submenu indicator": "submenu-icon",
    "item description": "details",
    menu: "menu",
    options: "listbox",
    "select indicator": "expand-icon",
    "selected value": "display-input",
    "clear selection": "clear-button",
  }[surface];
  const found = element.shadowRoot?.querySelector<HTMLElement>(`[part~="${name}"]`);
  expect(found, surface).not.toBeNull();
  // Reading computed style starts CSS transitions inside this shadow root.
  const style = getComputedStyle(found!);
  void style.color;
  for (const animation of found!.getAnimations()) {
    animation.finish();
  }
  return getComputedStyle(found!);
}

async function prepareControls(host: HTMLElement) {
  const controls = host.querySelectorAll<HTMLElement & { updateComplete: Promise<boolean> }>(
    "wa-dropdown, wa-dropdown-item, wa-select, wa-tab-group",
  );
  await Promise.all([...controls].map((control) => control.updateComplete));
}

async function focusNextOption(select: HTMLElement) {
  const control = select as HTMLElementTagNameMap["wa-select"];
  await control.show();
  const { userEvent } = await import("vitest/browser");
  control.focus();
  await userEvent.keyboard("{ArrowDown}");
  const current = control.querySelector<HTMLElement>("wa-option:state(current)");
  expect(current, "keyboard-focused option").not.toBeNull();
  return current!;
}

function expectThemeDefaults() {
  const style = getComputedStyle(root);
  expect(style.getPropertyValue("--wa-font-weight-normal").trim()).toBe("400");
  expect(style.getPropertyValue("--wa-font-weight-semibold").trim()).toBe("500");
  expect(style.getPropertyValue("--wa-transition-fast").trim()).toBe("75ms");
  expect(style.getPropertyValue("--wa-focus-ring").trim()).toContain("0.1875rem");
  expect(style.getPropertyValue("--wa-focus-ring-offset").trim()).toBe("0.0625rem");
}

describe.runIf("__vitest_browser__" in globalThis)("shared control theme inheritance", () => {
  it("keeps the account menu and shared controls on the selected palette", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    render(
      html`
        ${renderSidebarIdentityMenu({
          position: { x: 16, bottom: 16, width: 250 },
          canPairDevice: true,
          basePath: "",
          gatewayVersion: "test",
          updateAttentionDismissed: true,
          canRetryConnection: false,
          themeMode: "dark",
          triggerWidth: 250,
          onTabAway() {},
          onClose() {},
          onNavigate() {},
          onPairMobile() {},
        })}
        <wa-select label="Language" with-clear value="en">
          <wa-option value="en">English</wa-option>
        </wa-select>
        <wa-tab-group
          ><wa-tab panel="first">First</wa-tab
          ><wa-tab-panel name="first">Content</wa-tab-panel></wa-tab-group
        >
        <wa-dropdown-item variant="danger">Delete</wa-dropdown-item>
      `,
      host,
    );
    const menu = host.querySelector("wa-dropdown")!;
    const help = host.querySelector<HTMLElement>(".sidebar-identity-menu__help")!;
    const select = host.querySelector("wa-select")!;
    const tabs = host.querySelector("wa-tab-group")!;
    const danger = [...host.querySelectorAll("wa-dropdown-item")].find(
      (item) => item.variant === "danger",
    )!;
    await prepareControls(host);
    const currentOption = await focusNextOption(select);

    for (const theme of [
      "dark",
      "absolutely",
      "absolutely-light",
      "phosphor",
      "phosphor-light",
      "custom",
    ]) {
      const mode = theme.endsWith("light") ? "light" : "dark";
      root.dataset.theme = theme;
      root.dataset.themeMode = mode;
      root.classList.toggle("wa-dark", mode === "dark");
      root.classList.toggle("wa-light", mode === "light");
      if (theme === "custom") {
        root.style.setProperty("--muted", "rgb(120, 190, 160)");
        root.style.setProperty("--text", "rgb(220, 235, 210)");
        root.style.setProperty("--accent", "rgb(190, 130, 220)");
        root.style.setProperty("--popover", "rgb(32, 45, 38)");
        root.style.setProperty("--danger", "rgb(240, 135, 150)");
      }
      // Finish existing library color transitions; this test checks settled palette inheritance.
      for (const animation of document.getAnimations()) {
        animation.finish();
      }
      expectThemeDefaults();
      expect(controlStyle(help, "submenu indicator").color, theme).toBe(color("muted"));
      expect(controlStyle(help, "item description").color, theme).toBe(color("muted"));
      expect(controlStyle(menu, "menu").backgroundColor, theme).toBe(color("bg-elevated"));
      expect(controlStyle(select, "options").backgroundColor, theme).toBe(color("popover"));
      expect(controlStyle(select, "select indicator").color, theme).toBe(color("muted"));
      expect(controlStyle(select, "selected value").color, theme).toBe(color("text"));
      expect(controlStyle(select, "clear selection").color, theme).toBe(color("muted"));
      expect(getComputedStyle(tabs).getPropertyValue("--indicator-color").trim(), theme).toBe(
        getComputedStyle(root).getPropertyValue("--accent").trim(),
      );
      expect(getComputedStyle(danger).color, theme).toBe(color("danger"));
      for (const animation of currentOption.getAnimations()) {
        animation.finish();
      }
      expect(getComputedStyle(currentOption).color, theme).toBe(color("text"));
      expect(getComputedStyle(currentOption).backgroundColor, theme).toBe(color("bg-hover"));
    }
  });
});
