/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { renderSecurity } from "./security.tsx";

type SecurityViewProps = Parameters<typeof renderSecurity>[0];

type SecurityControl = HTMLButtonElement | HTMLLabelElement;

function expectButtonByText(container: Element, text: string): SecurityControl {
  const button = Array.from(
    container.querySelectorAll<SecurityControl>("button, label.settings-segmented__btn"),
  ).find((candidate) => candidate.textContent?.trim() === text);
  if (!(button instanceof HTMLElement)) {
    throw new Error(`Expected button labelled ${text}`);
  }
  return button;
}

function selectRadio(control: SecurityControl) {
  const input = control.querySelector<HTMLInputElement>(".settings-segmented__input");
  expect(input).not.toBeNull();
  input?.click();
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
    editor: undefined,
    ...overrides,
  };
}

describe("renderSecurity", () => {
  it("lets operators change browser and tool profile from the overview", () => {
    const onBrowserEnabledToggle = vi.fn();
    const onToolProfileChange = vi.fn();

    const { container } = mountSolid(() =>
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

  it("locks config-backed controls while a config operation is pending", () => {
    const onToolProfileChange = vi.fn();

    const { container } = mountSolid(() =>
      renderSecurity(createProps({ configBusy: true, onToolProfileChange })),
    );

    const profileButton = expectButtonByText(
      expectRowByTitle(container, "Available tools"),
      "Full",
    );
    expect(
      profileButton.querySelector<HTMLInputElement>(".settings-segmented__input")?.disabled,
    ).toBe(true);
    profileButton.click();
    expect(onToolProfileChange).not.toHaveBeenCalled();
    const browserRow = expectRowByTitle(container, "Browser enabled");
    expect(browserRow.querySelector<HTMLInputElement>(".settings-toggle__input")?.disabled).toBe(
      true,
    );
  });

  it("shows gateway auth as a dot status, not a pill", () => {
    const { container } = mountSolid(() =>
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
    );

    const authRow = expectRowByTitle(container, "Gateway auth");
    const authStatus = authRow.querySelector(".settings-status");
    expect(authStatus?.textContent?.trim()).toBe("none");
    expect(authStatus?.classList.contains("settings-status--warn")).toBe(true);
  });

  it("opens mobile pairing from the overview", () => {
    const onPairMobile = vi.fn();

    const { container } = mountSolid(() => renderSecurity(createProps({ onPairMobile })));

    expectRowByTitle(container, "Pair a device");
    const button = expectButtonByText(container, "Pair device");
    expect(button).toHaveProperty("disabled", false);
    button.click();
    expect(onPairMobile).toHaveBeenCalledOnce();
  });

  it("embeds the schema editor below the curated overview", () => {
    const { container } = mountSolid(() =>
      renderSecurity(createProps({ editor: <div data-testid="security-editor" /> })),
    );

    const page = container.querySelector(".security-page");
    expect(page).not.toBeNull();
    expect(page?.querySelector("[data-testid='security-editor']")).not.toBeNull();
  });

  it("shows inherited default descriptions", () => {
    const { container } = mountSolid(() =>
      renderSecurity(
        createProps({
          security: {
            gatewayAuth: "token",
            execPolicy: "allowlist",
            browserEnabled: true,
            browserEnabledOverridden: false,
            toolProfile: "",
            toolProfileOverridden: false,
          },
        }),
      ),
    );

    expect(expectRowByTitle(container, "Browser enabled").textContent).not.toContain(
      "Using default:",
    );
    expect(expectRowByTitle(container, "Available tools").textContent).toContain(
      "Using core and default plugin tools. Choose Full to include available optional plugin tools.",
    );
  });

  it.each([
    { profile: "", overridden: false, busy: false, writes: 1 },
    { profile: "full", overridden: true, busy: false, writes: 0 },
    { profile: "", overridden: false, busy: true, writes: 0 },
  ])(
    "selects Full without a reselection path: $profile/$busy",
    ({ profile, overridden, busy, writes }) => {
      const props = createProps();
      const onToolProfileChange = vi.fn();
      const { container } = mountSolid(() =>
        renderSecurity({
          ...props,
          security: {
            ...props.security,
            toolProfile: profile,
            toolProfileOverridden: overridden,
          },
          configBusy: busy,
          onToolProfileChange,
        }),
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
