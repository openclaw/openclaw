import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiElementScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  LOCAL_GIT_WORKSPACE_RESPONSES,
  captureUiProofEnabled,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("omits unavailable cloud operating systems while preserving Linux dispatch", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 1080 } },
      async ({ page }) => {
        const sessionKey = "agent:main:cloud-os";
        const profile = {
          id: "aws",
          providerId: "crabbox",
          machines: [{ id: "standard", label: "Standard", cpu: 32, memoryGb: 64, default: true }],
        };
        const disabledReason = "Upgrade Crabbox to 0.53.1 or newer, then restart the Gateway.";
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.admin", "operator.read", "operator.write"],
          workspaceGit: true,
          deferredMethods: ["sessions.dispatch"],
          methodResponses: {
            ...LOCAL_GIT_WORKSPACE_RESPONSES,
            "environments.list": { environments: [], profiles: [profile] },
            "sessions.create": { key: sessionKey },
            "sessions.list": createdSessionListResult(sessionKey),
          },
        });

        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("environments.list");
        const trigger = page.locator("#new-session-where-trigger");
        const picker = page.locator("wa-popover.new-session-page__where-popover");
        await trigger.click();
        await picker.getByRole("button", { name: "aws", exact: true }).click();
        await picker.locator('[data-value="cloud:aws"]').hover();
        await picker.locator('[data-value="machine:standard"]').waitFor();
        expect(await picker.locator('[data-value^="os:"]').count()).toBe(0);
        const capturePicker = async (fileName: string) => {
          if (captureUiProofEnabled) {
            await writeFile(
              path.join(suite.artifactDir, fileName),
              await takeControlUiElementScreenshot(
                page,
                picker.locator('wa-popup [part="popup"]'),
                [picker.locator('[data-value="machine:standard"]')],
              ),
            );
          }
        };
        await capturePicker("01-before-os-capability-metadata.png");

        await gateway.setMethodResponse("environments.list", {
          environments: [],
          profiles: [
            {
              ...profile,
              operatingSystems: [
                { id: "linux", label: "Linux", default: true },
                { id: "macos", label: "macOS", disabledReason },
                { id: "windows", label: "Windows", disabledReason },
              ],
            },
          ],
        });
        await gateway.emitGatewayEvent("node.runnerInventory.changed");
        const linux = picker.locator('[data-value="os:linux"]');
        await picker.locator('[data-value="cloud:aws"]').hover();
        await linux.waitFor();
        expect(await linux.evaluate((element) => element.tagName)).toBe("SPAN");
        expect(await linux.getAttribute("aria-pressed")).toBeNull();
        expect(await linux.textContent()).toBe("Linux");
        for (const os of ["macos", "windows"]) {
          const option = picker.locator(`[data-value="os:${os}"]`);
          expect(await option.count()).toBe(0);
        }
        await capturePicker("02-after-unavailable-operating-systems.png");
        await page.keyboard.press("Escape");
        await page.locator(".new-session-page__message").fill("Continue on Linux");
        await page.getByRole("button", { name: "Start session" }).click();
        const dispatch = await gateway.waitForRequest("sessions.dispatch");
        expect(dispatch.params).toEqual({ key: sessionKey, agentId: "main", profileId: "aws" });
      },
    );
  });
});
