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
    const top = rect.top;
    return {
      left,
      top,
      width,
      height,
      hitCorners: [
        [left + 1, top + 1],
        [left + width - 1, top + 1],
        [left + 1, top + height - 1],
        [left + width - 1, top + height - 1],
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
