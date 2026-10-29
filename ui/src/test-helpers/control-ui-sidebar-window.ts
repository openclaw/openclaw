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
    while (!(await target.count())) {
      if (Date.now() >= deadline) {
        throw new Error("Sidebar target was not mounted after scrolling");
      }
      await viewport.evaluate((element) => {
        const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
        element.scrollTop =
          element.scrollTop >= bottom
            ? 0
            : Math.min(bottom, element.scrollTop + element.clientHeight * 0.75);
      });
      // Scroll publication and measured-height reconciliation occupy separate frames.
      await commit();
    }
  }
  await target.scrollIntoViewIfNeeded({ timeout: Math.max(1, deadline - Date.now()) });
  await target.waitFor({ state: "visible", timeout: Math.max(1, deadline - Date.now()) });
}
