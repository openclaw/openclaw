import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { logbookStatus, logbookTimeline } from "../pages/plugin/logbook.test-support.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Logbook Ask field" });

suite.define(() => {
  it.each([
    { name: "desktop", width: 1280, height: 900 },
    { name: "tablet", width: 820, height: 1000 },
    { name: "phone", width: 400, height: 900 },
  ])("keeps the Ask row coherent and submits the typed question on $name", async (viewport) => {
    await suite.withPage({ ...createControlUiE2eContextOptions(), viewport }, async ({ page }) => {
      const day = "2026-11-10";
      const gateway = await installMockGateway(page, {
        communityInvite: false,
        controlUiTabs: [{ group: "control", id: "logbook", label: "Logbook", pluginId: "logbook" }],
        methodResponses: {
          "logbook.status": logbookStatus(day, {
            captureEnabled: false,
            visionModelSource: "config",
          }),
          "logbook.timeline": logbookTimeline(day, [
            {
              title: "Reviewing the example project",
              summary: "Synthetic activity for layout validation.",
            },
          ]),
        },
      });
      await page.goto(`${suite.server.baseUrl}plugin?plugin=logbook&id=logbook`);
      await gateway.waitForRequest("logbook.timeline");
      const form = page.locator(".logbook-ask__form");
      const input = form.getByRole("textbox");
      const submit = form.getByRole("button");
      await input.waitFor();
      const idleBorder = await input.evaluate((element) => getComputedStyle(element).borderColor);
      const question = "What did I work on today?";
      await input.pressSequentially(question);
      expect(await input.inputValue()).toBe(question);
      const frame = await takeControlUiScreenshotFrame(page, form, [input, submit], {
        animations: "disabled",
        scrollTo: form,
        elements: [form.locator("..")],
      });
      await writeFile(path.join(suite.artifactDir, `logbook-${viewport.name}.png`), frame.png);
      await writeFile(
        path.join(suite.artifactDir, `logbook-${viewport.name}-ask.png`),
        frame.elements[0]!.png,
      );
      const geometry = await form.evaluate((element) => {
        const field = element.querySelector("input")!;
        const button = element.querySelector("button")!;
        const style = getComputedStyle(field);
        return {
          radius: style.borderRadius,
          padding: style.paddingInlineStart,
          border: style.borderColor,
          focused: field.matches(":focus-visible"),
          rootClasses: document.documentElement.className,
          viewport: { width: innerWidth, height: innerHeight },
          input: field.getBoundingClientRect().toJSON(),
          button: button.getBoundingClientRect().toJSON(),
          form: element.getBoundingClientRect().toJSON(),
          height: style.getPropertyValue("--settings-control-height").trim(),
        };
      });
      await writeFile(
        path.join(suite.artifactDir, `logbook-${viewport.name}.json`),
        JSON.stringify(geometry, null, 2),
      );
      expect.soft(geometry.radius).toBe("12.5px");
      expect.soft(geometry.padding).toBe("10px");
      expect(geometry.focused).toBe(true);
      expect.soft(geometry.border).not.toBe(idleBorder);
      expect.soft(geometry.input.height).toBe(Number.parseFloat(geometry.height));
      expect.soft(geometry.input.height).toBe(geometry.button.height);
      expect(geometry.button.x - geometry.input.right).toBe(6);
      expect(geometry.button.right).toBeLessThanOrEqual(geometry.form.right);
      expect(geometry.input.width).toBeGreaterThan(100);
      const after = await gateway.deferNext("logbook.ask");
      await input.press("Enter");
      const request = await gateway.waitForRequest("logbook.ask", { after });
      expect(request.params).toEqual({ day, question });
      await expect.poll(() => submit.isDisabled()).toBe(true);
      await input.press("Enter");
      expect(await gateway.getRequests("logbook.ask")).toHaveLength(1);
      await gateway.resolveDeferred("logbook.ask", { answer: "You reviewed the example project." });
      await page.getByText("You reviewed the example project.", { exact: true }).waitFor();
      await expect.poll(() => submit.isDisabled()).toBe(false);
      await input.fill("   ");
      await submit.click();
      expect(await gateway.getRequests("logbook.ask")).toHaveLength(1);
      await input.fill("What was the main activity?");
      await gateway.setMethodResponse("logbook.ask", { answer: "Project review." });
      await submit.click();
      await gateway.waitForRequest("logbook.ask", { after: 1 });
      await page.getByText("Project review.", { exact: true }).waitFor();
    });
  });
});
