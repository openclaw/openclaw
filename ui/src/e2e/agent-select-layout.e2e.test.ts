import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent picker layout",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it.each([1280, 390])("keeps selection indicators inside compact rows at %ipx", async (width) => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { width, height: 900 } },
      async ({ page }) => {
        await installMockGateway(page, {
          methodResponses: {
            "agents.list": {
              agents: [
                { id: "main", name: "Main agent" },
                { id: "writer", name: "Writer" },
              ],
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/agents`);
        if (width === 390) {
          await page.locator(".topbar-nav-toggle").click();
        }
        const picker = page.locator(".settings-sidebar__agent openclaw-agent-select");
        const trigger = picker.locator(".agent-select__trigger");
        const openPicker = async () => {
          await picker.waitFor();
          await Promise.all([
            picker.evaluate(
              (element) =>
                new Promise<void>((resolve) => {
                  element.addEventListener("wa-after-show", () => resolve(), { once: true });
                }),
            ),
            trigger.click(),
          ]);
        };
        await openPicker();
        const selected = picker.getByRole("menuitemradio", { name: "Main agent", exact: true });
        const writer = picker.getByRole("menuitemradio", { name: "Writer", exact: true });
        await selected.waitFor({ state: "visible" });

        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const proofDir = createControlUiE2eArtifactDir(`agent-select-layout-${width}`);
          await page.screenshot({
            path: path.join(proofDir, "agent-picker.png"),
            animations: "disabled",
          });
        }

        const check = await selected.locator(".agent-select__option-check svg").boundingBox();
        const avatar = await selected.locator(".agent-select__avatar").boundingBox();
        const label = await selected.locator(".agent-select__option-label").boundingBox();
        const selectedRow = await selected.boundingBox();
        const otherRow = await writer.boundingBox();
        expect(check).not.toBeNull();
        expect(avatar).not.toBeNull();
        expect(label).not.toBeNull();
        expect(selectedRow).not.toBeNull();
        expect(otherRow).not.toBeNull();
        expect(check!.width).toBeGreaterThan(0);
        expect(check!.width).toBeLessThanOrEqual(avatar!.width);
        expect(check!.height).toBeLessThanOrEqual(avatar!.height);
        expect(check!.x).toBeGreaterThanOrEqual(label!.x + label!.width);
        expect(check!.y + check!.height / 2).toBeCloseTo(label!.y + label!.height / 2, 0);
        expect(selectedRow!.height).toBeCloseTo(otherRow!.height, 0);

        await writer.click();
        await expect.poll(() => trigger.textContent()).toContain("Writer");
        await openPicker();
        await expect.poll(() => writer.getAttribute("aria-checked")).toBe("true");
        expect(await selected.locator(".agent-select__option-check").count()).toBe(0);
        const writerCheck = await writer.locator(".agent-select__option-check svg").boundingBox();
        expect(writerCheck?.width).toBe(check!.width);
        expect(writerCheck?.height).toBe(check!.height);
        expect((await writer.boundingBox())?.height).toBeCloseTo(otherRow!.height, 0);
      },
    );
  });
});
