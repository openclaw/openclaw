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

function part(element: Element, name: string) {
  const found = element.shadowRoot?.querySelector<HTMLElement>(`[part~="${name}"]`);
  expect(found, name).not.toBeNull();
  // Reading computed style starts CSS transitions inside this shadow root.
  const style = getComputedStyle(found!);
  void style.color;
  for (const animation of found!.getAnimations()) {
    animation.finish();
  }
  return getComputedStyle(found!);
}

describe.runIf("__vitest_browser__" in globalThis)("Web Awesome theme inheritance", () => {
  it("keeps the account menu and shared control shadow parts on the selected palette", async () => {
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
          logoutAvailable: false,
          themeMode: "dark",
          triggerWidth: 250,
          onTabAway() {},
          onClose() {},
          onNavigate() {},
          onPairMobile() {},
          onLogout() {},
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
    await Promise.all([
      menu.updateComplete,
      select.updateComplete,
      tabs.updateComplete,
      danger.updateComplete,
    ]);
    await Promise.all(
      [...menu.querySelectorAll("wa-dropdown-item")].map((item) => item.updateComplete),
    );

    await select.show();
    const { userEvent } = await import("vitest/browser");
    select.focus();
    await userEvent.keyboard("{ArrowDown}");
    const currentOption = select.querySelector<HTMLElement>("wa-option:state(current)")!;
    expect(currentOption).not.toBeNull();

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
      expect(part(help, "submenu-icon").color, theme).toBe(color("muted"));
      expect(part(help, "details").color, theme).toBe(color("muted"));
      expect(part(menu, "menu").backgroundColor, theme).toBe(color("bg-elevated"));
      expect(part(select, "listbox").backgroundColor, theme).toBe(color("popover"));
      expect(part(select, "expand-icon").color, theme).toBe(color("muted"));
      expect(part(select, "display-input").color, theme).toBe(color("text"));
      expect(part(select, "clear-button").color, theme).toBe(color("muted"));
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
