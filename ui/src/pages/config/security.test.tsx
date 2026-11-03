/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { Security } from "./security.tsx";

type SecurityViewProps = Parameters<typeof Security>[0];

function expectRowByTitle(container: Element, text: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>(".settings-row")).find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === text,
  );
  return expectDefined(row, `security row "${text}"`);
}

function renderSecurity(
  security: Partial<SecurityViewProps["security"]> = {},
  overrides: Partial<Omit<SecurityViewProps, "security">> = {},
) {
  const props: SecurityViewProps = {
    security: {
      gatewayAuth: "token",
      execPolicy: "allowlist",
      browserEnabled: true,
      browserEnabledOverridden: true,
      toolProfile: "coding",
      toolProfileOverridden: true,
      ...security,
    },
    configBusy: false,
    canPairDevice: true,
    editor: undefined,
    ...overrides,
  };
  return mountSolid(() => <Security {...props} />);
}

describe("Security", () => {
  it("locks the browser toggle while config is busy", () => {
    const { container } = renderSecurity({}, { configBusy: true });
    expect(
      expectRowByTitle(container, "Browser enabled")
        .querySelector("input")
        ?.hasAttribute("disabled"),
    ).toBe(true);
  });

  it("shows gateway auth as a dot status, not a pill", () => {
    const { container } = renderSecurity({ gatewayAuth: "none" });

    const authRow = expectRowByTitle(container, "Gateway auth");
    const authStatus = authRow.querySelector(".settings-status");
    expect(authStatus?.textContent?.trim()).toBe("none");
    expect(authStatus?.classList.contains("settings-status--warn")).toBe(true);
  });

  it("embeds the schema editor below the curated overview", () => {
    const { container } = renderSecurity({}, { editor: <div data-testid="security-editor" /> });

    const page = container.querySelector(".security-page");
    expect(page).not.toBeNull();
    expect(page?.querySelector("[data-testid='security-editor']")).not.toBeNull();
  });

  it("shows inherited default descriptions", () => {
    const { container } = renderSecurity({
      browserEnabledOverridden: false,
      toolProfile: "",
      toolProfileOverridden: false,
    });

    expect(expectRowByTitle(container, "Browser enabled").textContent).not.toContain(
      "Using default:",
    );
    expect(expectRowByTitle(container, "Available tools").textContent).toContain(
      "Using core and default plugin tools. Choose Full to include available optional plugin tools.",
    );
  });
});
