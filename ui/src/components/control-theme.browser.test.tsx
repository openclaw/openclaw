import { afterEach, describe, expect, it } from "vitest";
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

function expectThemeDefaults() {
  const style = getComputedStyle(root);
  expect(style.getPropertyValue("--control-ui-font-weight-normal").trim()).toBe("400");
  expect(style.getPropertyValue("--control-ui-font-weight-semibold").trim()).toBe("500");
  expect(style.getPropertyValue("--control-ui-transition-fast").trim()).toBe("75ms");
  expect(style.getPropertyValue("--control-ui-focus-ring").trim()).toContain("0.1875rem");
  expect(style.getPropertyValue("--control-ui-focus-ring-offset").trim()).toBe("0.0625rem");
}

describe.runIf("__vitest_browser__" in globalThis)("shared control theme inheritance", () => {
  it("keeps the account menu, picker, and panel tabs on the selected palette", async () => {
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
            tabs={[
              {
                id: "first",
                domId: "theme-first-tab",
                label: "First",
                closeLabel: "Close first",
                icon: <Icon name="plus" />,
              },
              {
                id: "second",
                domId: "theme-second-tab",
                label: "Second",
                closeLabel: "Close second",
              },
            ]}
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
    const menu = host.querySelector<HTMLElement>(".sidebar-identity-menu")!;
    const submenuIndicator = host.querySelector(
      ".sidebar-identity-menu__help .oc-menu-item__submenu-icon",
    )!;
    const settingsDetails = host.querySelector(
      '[data-value="command:settings"] .oc-menu-item__details',
    )!;
    const menuTrigger = host.querySelector<HTMLButtonElement>(".oc-menu-trigger")!;
    const pickerTrigger = host.querySelector<HTMLButtonElement>(".picker-select__trigger")!;
    const pickerMenu = host.querySelector(".picker-select__menu")!;
    const pickerList = host.querySelector<HTMLElement>('[role="listbox"]')!;
    const currentOption = host.querySelector<HTMLElement>('[role="option"][data-value="fr"]')!;
    const activeTab = host.querySelector("#theme-first-tab")!;
    const inactiveTab = host.querySelector("#theme-second-tab")!;

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
        menuTrigger.click();
      }
      await expect.poll(() => menu.getAttribute("data-phase")).toBe("open");
      expectThemeDefaults();
      expect(settledStyle(submenuIndicator).color, theme).toBe(color("muted"));
      expect(settledStyle(settingsDetails).color, theme).toBe(color("muted"));
      expect(settledStyle(menu).backgroundColor, theme).toBe(color("bg-elevated"));
      expect(settledStyle(activeTab).color, theme).toBe(color("text"));
      expect(settledStyle(activeTab).backgroundColor, theme).toBe(color("bg-hover"));
      expect(settledStyle(inactiveTab).color, theme).toBe(color("muted"));
      expect(settledStyle(activeTab.querySelector(".tabstrip-tab__icon")!).color, theme).toBe(
        color("accent"),
      );

      pickerTrigger.click();
      await expect.poll(() => pickerMenu.getAttribute("data-phase")).toBe("open");
      await expect.element(menu).not.toBeVisible();
      await expect.element(pickerList).toHaveFocus();
      await userEvent.keyboard("{End}");
      await expect
        .poll(() => pickerList.getAttribute("aria-activedescendant"))
        .toBe(currentOption.id);
      expect(settledStyle(pickerMenu).backgroundColor, theme).toBe(color("bg-elevated"));
      expect(settledStyle(pickerTrigger.querySelector(".picker-select__label")!).color, theme).toBe(
        color("text"),
      );
      expect(
        settledStyle(pickerTrigger.querySelector(".picker-select__chevron")!).color,
        theme,
      ).toBe(color("muted"));
      expect(settledStyle(currentOption).color, theme).toBe(color("text"));
      expect(settledStyle(currentOption).outlineColor, theme).toBe(color("text"));
      expect(settledStyle(currentOption).outlineStyle, theme).toBe("solid");
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => pickerMenu.getAttribute("data-phase")).toBe("hidden");
    }
  });
});
