import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import { timedText } from "./chat-flow-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Widget header annotation",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:widget-header-proof";
const title = "Session activity";

suite.define(() => {
  const sandbox = useCanvasSandboxFixture();
  it("stages widget feedback in the existing composer without sending or losing local state", async () => {
    const html = buildWidgetDocument(
      title,
      `<section style="padding:20px"><div id="status-wrapper" style="width:200px;height:40px"><button id="status" style="display:block;width:100%;height:100%;border:0;padding:0">Running</button></div><label>Local note <input aria-label="Local note"></label><script>if(openclaw.preview)openclaw.preview.setControls([{id:"phase",label:"Phase",value:"running",options:[{value:"running",label:"Running"},{value:"completed",label:"Completed"}]}],({id,value})=>{document.getElementById("status").textContent=value==="running"?"Running":"Completed";});</script></section>`,
    );
    const metadata = sandbox(html);
    await suite.withPage(
      {
        viewport: { width: 1280, height: 800 },
        serviceWorkers: "block",
        permissions: ["local-network-access"],
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey,
          featureMethods: [...defaultControlUiFeatureMethods, "canvas.document.view"],
          historyMessages: [
            timedText("assistant", `[embed ref="header-proof" title="${title}" height="200" /]`),
          ],
          methodResponses: { "canvas.document.view": metadata },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
        const preview = page.locator(".chat-tool-card__preview[data-kind=canvas]");
        const inner = preview.locator("iframe").contentFrame().frameLocator("iframe");
        await inner.getByRole("textbox", { name: "Local note" }).fill("Keep this local note");
        const composer = page.locator(".agent-chat__composer-combobox textarea").last();
        await composer.fill("Please simplify this state.");
        if (process.env.WIDGET_HEADER_BASELINE === "1") {
          await writeFile(
            path.join(suite.artifactDir, "before-clean.png"),
            await page.screenshot(),
          );
        }
        await preview.getByRole("heading", { name: title }).waitFor();
        const clean = await takeControlUiScreenshotFrame(page, preview, [preview], {
          animations: "disabled",
        });
        await writeFile(path.join(suite.artifactDir, "after-clean.png"), clean.png);
        await preview
          .getByRole("radiogroup", { name: "Phase" })
          .getByRole("radio", { name: "Completed", exact: true })
          .check();
        expect(await inner.locator("#status").textContent()).toBe("Completed");
        await preview.getByRole("button", { name: "Annotate widget", exact: true }).click();
        const overlay = preview.locator(".bp-overlay--annotate");
        await overlay.waitFor();
        const bounds = await overlay.boundingBox();
        if (!bounds) {
          throw new Error("Annotation surface missing");
        }
        await page.mouse.move(bounds.x + 50, bounds.y + 24);
        await page.mouse.down();
        await page.mouse.move(bounds.x + 180, bounds.y + 36, { steps: 8 });
        await page.mouse.up();
        const add = preview.getByRole("button", { name: "Add to message", exact: true });
        await page.keyboard.press("Control+z");
        expect(await add.isDisabled()).toBe(true);
        await page.mouse.click(bounds.x + 80, bounds.y + 28);
        await preview.getByRole("button", { name: "Clear", exact: true }).click();
        await page.mouse.move(bounds.x + 50, bounds.y + 24);
        await page.mouse.down();
        await page.mouse.move(bounds.x + 180, bounds.y + 36, { steps: 8 });
        await page.mouse.up();
        await page.keyboard.press("Control+z");
        expect(await add.isDisabled()).toBe(true);
        await page.mouse.click(bounds.x + 80, bounds.y + 28);
        await page.keyboard.press("Escape");
        expect(await overlay.count()).toBe(0);
        await preview.getByRole("button", { name: "Annotate widget", exact: true }).click();
        await overlay.waitFor();
        const selected = await overlay.boundingBox();
        if (!selected) {
          throw new Error("Selection surface missing");
        }
        await page.mouse.move(selected.x + 45, selected.y + 27);
        await preview
          .locator(".bp-tooltip__selector")
          .getByText("button#status", { exact: true })
          .waitFor();
        await page.mouse.click(selected.x + 45, selected.y + 27);
        await add.click();
        const card = page.locator(".chat-attachment-thumb--browser-annotation");
        await card.waitFor();
        await writeFile(
          path.join(suite.artifactDir, "composer-comment.png"),
          await page.screenshot(),
        );
        expect(await composer.inputValue()).toBe("Please simplify this state.");
        expect(await inner.getByRole("textbox", { name: "Local note" }).inputValue()).toBe(
          "Keep this local note",
        );
        expect(await gateway.getRequests("chat.send")).toEqual([]);
        for (let index = 0; index < 3; index++) {
          await preview.getByRole("button", { name: "Annotate widget", exact: true }).click();
          await overlay.click({ position: { x: 45, y: 27 } });
          await add.click();
        }
        expect(await card.count()).toBe(4);
        await preview.getByRole("button", { name: "Annotate widget", exact: true }).click();
        await overlay.click({ position: { x: 45, y: 27 } });
        await add.click();
        await preview.getByRole("alert").waitFor();
        expect(await overlay.isVisible()).toBe(true);
        await card
          .first()
          .getByRole("button", { name: /Remove.*annotation/i })
          .click();
        await add.click();
        expect(await overlay.count()).toBe(0);
        expect(await card.count()).toBe(4);
        for (let index = 0; index < 4; index++) {
          await card
            .first()
            .getByRole("button", { name: /Remove.*annotation/i })
            .click();
        }
        expect(await card.count()).toBe(0);
        expect(await composer.inputValue()).toBe("Please simplify this state.");
        expect(
          await preview.getByRole("radio", { name: "Completed", exact: true }).isChecked(),
        ).toBe(true);
        await page.setViewportSize({ width: 400, height: 800 });
        await page.emulateMedia({ colorScheme: "dark" });
        expect(
          await preview.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
      },
    );
  });
});
