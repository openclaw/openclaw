import type { ElementHandle, Locator, Page } from "playwright";
import { controlUiE2eWaitTimeoutMs } from "./control-ui-e2e-readiness.ts";

/** Click once native pointer routing has caught up with the entire iframe layout. */
export async function clickBoardWidgetControl(page: Page, control: Locator): Promise<void> {
  const deadline = Date.now() + controlUiE2eWaitTimeoutMs;
  const target = await control.elementHandle();
  if (!target) {
    throw new Error("Board widget control is unavailable.");
  }
  const elements: ElementHandle<Node>[] = [target];
  const pointer = await target.evaluateHandle((element) => {
    let event: PointerEvent | undefined;
    const observe = (received: Event) => {
      if (received instanceof PointerEvent && received.isTrusted) {
        event = received;
      }
    };
    element.addEventListener("pointermove", observe, true);
    return {
      reset: () => {
        event = undefined;
      },
      received: () => {
        const root = element.getRootNode();
        const hit =
          event && (root instanceof Document || root instanceof ShadowRoot)
            ? root.elementFromPoint(event.clientX, event.clientY)
            : null;
        return hit !== null && element.contains(hit);
      },
      dispose: () => element.removeEventListener("pointermove", observe, true),
    };
  });
  try {
    for (let frame = await target.ownerFrame(); frame?.parentFrame(); frame = frame.parentFrame()) {
      elements.push(await frame.frameElement());
    }
    const layout = () =>
      Promise.all(
        elements.map((element) =>
          element.evaluate((node) => {
            if (!(node instanceof Element)) {
              throw new Error("Expected a widget frame element.");
            }
            return new Promise<number[]>((resolve) => {
              requestAnimationFrame(() => {
                const { x, y, width, height } = node.getBoundingClientRect();
                resolve([x, y, width, height, window.innerWidth, window.innerHeight]);
              });
            });
          }),
        ),
      );
    await target.waitForElementState("enabled", { timeout: controlUiE2eWaitTimeoutMs });
    for (;;) {
      // A stationary pointer and :hover can both retain the pre-resize routing decision.
      await page.mouse.move(0, 0);
      const before = await layout();
      await pointer.evaluate((state) => state.reset());
      await target.hover({ timeout: Math.max(1, deadline - Date.now()) });
      const after = await layout();
      if (
        before.every((rect, index) =>
          rect.every((value, axis) => value === after[index]?.[axis]),
        ) &&
        (await pointer.evaluate((state) => state.received()))
      ) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error("Board widget control never received pointer events at a stable target.");
      }
    }
  } finally {
    try {
      await pointer.evaluate((state) => state.dispose());
    } finally {
      await Promise.all([pointer.dispose(), ...elements.map((element) => element.dispose())]);
    }
  }
  // Keep the acknowledged position: another locator action can scroll or move the
  // pointer while a cross-origin frame's compositor is still applying its resize.
  await page.mouse.down();
  await page.mouse.up();
}
