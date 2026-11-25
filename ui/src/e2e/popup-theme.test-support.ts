import type { Locator } from "playwright";

type PopupPaint = {
  background: string;
  border: string;
  shadow: string;
};

export async function readThemedPopupPaint(
  host: Locator,
  partName: "body" | "submenu" | "surface",
): Promise<{ actual: PopupPaint; expected: PopupPaint }> {
  return host.evaluate((element, popupPart) => {
    const surface =
      popupPart === "surface" || element.matches(".oc-popover")
        ? element
        : element.shadowRoot?.querySelector<HTMLElement>(`[part~="${popupPart}"]`);
    if (!surface) {
      throw new Error(`Popup ${popupPart} surface did not render`);
    }
    const probe = document.createElement("span");
    probe.style.cssText =
      "position:fixed;background:var(--menu-surface);border:0;box-shadow:var(--menu-shadow)";
    document.body.append(probe);
    const actual = getComputedStyle(surface);
    const expected = getComputedStyle(probe);
    const result = {
      actual: {
        background: actual.backgroundColor,
        border: actual.borderTopWidth,
        shadow: actual.boxShadow,
      },
      expected: {
        background: expected.backgroundColor,
        border: expected.borderTopWidth,
        shadow: expected.boxShadow,
      },
    };
    probe.remove();
    return result;
  }, partName);
}
