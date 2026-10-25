import type { Page } from "playwright";

export async function assertSessionSectionCountAlignment(
  page: Page,
  sectionIds: readonly string[],
) {
  const sections = sectionIds.map((sectionId) =>
    page.locator(`[data-session-section="${sectionId}"]`),
  );
  for (const section of sections) {
    const toggle = section.locator(".sidebar-session-group-toggle");
    if ((await toggle.getAttribute("aria-expanded")) !== "false") {
      await toggle.click();
    }
  }
  const rightEdges = await Promise.all(
    sections.map(async (section) => {
      const bounds = await section.locator(".sidebar-session-group-count").boundingBox();
      if (!bounds) {
        throw new Error("Expected visible collapsed section count");
      }
      return bounds.x + bounds.width;
    }),
  );
  const expected = rightEdges[0];
  if (expected === undefined || rightEdges.some((edge) => Math.abs(edge - expected) > 0.1)) {
    throw new Error(`Expected aligned section count edges, received ${rightEdges.join(", ")}`);
  }
  for (const section of sections) {
    await section.locator(".sidebar-session-group-count").click();
    const toggle = section.locator(".sidebar-session-group-toggle");
    await page.waitForFunction(
      (id) =>
        document
          .querySelector(`[data-session-section="${id}"] .sidebar-session-group-toggle`)
          ?.getAttribute("aria-expanded") === "true",
      await section.getAttribute("data-session-section"),
    );
    await toggle.click();
  }
  for (const [index, sectionId] of sectionIds.entries()) {
    const section = sections[index];
    if (!section || !sectionId.startsWith("catalog:")) {
      continue;
    }
    const header = section.locator(":scope > .sidebar-recent-sessions__head");
    await header.hover();
    const count = header.locator(".sidebar-session-group-count");
    const countBox = await count.boundingBox();
    const countOpacity = await count.evaluate((element) => getComputedStyle(element).opacity);
    if (!countBox || Number.parseFloat(countOpacity) <= 0) {
      throw new Error("Expected visible catalog count on hover");
    }
    const actionBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];
    for (const action of await header.locator(".sidebar-session-group-actions").all()) {
      const actionBox = await action.boundingBox();
      if (!actionBox || actionBox.x + actionBox.width > countBox.x) {
        throw new Error("Expected catalog hover actions to stay left of the count");
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
    await page.waitForFunction(
      (id) =>
        document
          .querySelector(`[data-session-section="${id}"] [data-session-catalog-view-menu]`)
          ?.getAttribute("aria-expanded") === "true",
      sectionId,
    );
    await page.mouse.move(0, 0);
    const persistentOpacity = await groupingAction.evaluate(
      (element) => getComputedStyle(element).opacity,
    );
    if (Number.parseFloat(persistentOpacity) <= 0) {
      throw new Error("Expected an open catalog action to remain visible without hover");
    }
    await page.keyboard.press("Escape");
    await section.locator(".sidebar-session-group-toggle").click();
    for (const nestedCount of await section
      .locator(".sidebar-session-catalog-host__count, .sidebar-session-catalog-project__count")
      .all()) {
      const nestedBounds = await nestedCount.boundingBox();
      const textAlign = await nestedCount.evaluate(
        (element) => getComputedStyle(element).textAlign,
      );
      if (
        !nestedBounds ||
        textAlign !== "right" ||
        Math.abs(nestedBounds.x + nestedBounds.width - expected) > 0.1
      ) {
        throw new Error("Expected expanded catalog counts to share the section count edge");
      }
    }
    await section.locator(".sidebar-session-group-toggle").click();
  }
}
