import type { Page } from "playwright";

export type ColdOpenOutcome =
  | { outcome: "loading" | "content" }
  | {
      outcome: "generic-empty";
      heading: string;
      description: string;
      emptyStateOffersAction: boolean;
    };

export async function readColdOpenOutcome(page: Page): Promise<ColdOpenOutcome> {
  const activePanel = page.locator(".side-panel__panel:not([hidden])");
  await activePanel.waitFor();
  await activePanel.locator(":scope > *").first().waitFor();
  if ((await activePanel.locator("openclaw-panel-loading-skeleton").count()) > 0) {
    return { outcome: "loading" };
  }
  const emptyState = activePanel.locator("openclaw-panel-empty-state").first();
  if (!(await emptyState.count())) {
    return { outcome: "content" };
  }
  return {
    outcome: "generic-empty",
    heading: (await emptyState.locator(".empty-state__title").textContent())?.trim() ?? "",
    description:
      (await emptyState.locator(".empty-state__description").textContent())?.trim() ?? "",
    emptyStateOffersAction:
      (await activePanel
        .locator('a[href]:not([aria-disabled="true"]), button:enabled:not([aria-disabled="true"])')
        .filter({ visible: true })
        .count()) > 0,
  };
}
