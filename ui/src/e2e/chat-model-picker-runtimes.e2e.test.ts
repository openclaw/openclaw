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
      const agents = picker.locator(
        '.chat-controls__runtime-option[data-chat-model-runtime="agentsapi"]',
      );
      const codex = picker.locator(
        '.chat-controls__runtime-option[data-chat-model-runtime="codex"]',
      );
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
        expect(menuBox.width).toBeCloseTo(416, 0);
      }
      for (const id of ["openclaw", "agentsapi", "codex"]) {
        await picker
          .locator(`.chat-controls__runtime-option[data-chat-model-runtime="${id}"]`)
          .click();
        const row = runtime(id);
        await polledVisible(row).toBe(true);
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
          fontSize: width === 1280 ? "13px" : "14px",
          lineHeight: width === 1280 ? "20.15px" : "21.7px",
          fontWeight: "500",
          rowHeight: width === 1280 ? 36 : 44,
          padding: "0px 6px 0px 10px",
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
        const favoriteSlotBox = (await row
          .locator(".chat-controls__model-favorite-slot")
          .boundingBox())!;
        expect(favoriteSlotBox.width).toBe(28);
        expect(favoriteSlotBox.x - metaBox.x - metaBox.width).toBe(width === 1280 ? 4 : 12);
        expect(
          Math.abs(metaBox.y + metaBox.height / 2 - nameBox.y - nameBox.height / 2),
        ).toBeLessThanOrEqual(1);
        if (width === 1280) {
          expect(await meta.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
            true,
          );
        }
      }
      const agentsRow = runtime("agentsapi");
      const beforeSelection = (await gateway.getRequests("sessions.patch")).length;
      await picker
        .locator('.chat-controls__runtime-option[data-chat-model-runtime="agentsapi"]')
        .click();
      const patch = await gateway.waitForRequest("sessions.patch", { after: beforeSelection });
      await polledText(agentsRow.locator(".chat-controls__model-option-meta")).toBe(
        "922k active · 1M max",
      );
      expect(await agentsRow.getAttribute("aria-label")).toContain("Agents API");
      for (const query of ["Agents API", "agentsapi"]) {
        await search.fill(query);
        await polledVisible(agentsRow).toBe(true);
        await polledVisible(runtime("codex")).toBe(false);
      }
      expect(patch.params).toMatchObject({
        model: "openai/atlas-pro",
        agentRuntime: "agentsapi",
      });
    });
  });
});
