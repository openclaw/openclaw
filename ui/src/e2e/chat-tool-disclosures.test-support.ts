import type { Locator, Page } from "playwright";

export async function clickToolDisclosure(
  control: Locator,
  options?: Parameters<Locator["click"]>[0],
): Promise<void> {
  await control.click(options);
  // Pointer completion precedes a frame-paced chat pane's render commitment.
  await control.evaluate(async (element) => {
    const pane = element.closest<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-chat-pane",
    );
    if (!pane) {
      throw new Error("Expected disclosure to belong to a chat pane");
    }
    await pane.updateComplete;
  });
}

export async function expandCompletedWorkGroups(page: Page): Promise<void> {
  const workSummaries = page.locator(".chat-work-group > .chat-activity-group__summary");
  await workSummaries.first().waitFor();
  for (let index = 0; index < (await workSummaries.count()); index += 1) {
    const summary = workSummaries.nth(index);
    if ((await summary.getAttribute("aria-expanded")) !== "true") {
      await clickToolDisclosure(summary);
    }
  }
}
