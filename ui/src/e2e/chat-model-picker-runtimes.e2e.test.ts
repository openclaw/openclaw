import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  takeControlUiScreenshotFrame,
  waitForControlUiProofSurface,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "./chat-flow.test-support.ts";
import { polledText, polledVisible } from "./chat-presentation.test-support.ts";
import { modelPicker, runtimeModel } from "./chat-runtime-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Model picker runtime identity" });

suite.define(() => {
  it.each([
    { width: 1280, colorScheme: "light" as const },
    { width: 390, colorScheme: "dark" as const },
  ])("keeps names and runtime routes readable at $width pixels", async ({ width, colorScheme }) => {
    await suite.withPage({ viewport: { width, height: 900 }, colorScheme }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        agentModel: "openai/atlas-pro",
        models: [
          runtimeModel(
            "atlas-pro",
            "openai",
            "Atlas Pro Extended",
            ["openclaw", "codex", "agentsapi"],
            {
              contextTokens: 921_600,
              contextWindow: 1_000_000,
              runtimeChoices: ["codex", "agentsapi"].map((id) => ({
                agentRuntime: { id, source: "model" },
                available: true,
                contextTokens: 921_600,
                contextWindow: 1_000_000,
              })),
            },
          ),
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const { picker, trigger, search, runtime } = modelPicker(page);
      await page.getByRole("textbox", { name: "Chat composer", exact: true }).click();
      await trigger.click();
      const agents = runtime("agentsapi");
      const codex = runtime("codex");
      await polledVisible(agents).toBe(true);
      const menu = picker.locator(".chat-controls__model-menu");
      await waitForControlUiProofSurface(menu, [agents, codex]);
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const frame = await takeControlUiScreenshotFrame(page, menu, [agents, codex, trigger], {
          animations: "disabled",
          elements: [menu],
        });
        await writeFile(path.join(suite.artifactDir, `${width}-page.png`), frame.png);
        await writeFile(
          path.join(suite.artifactDir, `${width}-picker.png`),
          frame.elements[0]!.png,
        );
      }
      const menuBox = (await menu.boundingBox())!;
      expect(menuBox.x).toBeGreaterThanOrEqual(0);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
      if (width === 1280) {
        expect(menuBox.width).toBeCloseTo(440, 0);
      }
      for (const row of [picker.locator("[data-chat-model-default]"), agents, codex]) {
        const name = row.locator(".chat-controls__model-option-name");
        const meta = row.locator(".chat-controls__model-option-meta");
        const typography = await row.evaluate((element) => {
          const nameStyle = getComputedStyle(
            element.querySelector(".chat-controls__model-option-name")!,
          );
          const rowStyle = getComputedStyle(element);
          return {
            fontSize: nameStyle.fontSize,
            lineHeight: nameStyle.lineHeight,
            fontWeight: nameStyle.fontWeight,
            rowHeight: element.getBoundingClientRect().height,
            padding: rowStyle.padding,
          };
        });
        expect(typography).toEqual({
          fontSize: "13px",
          lineHeight: "20.15px",
          fontWeight: "600",
          rowHeight: 40,
          padding: "6px 9px",
        });
        expect(await row.getAttribute("aria-label")).toContain("Atlas Pro Extended");
        if (width === 1280) {
          expect(await name.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
            true,
          );
        }
        const nameBox = (await name.boundingBox())!;
        const metaBox = (await meta.boundingBox())!;
        const badge = row.locator(".chat-controls__model-state-label--default");
        const lastLabelBox = (await badge.count()) ? (await badge.boundingBox())! : nameBox;
        expect(metaBox.x - lastLabelBox.x - lastLabelBox.width).toBeGreaterThanOrEqual(4);
        expect(metaBox.x - lastLabelBox.x - lastLabelBox.width).toBeLessThanOrEqual(8);
        expect(
          Math.abs(metaBox.y + metaBox.height / 2 - nameBox.y - nameBox.height / 2),
        ).toBeLessThanOrEqual(1);
        expect((await row.boundingBox())!.height).toBeLessThanOrEqual(width === 1280 ? 40 : 44);
        if (width === 1280) {
          expect(await meta.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
            true,
          );
        }
      }
      await polledText(agents.locator(".chat-controls__model-option-meta")).toBe(
        "922k active · 1M max · Agents API",
      );
      for (const query of ["Agents API", "agentsapi"]) {
        await search.fill(query);
        await polledVisible(agents).toBe(true);
        await polledVisible(codex).toBe(false);
      }
      await search.press("Enter");
      const patch = await gateway.waitForRequest("sessions.patch");
      expect(patch.params).toMatchObject({ model: "openai/atlas-pro", agentRuntime: "agentsapi" });
    });
  });
});
