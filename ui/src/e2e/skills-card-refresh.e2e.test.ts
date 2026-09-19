import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createSkill } from "../pages/skills/view.test-support.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Skill Card refresh" });
const skillKey = "freshness-demo";
const path = "/tmp/synthetic-workspace/skills/freshness-demo/skill-card.md";
const content = (marker: string) => `# Synthetic card\n\nRevision marker: ${marker}\n`;
const report = {
  workspaceDir: "/tmp/synthetic-workspace",
  managedSkillsDir: "/tmp/synthetic-skills",
  skills: [
    createSkill({
      name: skillKey,
      skillKey,
      skillCard: { present: true, path, sizeBytes: content("ALPHA").length },
    }),
  ],
};
const card = (marker: string) => ({
  schema: "openclaw.skills.skill-card.v1",
  skillKey,
  path,
  sizeBytes: content(marker).length,
  content: content(marker),
});

async function openCard(page: Page) {
  await page.getByRole("button", { name: `Open ${skillKey} details`, exact: true }).click();
  await page.getByRole("tab", { name: "Skill Card", exact: true }).click();
}

async function closeCard(page: Page) {
  await page
    .locator("openclaw-modal-dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.locator("openclaw-modal-dialog").waitFor({ state: "detached" });
}

function refreshButton(page: Page) {
  return page
    .locator(".plugins-toolbar--fields")
    .getByRole("button", { name: "Refresh", exact: true });
}

async function openInventory(page: Page) {
  const gateway = await installMockGateway(page, {
    methodResponses: { "skills.status": report, "skills.skillCard": card("ALPHA") },
  });
  await page.goto(`${suite.server.baseUrl}settings/skills?agent=main`);
  await page.getByRole("button", { name: `Open ${skillKey} details`, exact: true }).waitFor();
  return gateway;
}

suite.define(() => {
  it.each([1440, 390])(
    "rereads a same-size edit after Refresh at %dpx, preserving unchanged reuse",
    async (width) => {
      await suite.withPage({ viewport: { width, height: 900 } }, async ({ page }) => {
        const gateway = await openInventory(page);
        await openCard(page);
        await page.getByText("Revision marker: ALPHA", { exact: true }).waitFor();
        await closeCard(page);
        await openCard(page);
        await page.getByText("Revision marker: ALPHA", { exact: true }).waitFor();
        expect(await gateway.getRequests("skills.skillCard")).toHaveLength(1);
        await closeCard(page);
        await gateway.setMethodResponse("skills.skillCard", card("BRAVO"));
        await gateway.deferNext("skills.status");
        await refreshButton(page).click();
        await gateway.waitForRequest("skills.status", { after: 1 });
        await gateway.resolveDeferred("skills.status", report);
        await expect.poll(() => refreshButton(page).isEnabled()).toBe(true);
        await openCard(page);
        await page.getByText("Revision marker: BRAVO", { exact: true }).waitFor();
        expect(await gateway.getRequests("skills.skillCard")).toHaveLength(2);
        expect(
          await page
            .getByRole("tab", { name: "Skill Card", exact: true })
            .evaluate((tab) => tab === document.activeElement),
        ).toBe(true);
        expect(await page.evaluate(() => window.scrollX)).toBe(0);
        await closeCard(page);
        await openCard(page);
        await page.getByText("Revision marker: BRAVO", { exact: true }).waitFor();
        expect(await gateway.getRequests("skills.skillCard")).toHaveLength(2);
      });
    },
  );

  it.each(["success", "error"] as const)(
    "ignores an old card %s while a post-refresh read is pending",
    async (outcome) => {
      await suite.withPage({}, async ({ page }) => {
        const gateway = await openInventory(page);
        await gateway.deferNext("skills.skillCard");
        await openCard(page);
        const oldRequest = await gateway.waitForRequest("skills.skillCard");
        await closeCard(page);
        await gateway.deferNext("skills.status");
        await refreshButton(page).click();
        await gateway.waitForRequest("skills.status", { after: 1 });
        await openCard(page);
        expect(await gateway.getRequests("skills.skillCard")).toHaveLength(1);
        await gateway.deferNext("skills.skillCard");
        await gateway.resolveDeferred("skills.status", report);
        const newRequest = await gateway.waitForRequest("skills.skillCard", { after: 1 });
        await page.getByText("Loading Skill Card…", { exact: true }).waitFor();
        await gateway.deliverLatest({
          type: "res",
          id: oldRequest.id,
          ok: outcome === "success",
          ...(outcome === "success"
            ? { payload: card("ALPHA") }
            : { error: { code: "INVALID_REQUEST", message: "Obsolete read failed" } }),
        });
        await expect
          .poll(() => page.getByText("Loading Skill Card…", { exact: true }).isVisible())
          .toBe(true);
        expect(await page.getByText("Revision marker: ALPHA", { exact: true }).count()).toBe(0);
        expect(await page.getByText("Obsolete read failed", { exact: true }).count()).toBe(0);
        await gateway.deliverLatest({
          type: "res",
          id: newRequest.id,
          ok: true,
          payload: card("BRAVO"),
        });
        await page.getByText("Revision marker: BRAVO", { exact: true }).waitFor();
        expect(await page.getByText("Loading Skill Card…", { exact: true }).count()).toBe(0);
      });
    },
  );

  it.each(["overview", "closed"] as const)(
    "preserves the current %s selection when Refresh releases",
    async (selection) => {
      await suite.withPage({}, async ({ page }) => {
        const gateway = await openInventory(page);
        await gateway.deferNext("skills.status");
        await refreshButton(page).click();
        await gateway.waitForRequest("skills.status", { after: 1 });
        await openCard(page);
        if (selection === "overview") {
          await page.getByRole("tab", { name: "Overview", exact: true }).click();
        } else {
          await closeCard(page);
        }
        await gateway.resolveDeferred("skills.status", report);
        await expect.poll(() => refreshButton(page).isEnabled()).toBe(true);
        expect(await gateway.getRequests("skills.skillCard")).toHaveLength(0);
        if (selection === "overview") {
          expect(
            await page
              .getByRole("tab", { name: "Overview", exact: true })
              .getAttribute("aria-selected"),
          ).toBe("true");
        } else {
          expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
        }
      });
    },
  );

  it("reads the selected card after a failed status refresh while keeping the inventory error", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await openInventory(page);
      await openCard(page);
      await page.getByText("Revision marker: ALPHA", { exact: true }).waitFor();
      await closeCard(page);
      await gateway.setMethodResponse("skills.skillCard", card("BRAVO"));
      await gateway.deferNext("skills.status");
      await refreshButton(page).click();
      await gateway.waitForRequest("skills.status", { after: 1 });
      await openCard(page);
      await gateway.rejectDeferred("skills.status", { message: "Status unavailable" });
      await page.getByText("Revision marker: BRAVO", { exact: true }).waitFor();
      expect(await gateway.getRequests("skills.skillCard")).toHaveLength(2);
      await closeCard(page);
      await page.getByText("Status unavailable", { exact: true }).waitFor();
    });
  });
});
