/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { renderSecurity } from "./security.ts";

type SecurityViewProps = Parameters<typeof renderSecurity>[0];

type SecurityControl = HTMLButtonElement | HTMLLabelElement;

function expectButtonByText(container: Element, text: string): SecurityControl {
  const button = Array.from(
    container.querySelectorAll<SecurityControl>("button, .settings-segmented__btn"),
  ).find((candidate) => candidate.textContent?.trim() === text);
  if (!(button instanceof HTMLElement)) {
    throw new Error(`Expected button labelled ${text}`);
  }
  return button;
}

function selectRadio(control: SecurityControl) {
  control.querySelector<HTMLInputElement>(".settings-segmented__input")!.click();
}

function expectRowByTitle(container: Element, text: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>(".settings-row")).find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === text,
  );
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Expected security row "${text}"`);
  }
  return row;
}

function createProps(overrides: Partial<SecurityViewProps> = {}): SecurityViewProps {
  return {
    security: {
      gatewayAuth: "token",
      execPolicy: "allowlist",
      browserEnabled: true,
      browserEnabledOverridden: true,
      toolProfile: "coding",
      toolProfileOverridden: true,
    },
    configBusy: false,
    canPairDevice: true,
    onPairMobile: vi.fn(),
    onBrowserEnabledToggle: vi.fn(),
    onToolProfileChange: vi.fn(),
    editor: html``,
    ...overrides,
  };
}

describe("renderSecurity", () => {
  it("lets operators change browser and tool profile from the overview", () => {
    const onBrowserEnabledToggle = vi.fn();
    const onToolProfileChange = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    onTestFinished(() => container.remove());

    render(
      renderSecurity(
        createProps({
          security: {
            gatewayAuth: "token",
            execPolicy: "allowlist",
            browserEnabled: false,
            browserEnabledOverridden: true,
            toolProfile: "messaging",
            toolProfileOverridden: true,
          },
          onBrowserEnabledToggle,
          onToolProfileChange,
        }),
      ),
      container,
    );

    const browserRow = expectRowByTitle(container, "Browser enabled");
    const browserInput = browserRow.querySelector<HTMLInputElement>(".settings-toggle__input");
    expect(browserInput).toBeInstanceOf(HTMLInputElement);
    expect(browserInput?.checked).toBe(false);
    if (!browserInput) {
      throw new Error("Expected browser switch");
    }
    browserInput.click();
    expect(onBrowserEnabledToggle).toHaveBeenCalledWith(true);

    selectRadio(expectButtonByText(container, "Full"));
    expect(onToolProfileChange).toHaveBeenCalledWith("full");
    const activeProfile = expectButtonByText(container, "Messaging");
    expect(activeProfile.classList.contains("settings-segmented__btn--active")).toBe(true);
  });

  it("shows gateway auth as a dot status, not a pill", () => {
    const container = document.createElement("div");

    render(
      renderSecurity(
        createProps({
          security: {
            gatewayAuth: "none",
            execPolicy: "allowlist",
            browserEnabled: true,
            browserEnabledOverridden: false,
            toolProfile: "",
            toolProfileOverridden: false,
          },
        }),
      ),
      container,
    );

    const authRow = expectRowByTitle(container, "Gateway auth");
    const authStatus = authRow.querySelector(".settings-status");
    expect(authStatus?.textContent?.trim()).toBe("none");
    expect(authStatus?.classList.contains("settings-status--warn")).toBe(true);
  });

  it.each([{ profile: "full", overridden: true, busy: false, writes: 0 }])(
    "selects Full without a reselection path: $profile/$busy",
    ({ profile, overridden, busy, writes }) => {
      const props = createProps();
      const onToolProfileChange = vi.fn();
      const container = document.createElement("div");
      document.body.append(container);
      onTestFinished(() => container.remove());
      render(
        renderSecurity({
          ...props,
          security: { ...props.security, toolProfile: profile, toolProfileOverridden: overridden },
          configBusy: busy,
          onToolProfileChange,
        }),
        container,
      );

      expect(onToolProfileChange).not.toHaveBeenCalled();
      expect(container.querySelectorAll(".settings-segmented__input")).toHaveLength(4);
      expect(container.querySelectorAll(".settings-segmented__btn--active")).toHaveLength(
        overridden ? 1 : 0,
      );
      const full = expectButtonByText(container, "Full");
      if (busy || overridden) {
        full.click();
      } else {
        selectRadio(full);
      }
      expect(onToolProfileChange).toHaveBeenCalledTimes(writes);
      if (writes > 0) {
        expect(onToolProfileChange).toHaveBeenCalledWith("full");
      }
    },
  );
});
