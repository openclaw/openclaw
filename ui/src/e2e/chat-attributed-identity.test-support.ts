import { expect, type Locator } from "playwright/test";

export async function readFooterGeometry(group: Locator) {
  return group.locator(".chat-group-footer").evaluate((footer) => {
    const actions = footer.querySelector<HTMLElement>(".chat-group-footer-actions");
    const identity = footer.querySelector<HTMLElement>(".chat-group-footer__meta");
    const name = footer.querySelector<HTMLElement>(".chat-sender-name");
    if (!actions || !identity || !name) {
      throw new Error("Expected message footer identity and actions");
    }
    const actionsRect = actions.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const identityRect = identity.getBoundingClientRect();
    const nameRect = name.getBoundingClientRect();
    return {
      actions: {
        left: actionsRect.left,
        right: actionsRect.right,
        top: actionsRect.top,
        bottom: actionsRect.bottom,
      },
      identity: {
        top: identityRect.top,
        bottom: identityRect.bottom,
        left: identityRect.left,
        right: identityRect.right,
      },
      footer: { right: footerRect.right },
      name: { left: nameRect.left - footerRect.left, top: nameRect.top - footerRect.top },
    };
  });
}

export async function readActionTapArea(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  return control.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const extension = getComputedStyle(button, "::before");
    const width = extension.content === "none" ? rect.width : Number.parseFloat(extension.width);
    const height = extension.content === "none" ? rect.height : Number.parseFloat(extension.height);
    const left = rect.left + (rect.width - width) / 2;
    const top = rect.top + (extension.content === "none" ? 0 : Number.parseFloat(extension.top));
    return {
      left,
      top,
      width,
      height,
      // Mobile hit testing rounds fractional CSS edges; probe 2px inside them.
      // Target dimensions and containment are checked separately.
      hitCorners: [
        [left + 2, top + 2],
        [left + width - 2, top + 2],
        [left + 2, top + height - 2],
        [left + width - 2, top + height - 2],
      ].filter(([x, y]) => document.elementFromPoint(x, y)?.closest("button") === button).length,
    };
  });
}

export function expectStableNamePosition(
  actual: { left: number; top: number },
  expected: { left: number; top: number },
) {
  expect(actual.left).toBe(expected.left);
  expect(actual.top).toBeCloseTo(expected.top, 0);
}
