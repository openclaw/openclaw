import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "command palette catalog Unicode search" });
const sessionKey = "agent:main:dashboard:palette-unicode";
// macOS and many skill sources store display names in NFD.
const skillName = "Cafe\u0301-notes";
const nfcQuery = "Caf\u00e9";

suite.define(() => {
  it("finds an NFD skill catalog label when the palette query is NFC", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        sessionKey,
        awaitInitialRoster: true,
        featureMethods: [
          "agent.wait",
          "chat.metadata",
          "chat.startup",
          "sessions.create",
          "sessions.dispatch",
          "sessions.search",
          "skills.status",
          "plugins.list",
          "cron.list",
        ],
        methodResponses: {
          "skills.status": {
            workspaceDir: "/tmp/control-ui-mock/workspace",
            managedSkillsDir: "/tmp/control-ui-mock/skills",
            skills: [
              {
                name: skillName,
                skillKey: "cafe-notes",
                disabled: false,
                blockedByAllowlist: false,
                missing: { anyBins: [], bins: [], env: [], config: [], os: [] },
              },
            ],
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const composer = page.locator(".agent-chat__composer-combobox textarea:visible");
      await composer.waitFor({ state: "visible" });
      await page.keyboard.press("Control+p");
      const input = page.locator(".cmd-palette__input");
      await input.waitFor({ state: "visible" });
      // NFC precomposed query against the NFD catalog skill name above.
      await input.fill(nfcQuery);
      const skillRow = page.locator(".cmd-palette__item-title", { hasText: "notes" }).first();
      await skillRow.waitFor({ state: "visible" });
      await page.screenshot({ path: `${suite.artifactDir}/palette-nfc-query-nfd-skill.png` });
      const title = await skillRow.textContent();
      expect(title?.normalize("NFC")).toBe(skillName.normalize("NFC"));
      expect(skillName).not.toBe(nfcQuery);
    });
  });
});
