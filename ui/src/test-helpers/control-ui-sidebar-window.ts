import type { Locator } from "playwright";
import { expect } from "vitest";
import { controlUiE2eWaitTimeoutMs } from "./control-ui-e2e-readiness.ts";

/** Scroll the real viewport until a windowed row exists, then reveal its control. */
export async function revealSidebarTarget(viewport: Locator, target: Locator): Promise<void> {
  if (!(await target.count())) {
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect
      .poll(
        async () => {
          if (await target.count()) {
            return true;
          }
          await viewport.evaluate((element) => {
            element.scrollTop += element.clientHeight * 0.75;
          });
          return false;
        },
        { timeout: controlUiE2eWaitTimeoutMs },
      )
      .toBe(true);
  }
  await target.scrollIntoViewIfNeeded();
  await target.waitFor({ state: "visible" });
}
