import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { startControlUiE2eServer, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Composer skill highlights",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});
suite.define(() =>
  it.each(["chat", "new"])(
    "renders picked skill names and sends canonical references in %s",
    async (route) => {
      const dir = createControlUiE2eArtifactDir(`skill-${route}`);
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const commands = ["clawhub", "agent_transcript"].map((name) => ({
          name,
          description: name,
          scope: "both",
          source: "skill",
          acceptsArgs: true,
          skillDisplayName: name.replaceAll("_", "-"),
          skillReferenceable: true,
          skillModelVisible: true,
        }));
        const gateway = await installMockGateway(page, {
          deferredMethods: ["chat.send"],
          methodResponses: {
            "chat.startup": {
              messages: [],
              metadata: { commands, models: [] },
              sessionId: "skill-demo",
              thinkingLevel: null,
            },
            "commands.list": { commands },
          },
        });
        await page.goto(suite.server.baseUrl + route);
        if (route === "chat") {
          await gateway.waitForRequest("sessions.messages.subscribe");
        }
        const surface = page.locator(
          route === "chat" ? ".agent-chat__input" : ".new-session-page__composer",
        );
        const native = surface.locator("textarea");
        const active = () => surface.locator("textarea:visible, [data-composer-editor]");
        await active().fill("Find the right skill with $claw");
        const picker = page.getByRole("listbox", { name: "Skill references" });
        await picker.waitFor({ state: "visible" });
        await active().press("Enter");
        await expect.poll(() => native.inputValue()).toBe("Find the right skill with $clawhub ");
        await expect.poll(() => page.locator(".chat-composer-skill").count()).toBe(1);
        await active().press("ArrowLeft");
        await expect.poll(() => picker.count()).toBe(0);
        await active().press("End");
        await active().pressSequentially("and check $agent");
        await picker.waitFor({ state: "visible" });
        await active().press("Enter");
        await expect
          .poll(() => native.inputValue())
          .toBe("Find the right skill with $clawhub and check $agent_transcript ");
        await active().pressSequentially("before we start.");
        await active().press("Escape");
        const frame = await takeControlUiScreenshotFrame(page, surface, [active()], {
          elements: [surface],
          animations: "disabled",
        });
        await writeFile(path.join(dir, "desktop.png"), frame.png);
        await writeFile(path.join(dir, "composer.png"), frame.elements[0]!.png);
        await expect
          .poll(() => page.locator(".chat-composer-skill").allTextContents())
          .toEqual(["clawhub", "agent-transcript"]);
        if (route === "new") {
          await page.setViewportSize({ width: 390, height: 844 });
          const mobile = await takeControlUiScreenshotFrame(page, surface, [active()], {
            elements: [surface],
            animations: "disabled",
          });
          await writeFile(path.join(dir, "mobile.png"), mobile.png);
          await writeFile(path.join(dir, "mobile-composer.png"), mobile.elements[0]!.png);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(390);
          await page.locator(".new-session-page__start-submit").click();
        } else {
          await page.getByRole("button", { name: "Send message", exact: true }).click();
        }
        const request = await gateway.waitForRequest(
          route === "new" ? "sessions.create" : "chat.send",
        );
        expect(request.params).toMatchObject({
          message:
            "Find the right skill with $clawhub and check $agent_transcript before we start.",
        });
        console.log("PROOF", dir);
      });
    },
  ),
);
