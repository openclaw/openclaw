import type { Locator } from "playwright";
import { controlUiE2eWaitTimeoutMs } from "./control-ui-e2e-readiness.ts";

/** Scroll the real viewport until a windowed row exists, then reveal its control. */
export async function revealSidebarTarget(
  viewport: Locator,
  target: Locator,
  timeout = controlUiE2eWaitTimeoutMs,
): Promise<void> {
  const deadline = Date.now() + timeout;
  const commit = () =>
    viewport.page().evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
  if (!(await target.count())) {
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
    });
    await commit();
    // A long window can publish a step's rows several frames after the scroll
    // under load; check each step before scrolling past it.
    const mountedAfterStep = async () => {
      const stepDeadline = Math.min(deadline, Date.now() + 500);
      do {
        // Scroll publication and measured-height reconciliation occupy separate frames.
        await commit();
        if (await target.count()) {
          return true;
        }
      } while (Date.now() < stepDeadline);
      return false;
    };
    while (!(await mountedAfterStep())) {
      if (Date.now() >= deadline) {
        throw new Error("Sidebar target was not mounted after scrolling");
      }
      await viewport.evaluate((element) => {
        const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
        element.scrollTop = Math.min(bottom, element.scrollTop + element.clientHeight * 0.75);
      });
    }
  }
  await target.scrollIntoViewIfNeeded({ timeout: Math.max(1, deadline - Date.now()) });
  await target.waitFor({ state: "visible", timeout: Math.max(1, deadline - Date.now()) });
}
