import { expect, it } from "vitest";
import { createSkill } from "../pages/skills/view.test-support.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI external ClawHub skill install E2E",
  startServerBeforeBrowser: true,
});

const emptyStatus = {
  workspaceDir: "/tmp/openclaw-e2e/workspace",
  managedSkillsDir: "/tmp/openclaw-e2e/skills",
  skills: [],
};
const installRef = "skills-sh:openai/skills/pdf";

const installedSkill = createSkill({
  name: "pdf",
  source: "clawhub",
  skillKey: "pdf",
  primaryEnv: undefined,
  homepage: undefined,
  clawhub: {
    status: "linked",
    valid: true,
    registry: "https://clawhub.ai",
    slug: "pdf",
    requestedReference: installRef,
    installedVersion: "0.0.0",
    installedAt: 1,
    originPath: "/tmp/.clawhub/origin.json",
    lockPath: "/tmp/.clawhub/lock.json",
  },
});

suite.define(() => {
  it("searches, installs the exact skills.sh reference, and renders installed state", () =>
    suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "skills.status",
          "skills.search",
          "skills.install",
        ],
        methodResponses: {
          "skills.status": emptyStatus,
          "skills.search": {
            results: [
              {
                score: 1,
                slug: "pdf",
                registry: "https://clawhub.ai",
                installRef,
                installOnly: true,
                trustState: "not-scanned-by-clawhub",
                displayName: "Pdf",
              },
            ],
          },
          "skills.install": { message: "Installed pdf" },
        },
      });

      expect((await page.goto(`${suite.server.baseUrl}skills`))?.status()).toBe(200);
      await gateway.waitForRequest("skills.status");

      await page.getByRole("searchbox", { name: "Search skills", exact: true }).fill("pdf");
      await gateway.waitForRequest("skills.search", { match: { query: "pdf" } });
      const row = page.locator(".plugin-catalog-card", { hasText: installRef });
      await row.getByText("Not scanned by ClawHub", { exact: true }).waitFor();
      const install = row.getByRole("button", { name: "Install Pdf", exact: true });

      await gateway.deferNext("skills.install");
      await install.click();
      expect((await gateway.waitForRequest("skills.install")).params).toMatchObject({
        source: "clawhub",
        slug: installRef,
      });

      await gateway.setMethodResponse("skills.status", {
        ...emptyStatus,
        skills: [installedSkill],
      });
      await gateway.resolveDeferred("skills.install", { message: "Installed pdf" });

      await row.getByRole("img", { name: "Ready", exact: true }).waitFor();
      expect(await row.count()).toBe(1);
      expect(await row.getByRole("button", { name: /^Install / }).count()).toBe(0);
    }));
});
