import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { scenario } from "./command-palette.test-support.ts";
import {
  captureUiProofEnabled,
  createNewSessionPageE2eSuite,
  installMockGateway,
  openEnvironmentPicker,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it.each([1280, 390])(
    "explains unavailable computers in both selectors at %ipx",
    async (width) => {
      const context = await suite.browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width },
        hasTouch: width === 390,
      });
      const page = await context.newPage();
      const fixture = scenario({
        "projects.list": {
          projects: [
            { id: "docs", displayName: "Documentation", repoRoot: "/workspace/docs" },
            { id: "app", displayName: "Application", repoRoot: "/workspace/app" },
          ],
        },
        "environments.list": {
          profiles: [],
          environments: [
            // Fill the picker so unavailable rows require scrolling on phones.
            ...Array.from({ length: 12 }, (_, index) => ({
              id: `node:available-device-${index}`,
              type: "node",
              label: `Additional computer ${index + 1}`,
              status: "available",
              sessionHost: true,
              workerSlots: { total: 1, available: 1 },
            })),
            {
              id: "node:paired-device",
              type: "node",
              label: "Paired device",
              status: "available",
              sessionHost: false,
            },
            {
              id: "node:offline-device",
              type: "node",
              label: "Offline device",
              status: "unavailable",
              sessionHost: true,
            },
            // Keep the phone inventory overflowing independently of composer placement.
            ...Array.from({ length: width === 390 ? 12 : 0 }, (_, index) => ({
              id: `node:additional-device-${index}`,
              type: "node",
              label: `Additional device ${index + 1}`,
              status: "available",
              sessionHost: true,
            })),
          ],
        },
      });
      const gateway = await installMockGateway(page, {
        ...fixture,
        featureMethods: [...(fixture.featureMethods ?? []), "projects.list"],
      });
      const capture = async (name: string, surface: Locator, content: Locator[]) => {
        if (captureUiProofEnabled) {
          const frame = await takeControlUiScreenshotFrame(page, surface, content, {
            animations: "disabled",
          });
          await writeFile(path.join(suite.artifactDir, `${name}-${width}.png`), frame.png);
        }
      };
      const tapRow = async (row: Locator) => {
        await row.scrollIntoViewIfNeeded();
        const bounds = await row.boundingBox();
        expect(bounds).not.toBeNull();
        await page.touchscreen.tap(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
      };
      const revealReason = async (row: Locator) => {
        expect(await row.getAttribute("aria-disabled")).toBe("true");
        if (width === 390) {
          await tapRow(row);
        } else {
          await page.keyboard.press("Tab");
          await row.focus();
          expect(await row.evaluate((element) => document.activeElement === element)).toBe(true);
          await row.press("Enter");
        }
        const reason = row.locator("xpath=ancestor::openclaw-tooltip[1]").getByRole("tooltip");
        await reason.waitFor({ state: "visible" });
        return reason;
      };

      try {
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("environments.list");
        await openEnvironmentPicker(page);
        const where = page.locator(".oc-popover.new-session-page__where-popover");
        if (width === 390) {
          expect(
            await where
              .locator(".new-session-page__environment-list")
              .evaluate((list) => list.scrollHeight > list.clientHeight),
          ).toBe(true);
        }
        const row = where.locator('[data-value="device:paired-device"]');
        await revealReason(row);
        const details = row
          .locator("xpath=ancestor::openclaw-tooltip[1]")
          .locator('[slot="content"]');
        await details.waitFor({ state: "visible" });
        await capture("picker", where, [row, details]);
        const hint = await details.textContent();
        expect(hint).toContain("openclaw config set nodeHost.workerRuns.enabled true");
        expect(hint).toContain("openclaw node install --force");
        expect(hint).not.toContain("openclaw connect");
        expect(await row.textContent()).toContain("Unavailable");
        if (width === 390) {
          await tapRow(row);
          await row
            .locator("xpath=ancestor::openclaw-tooltip[1]")
            .getByRole("tooltip")
            .waitFor({ state: "hidden" });
        }
        const offline = where.locator('[data-value="device:offline-device"]');
        await revealReason(offline);
        expect(
          await offline
            .locator("xpath=ancestor::openclaw-tooltip[1]")
            .locator('[slot="content"]')
            .textContent(),
        ).toContain("Device unavailable");
        expect(await where.locator('[data-value="gateway"]').getAttribute("aria-pressed")).toBe(
          "true",
        );
        await page.keyboard.press("Escape");
        await page.locator("#new-session-where-trigger").click();
        await page.keyboard.press("ControlOrMeta+K");
        const palette = page.locator("openclaw-command-palette");
        await palette.locator(".cmd-palette__input").waitFor({ state: "visible" });
        await palette.getByRole("button", { name: "New session settings", exact: true }).click();
        const settings = palette.locator(".oc-popover.palette-session-settings");
        await settings.locator(".palette-session-settings__workspace").click();
        await settings
          .locator('[data-machine="local"][data-project="docs"]')
          .waitFor({ state: "visible" });
        await settings
          .getByRole("searchbox", { name: "Search", exact: true })
          .fill("Paired device");
        const choices = settings.locator('[data-machine="device:paired-device"]');
        await choices.first().waitFor({ state: "visible" });
        expect(await choices.count()).toBe(1);
        expect(await choices.textContent()).toContain("Unavailable");
        const reason = await revealReason(choices);
        expect(await reason.textContent()).toContain("Session hosting is disabled");
        await capture("palette", settings, [choices, reason]);
        const search = settings.getByRole("searchbox", { name: "Search", exact: true });
        await search.fill("Offline device");
        const offlineChoice = settings.locator('[data-machine="device:offline-device"]');
        expect(await offlineChoice.count()).toBe(1);
        expect(await (await revealReason(offlineChoice)).textContent()).toContain(
          "Device unavailable",
        );
        await search.fill("Local");
        await settings.locator('[data-machine="local"][data-project=""]').click();
        await settings
          .getByRole("checkbox", { name: /Remember settings for/ })
          .waitFor({ state: "visible" });
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      } finally {
        await context.close();
      }
    },
  );
});
