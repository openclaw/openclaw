import { expect, it } from "vitest";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Composer skill highlights",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});

suite.define(() => {
  it("picks a skill and sends its canonical name from mobile New Session", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "commands.list": {
            commands: [
              {
                name: "agent_transcript",
                description: "Agent transcript",
                scope: "both",
                source: "skill",
                skillDisplayName: "Agent Transcript",
                skillReferenceable: true,
                skillModelVisible: true,
              },
            ],
          },
        },
      });
      await page.goto(suite.server.baseUrl + "new");
      const surface = page.locator(".new-session-page__composer");
      const native = surface.locator("textarea");
      await native.fill("Literal $HOME and $unknown");
      await page.waitForLoadState("networkidle");
      expect(await native.isVisible()).toBe(true);

      await native.fill("Check $agent");
      const picker = page.getByRole("listbox", { name: "Skill references" });
      await picker.getByRole("option", { name: /Agent Transcript/u }).click();
      const rich = surface.locator("[data-composer-editor]");
      await rich.locator(".chat-composer-skill").filter({ hasText: "Agent Transcript" }).waitFor();
      await page.locator(".new-session-page__start-submit").click();
      const request = await gateway.waitForRequest("sessions.create");
      expect(request.params).toMatchObject({ message: "Check $agent_transcript" });
    });
  });
});
