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
  it("uses the native Add to chat input for live widget elements without activating or sending", async () => {
    const html = buildWidgetDocument(
      title,
      `<section style="padding:20px"><div id="status-wrapper" style="width:200px;height:40px"><button id="status" style="display:block;width:100%;height:100%;border:0;padding:0" onclick="this.textContent='Clicked'">Running</button></div><label>Local note <input aria-label="Local note"></label><script>if(openclaw.preview)openclaw.preview.setControls([{id:"phase",label:"Phase",value:"running",options:[{value:"running",label:"Running"},{value:"completed",label:"Completed"}]}],({id,value})=>{document.getElementById("status").textContent=value==="running"?"Running":"Completed";});</script></section>`,
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
            timedText(
              "assistant",
              `A paragraph to comment on.\n\n[embed ref="header-proof" title="${title}" height="200" /]`,
            ),
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
        const dialog = page.getByRole("dialog", { name: "Comment", exact: true });
        const input = dialog.getByRole("textbox");
        const paragraph = page.getByText("A paragraph to comment on.", { exact: true });
        await paragraph.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        });
        await paragraph.dispatchEvent("pointerup", { button: 0, pointerType: "mouse" });
        await page.getByRole("button", { name: "Add to chat", exact: true }).click();
        await dialog.waitFor();
        const nativeClass = await dialog.getAttribute("class");
        const nativePlaceholder = await input.getAttribute("placeholder");
        await input.press("Escape");
        await dialog.waitFor({ state: "detached" });

        const pen = preview.getByRole("button", { name: "Annotate widget", exact: true });
        const target = inner.locator("#status");
        const outline = preview.locator(".widget-inspect-outline");
        for (const cancel of ["pen", "outside"] as const) {
          await pen.click();
          await target.hover();
          await outline.waitFor();
          if (cancel === "pen") {
            // Clicking the nested icon must reach the pen toggle, not dismiss and re-arm it.
            await pen.locator("svg").click();
          } else {
            await composer.click();
          }
          await outline.waitFor({ state: "detached" });
          expect(await pen.getAttribute("aria-pressed")).toBe("false");
          expect(await dialog.count()).toBe(0);
        }
        await pen.click();
        await target.hover();
        await outline.waitFor();
        const targetBox = (await target.boundingBox())!;
        const outlineBox = (await outline.boundingBox())!;
        expect(Math.abs(outlineBox.x - targetBox.x)).toBeLessThan(2);
        expect(Math.abs(outlineBox.y - targetBox.y)).toBeLessThan(2);
        expect(Math.abs(outlineBox.width - targetBox.width)).toBeLessThan(2);
        expect(Math.abs(outlineBox.height - targetBox.height)).toBeLessThan(2);
        expect(await preview.locator(".bp-annotatebar").count()).toBe(0);
        await target.click();
        await dialog.waitFor();
        expect(await dialog.getAttribute("class")).toBe(nativeClass);
        expect(await input.getAttribute("placeholder")).toBe(nativePlaceholder);
        expect(await target.textContent()).toBe("Completed");
        await input.press("Escape");
        await dialog.waitFor({ state: "detached" });
        expect(await pen.evaluate((element) => document.activeElement === element)).toBe(true);

        await pen.click();
        await target.hover();
        await outline.waitFor();
        await target.click();
        await input.fill("Make this status clearer.");
        await input.press("Enter");
        await dialog.waitFor({ state: "detached" });
        const chip = page
          .locator(".chat-comment-preview--editable")
          .getByRole("button", { name: /1 comment/i });
        await chip.waitFor();
        await chip.click();
        const comment = page.getByText("Make this status clearer.", { exact: true });
        await comment.waitFor();
        expect(
          await page.getByText(/Session activity — button#status: Completed/).count(),
        ).toBeGreaterThan(0);
        expect(await composer.inputValue()).toBe("Please simplify this state.");
        expect(await inner.getByRole("textbox", { name: "Local note" }).inputValue()).toBe(
          "Keep this local note",
        );
        expect(await gateway.getRequests("chat.send")).toEqual([]);
        await writeFile(
          path.join(suite.artifactDir, "composer-comment.png"),
          await page.screenshot(),
        );
        await target.click();
        expect(await target.textContent()).toBe("Clicked");
        await page.setViewportSize({ width: 400, height: 800 });
        await page.emulateMedia({ colorScheme: "dark" });
        expect(
          await preview.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
      },
    );
  });
});
