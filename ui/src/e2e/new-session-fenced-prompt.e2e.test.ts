import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "New-chat fenced prompt" });

suite.define(() => {
  it.each([1200, 390])(
    "keeps a fenced prompt editable and readable after submission at %i px",
    async (width) => {
      await suite.withPage(
        { viewport: { width, height: 900 }, colorScheme: "light" },
        async ({ page }) => {
          const gateway = await installMockGateway(page, { featureMethods: ["sessions.create"] });
          await page.goto(suite.server.baseUrl + "new");
          const fence = "```";
          const prompt =
            fence +
            "\n" +
            [
              "Requested design: a tiny lobster etched into the back of a silicon chip, with iridescent traces and a clean matte finish.",
              "",
              "Keep the entire instruction readable, including this final phrase: END OF DESIGN.",
              "",
              "https://example.com/design/" + "silicon-chip-".repeat(20),
              "",
              "    Please preserve indentation and the opening and closing backticks.",
            ].join("\n") +
            "\n" +
            fence;
          const editor = page.locator(".new-session-page__message");
          await editor.fill(prompt);
          expect(await editor.inputValue()).toBe(prompt);
          const capture = async (name: string, selector: string) => {
            const surface = page.locator(selector);
            const frame = await takeControlUiScreenshotFrame(page, surface, [surface], {
              animations: "disabled",
            });
            await writeFile(path.join(suite.artifactDir, width + "-" + name), frame.png);
          };
          await capture("composer.png", ".new-session-page__composer");
          await gateway.deferNext("sessions.create");
          await page.getByRole("button", { name: "Start session", exact: true }).click();
          const request = await gateway.waitForRequest("sessions.create");
          expect(request.params).toMatchObject({ message: prompt });
          const bubble = page.locator(".chat-group.user .chat-bubble");
          const pre = bubble.locator("pre");
          await pre.waitFor();
          await capture("message.png", ".chat-group.user .chat-bubble");
          const geometry = await pre.evaluate((element) => ({
            width: element.clientWidth,
            scrollWidth: element.scrollWidth,
          }));
          expect(geometry.scrollWidth - geometry.width).toBeLessThanOrEqual(1);
          expect(await pre.locator("code").textContent()).toBe(prompt.slice(4, -3));
        },
      );
    },
  );
});
