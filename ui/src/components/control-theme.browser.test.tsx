import { afterEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { renderSidebarIdentityMenu } from "./app-sidebar-identity-menu.tsx";
import { PanelTabStrip } from "./panel-tab-strip-solid.tsx";
import { Picker } from "./select-picker.ts";
import { Icon } from "./solid/icon.tsx";
import "./panel-tab-strip.css";
import "../styles/base.css";
import "../styles/layout.css";
import "../styles/sidebar-menus.css";
import "../../public/themes/absolutely.css";
import "../../public/themes/phosphor.css";

const root = document.documentElement;
const originalTheme = root.getAttribute("data-theme");
const originalMode = root.getAttribute("data-theme-mode");
const originalStyle = root.style.cssText;
let disposeControls: (() => void) | undefined;

afterEach(() => {
  disposeControls?.();
  disposeControls = undefined;
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

function settledStyle(element: Element) {
  // Start color transitions before finishing them to check the selected palette.
  void getComputedStyle(element).color;
  for (const animation of element.getAnimations()) {
    animation.finish();
  }
  return getComputedStyle(element);
}

function expectColor(
  element: Element,
  token: string,
  theme: string,
  property: "color" | "backgroundColor" | "outlineColor" = "color",
) {
  expect(settledStyle(element)[property], theme).toBe(color(token));
}

function expectThemeDefaults() {
  const style = getComputedStyle(root);
  expect(style.getPropertyValue("--control-ui-font-weight-normal").trim()).toBe("400");
  expect(style.getPropertyValue("--control-ui-font-weight-semibold").trim()).toBe("500");
  expect(style.getPropertyValue("--control-ui-transition-fast").trim()).toBe("75ms");
  expect(style.getPropertyValue("--control-ui-focus-ring").trim()).toContain("0.1875rem");
  expect(style.getPropertyValue("--control-ui-focus-ring-offset").trim()).toBe("0.0625rem");
}

it.runIf("__vitest_browser__" in globalThis)("inherits theme colors", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  disposeControls = mountSolid(
    () => (
      <>
        {renderSidebarIdentityMenu({
          position: { x: 16, bottom: 16, width: 250 },
          nativeGatewaySnapshot: null,
          canPairDevice: true,
          basePath: "",
          gatewayVersion: "test",
          updateAvailable: true,
          canRetryConnection: false,
          themeMode: "dark",
          triggerWidth: 250,
          onClose() {},
          onNavigate() {},
          onPairMobile() {},
        })}
        <Picker
          params={{
            label: "Language",
            value: "en",
            options: [
              { value: "en", label: "English" },
              { value: "fr", label: "French" },
            ],
            onChange() {},
          }}
        />
        <PanelTabStrip
          tabs={["first", "second"].map((id) => ({
            id,
            domId: `theme-${id}-tab`,
            label: id === "first" ? "First" : "Second",
            closeLabel: `Close ${id}`,
            icon: id === "first" ? <Icon name="plus" /> : undefined,
          }))}
          activeId="first"
          ariaControls="theme-panel"
          onSelect={() => {}}
          onClose={() => {}}
          onNew={() => {}}
          newLabel="New tab"
        />
        <div id="theme-panel">Content</div>
      </>
    ),
    { container: host },
  ).unmount;
  flush();
  const find = (selector: string) => host.querySelector<HTMLElement>(selector)!;
  const menu = find(".sidebar-identity-menu");
  const pickerTrigger = find(".picker-select__trigger");
  const pickerMenu = find(".picker-select__menu");
  const pickerList = find('[role="listbox"]');

  for (const theme of [
    "dark",
    "light",
    "absolutely",
    "absolutely-light",
    "phosphor",
    "phosphor-light",
    "custom",
    "custom-light",
  ]) {
    root.dataset.theme = theme;
    root.dataset.themeMode = theme.endsWith("light") ? "light" : "dark";
    if (theme.startsWith("custom")) {
      root.style.setProperty("--muted", "rgb(120, 190, 160)");
      root.style.setProperty("--text", "rgb(220, 235, 210)");
      root.style.setProperty("--accent", "rgb(190, 130, 220)");
      root.style.setProperty("--bg-elevated", "rgb(32, 45, 38)");
      root.style.setProperty("--bg-hover", "rgb(45, 62, 51)");
    }
    if (!menu.matches(":popover-open")) {
      find(".oc-menu-trigger").click();
    }
    await expect.poll(() => menu.getAttribute("data-phase")).toBe("open");
    expectThemeDefaults();
    expectColor(find(".sidebar-identity-menu__help .oc-menu-item__submenu-icon"), "muted", theme);
    expectColor(find('[data-value="command:settings"] .oc-menu-item__details'), "muted", theme);
    expectColor(menu, "bg-elevated", theme, "backgroundColor");
    expectColor(find("#theme-first-tab"), "text", theme);
    expectColor(find("#theme-first-tab"), "bg-hover", theme, "backgroundColor");
    expectColor(find("#theme-second-tab"), "muted", theme);
    expectColor(find("#theme-first-tab .tabstrip-tab__icon"), "accent", theme);

    pickerTrigger.click();
    await expect.poll(() => pickerMenu.getAttribute("data-phase")).toBe("open");
    await expect.element(menu).not.toBeVisible();
    await expect.element(pickerList).toHaveFocus();
    await userEvent.keyboard("{End}");
    const currentOption = find('[role="option"][data-value="fr"]');
    await expect
      .poll(() => pickerList.getAttribute("aria-activedescendant"))
      .toBe(currentOption.id);
    expectColor(pickerMenu, "bg-elevated", theme, "backgroundColor");
    expectColor(find(".picker-select__trigger .picker-select__label"), "text", theme);
    expectColor(find(".picker-select__trigger .picker-select__chevron"), "muted", theme);
    expectColor(currentOption, "text", theme);
    expectColor(currentOption, "text", theme, "outlineColor");
    expect(settledStyle(currentOption).outlineStyle, theme).toBe("solid");
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => pickerMenu.getAttribute("data-phase")).toBe("hidden");
  }
});
