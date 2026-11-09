import type { Page } from "playwright";

export async function assertSessionSectionCountAlignment(
  page: Page,
  sectionIds: readonly string[],
) {
  const waitForExpanded = (sectionId: string | null, target: string) =>
    page.waitForFunction(
      ({ id, selector }) =>
        document
          .querySelector(`[data-session-section="${id}"] ${selector}`)
          ?.getAttribute("aria-expanded") === "true",
      { id: sectionId, selector: target },
    );
  const sections = sectionIds.map((sectionId) =>
    page.locator(`[data-session-section="${sectionId}"]`),
  );
  for (const section of sections) {
    const toggle = section.locator(".sidebar-session-group-toggle");
    if ((await toggle.getAttribute("aria-expanded")) !== "false") {
      await toggle.click();
    }
  }
  for (const section of sections) {
    if ((await section.locator(".sidebar-session-group-count").count()) !== 0) {
      throw new Error("Expected collapsed sections to show no count");
    }
  }
  for (const [index, sectionId] of sectionIds.entries()) {
    const section = sections[index];
    if (!section || !sectionId.startsWith("catalog:")) {
      continue;
    }
    const header = section.locator(":scope > .sidebar-recent-sessions__head");
    await header.hover();
    const actionBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];
    for (const action of await header.locator(".sidebar-session-group-actions").all()) {
      const actionBox = await action.boundingBox();
      if (!actionBox) {
        throw new Error("Expected visible catalog hover actions");
      }
      actionBoxes.push(actionBox);
    }
    actionBoxes.sort((left, right) => left.x - right.x);
    if (
      actionBoxes.some((box, actionIndex) => {
        const previous = actionBoxes[actionIndex - 1];
        return previous ? box.x < previous.x + previous.width : false;
      })
    ) {
      throw new Error("Expected catalog hover actions not to overlap");
    }
    const contentBoxes = await Promise.all(
      (
        await header
          .locator(
            ".sidebar-recent-sessions__label-text, .session-run-spinner, .session-unread-dot",
          )
          .all()
      ).map((element) => element.boundingBox()),
    );
    const contentRight = Math.max(...contentBoxes.map((box) => (box ? box.x + box.width : 0)));
    if (contentRight > (actionBoxes[0]?.x ?? Number.POSITIVE_INFINITY)) {
      throw new Error("Expected catalog content to stay left of hover actions");
    }
    const groupingAction = header.locator("[data-session-catalog-view-menu]");
    await groupingAction.click();
    await waitForExpanded(sectionId, "[data-session-catalog-view-menu]");
    await page.mouse.move(0, 0);
    const persistentOpacity = await groupingAction.evaluate(
      (element) => getComputedStyle(element).opacity,
    );
    if (Number.parseFloat(persistentOpacity) <= 0) {
      throw new Error("Expected an open catalog action to remain visible without hover");
    }
    await page.keyboard.press("Escape");
    await section.locator(".sidebar-session-group-toggle").click();
    let countEdge: number | undefined;
    for (const nestedCount of await section
      .locator(".sidebar-session-catalog-host__count, .sidebar-session-catalog-project__count")
      .all()) {
      const nestedBounds = await nestedCount.boundingBox();
      if (!nestedBounds) {
        continue;
      }
      const nestedEdge = nestedBounds.x + nestedBounds.width;
      countEdge ??= nestedEdge;
      const textAlign = await nestedCount.evaluate(
        (element) => getComputedStyle(element).textAlign,
      );
      if (textAlign !== "right" || Math.abs(nestedEdge - countEdge) > 0.1) {
        throw new Error("Expected expanded catalog counts to share one edge");
      }
    }
    await section.locator(".sidebar-session-group-toggle").click();
  }
}
