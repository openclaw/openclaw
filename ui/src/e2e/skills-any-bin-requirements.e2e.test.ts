import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createSkill } from "../pages/skills/view.test-support.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI alternative skill binary requirements",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

function codingAgentSkill(missingAnyBins: string[]) {
  return createSkill({
    name: "Coding Agent",
    source: "openclaw-bundled",
    bundled: true,
    skillKey: "coding-agent",
    primaryEnv: undefined,
    homepage: undefined,
    eligible: missingAnyBins.length === 0,
    modelVisible: missingAnyBins.length === 0,
    commandVisible: missingAnyBins.length === 0,
    requirements: { ...emptyRequirements, anyBins: ["claude", "codex", "opencode"] },
    missing: { ...emptyRequirements, anyBins: missingAnyBins },
    install: [
      {
        id: "node-codex",
        kind: "node",
        label: "Install Codex CLI (npm)",
        bins: ["codex"],
      },
    ],
  });
}

const emptyRequirements = { bins: [], env: [], config: [], os: [] };
async function openSkill(page: Page, missing: string[], install = false) {
  const gateway = await installMockGateway(page, {
    ...(install ? { featureMethods: ["chat.metadata", "chat.startup", "skills.install"] } : {}),
    methodResponses: {
      "skills.status": {
        workspaceDir: "/tmp/openclaw-e2e/workspace",
        managedSkillsDir: "/tmp/openclaw-e2e/skills",
        skills: [codingAgentSkill(missing)],
      },
      ...(install ? { "skills.install": { message: "Installed Codex CLI" } } : {}),
    },
  });
  expect((await page.goto(`${suite.server.baseUrl}settings/skills`))?.status()).toBe(200);
  const opener = page.getByRole("button", { name: "Open Coding Agent details" });
  await opener.waitFor();
  const originalOpener = await opener.elementHandle();
  const inventoryReads = (await gateway.getRequests("skills.status")).length;
  await opener.focus();
  await page.keyboard.press("Enter");
  // A skill opens as its own page at its own address.
  await page.waitForURL(/\/settings\/skills\/coding-agent(?:\?|$)/u);
  const dialog = page.locator(".skill-page", { hasText: "Coding Agent" });
  await expect.poll(() => dialog.count()).toBe(1);
  return { gateway, dialog, opener, originalOpener, inventoryReads };
}

suite.define(() => {
  it.each([true, false])("shows alternative binary installation only when missing: %s", (missing) =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { gateway, dialog, opener, originalOpener, inventoryReads } = await openSkill(
        page,
        missing ? ["claude", "codex", "opencode"] : [],
        missing,
      );
      const installer = dialog.getByRole("button", { name: "Install Codex CLI (npm)" });
      await dialog
        .locator(".skill-requirement")
        .getByText("claude / codex / opencode", { exact: true })
        .waitFor();
      if (missing) {
        await installer.click();
        expect((await gateway.waitForRequest("skills.install")).params).toMatchObject({
          name: "Coding Agent",
          installId: "node-codex",
          dangerouslyForceUnsafeInstall: false,
        });
      } else {
        expect(await dialog.locator(".skill-requirement .settings-status--warn").count()).toBe(0);
        expect(await installer.count()).toBe(0);
        expect(await gateway.getRequests("skills.install")).toHaveLength(0);
        // Keyboard entry identifies the skill, with the Back link immediately before the heading.
        const heading = dialog.getByRole("heading", { name: "Coding Agent", exact: true });
        await expect
          .poll(() => heading.evaluate((node) => node.matches(":focus-visible")))
          .toBe(true);
        const back = dialog.getByRole("link", { name: "Skills", exact: true });
        await page.keyboard.press("Shift+Tab");
        await expect
          .poll(() => back.evaluate((link) => link === document.activeElement))
          .toBe(true);
        await page.keyboard.press("Enter");
        await opener.waitFor();
        await expect
          .poll(() => originalOpener.evaluate((button) => button === document.activeElement))
          .toBe(true);
        await page.keyboard.press("Enter");
        await expect.poll(() => heading.evaluate((node) => node.matches(":focus"))).toBe(true);
        await page.goBack();
        await opener.waitFor();
        await expect
          .poll(() => originalOpener.evaluate((button) => button === document.activeElement))
          .toBe(true);
        expect((await gateway.getRequests("skills.status")).length).toBe(inventoryReads);

        await opener.press("Enter");
        await dialog.waitFor();
        // Reload stays on the page; Back returns to the list it came from.
        await page.reload();
        await expect.poll(() => heading.evaluate((node) => node.matches(":focus"))).toBe(true);
        await page.goBack();
        await page.waitForURL(/\/settings\/skills(?:\?|$)/u);
        await expect.poll(() => page.locator(".skill-page").count()).toBe(0);
        await expect
          .poll(() => page.getByRole("button", { name: "Open Coding Agent details" }).isVisible())
          .toBe(true);
      }
    }),
  );
});
