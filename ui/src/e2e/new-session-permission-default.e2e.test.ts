import { writeFile } from "node:fs/promises";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  controlUiSessionUrl,
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

async function capturePermissionPicker(
  page: Page,
  trigger: Locator,
  artifacts: string,
  stage: string,
) {
  // The empty mobile chat composer reveals its toolbar when editing starts.
  if (!(await trigger.isVisible())) {
    await page.locator(".agent-chat__composer-combobox textarea").click();
  }
  await trigger.click();
  const menu = page.locator(".chat-controls__permission-menu:visible");
  const defaultOption = menu.locator('[data-chat-permission-option="default"]');
  // Observe the inherited choice before clicking it can conceal an explicit-mode regression.
  await expect.poll(() => defaultOption.getAttribute("aria-checked")).toBe("true");
  expect(await trigger.getAttribute("data-chat-select-value")).toBe("");
  const frame = await takeControlUiScreenshotFrame(page, menu, [trigger, defaultOption], {
    animations: "disabled",
    elements: [menu, trigger],
  });
  await writeFile(`${artifacts}/${stage}.png`, frame.png);
  await writeFile(`${artifacts}/${stage}-menu.png`, frame.elements[0]!.png);
  await writeFile(`${artifacts}/${stage}-trigger.png`, frame.elements[1]!.png);
  const alignment = await menu.locator("[data-chat-permission-option]").evaluateAll((rows) =>
    rows.map((row) => {
      const bounds = row.getBoundingClientRect();
      const center = bounds.y + bounds.height / 2;
      return {
        mode: row.getAttribute("data-chat-permission-option"),
        offsets: [
          ...row.querySelectorAll(
            ":scope > .oc-menu-item__icon, :scope > .oc-menu-item__details, .chat-controls__permission-option-icon svg, .chat-controls__permission-option-state svg, .btn__spinner",
          ),
        ]
          .filter((slot) => slot.getBoundingClientRect().height > 0)
          .map((slot) => {
            const rect = slot.getBoundingClientRect();
            return Math.abs(rect.y + rect.height / 2 - center);
          }),
      };
    }),
  );
  await writeFile(`${artifacts}/${stage}-alignment.json`, JSON.stringify(alignment, null, 2));
  for (const row of alignment) {
    for (const offset of row.offsets) {
      expect
        .soft(offset, `${stage}: ${row.mode} icon centers in its whole row`)
        .toBeLessThanOrEqual(1);
    }
  }
  const label = (await trigger.textContent())?.trim();
  await defaultOption.click();
  return label;
}

suite.define(() => {
  it.each([
    { scope: "operator.admin", mode: "full", label: "Full access", width: 1280 },
    { scope: "operator.write", mode: "workspace", label: "Auto-review", width: 320 },
  ])(
    "shows the attended default for $scope without overriding existing sessions or the request",
    async ({ scope, mode, label, width }) => {
      const artifacts = createControlUiE2eArtifactDir(`new-session-permission-default-${scope}`);
      const options = { ...createControlUiE2eContextOptions(), viewport: { width, height: 800 } };
      await suite.withPage(options, async ({ page }) => {
        const session = {
          key: "agent:main:existing-permission",
          kind: "direct",
          label: "Existing session",
          sessionId: "existing-permission-generation",
          updatedAt: 1,
        };
        const gateway = await installMockGateway(page, {
          assistantName: "Permission demo",
          operatorScopes: ["operator.read", scope],
          featureMethods: [
            "agent.wait",
            "chat.metadata",
            "chat.startup",
            "sessions.create",
            "sessions.dispatch",
            "sessions.patch",
          ],
          sessions: [session],
          sessionKey: session.key,
          methodResponses: {
            "agents.list": {
              agents: [
                {
                  id: "main",
                  name: "Permission demo",
                  identity: { name: "Permission demo" },
                  defaultPermissionMode: "read-only",
                  newSessionPermissionMode: mode,
                },
              ],
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, session.key));
        const existingTrigger = page.locator(
          'openclaw-chat-pane[aria-hidden="false"] [data-chat-permission-select="true"]',
        );
        await expect
          .poll(async () => (await existingTrigger.textContent())?.trim())
          .toBe("Read only");
        const existing = await capturePermissionPicker(
          page,
          existingTrigger,
          artifacts,
          "existing",
        );

        await page.goto(suite.server.baseUrl + "new");
        const trigger = page.locator('[data-chat-permission-select="true"]');
        await expect.poll(async () => (await trigger.textContent())?.trim()).toBe(label);
        const creation = await capturePermissionPicker(page, trigger, artifacts, "new-session");
        expect(await trigger.getAttribute("data-chat-select-value")).toBe("");
        await gateway.deferNext("sessions.create");
        await page.locator(".new-session-page__message").fill("Review the sample workspace");
        await page.getByRole("button", { name: "Start session" }).click();
        const request = await gateway.waitForRequest("sessions.create");
        await writeFile(
          artifacts + "/observations.json",
          JSON.stringify({ existing, creation, createParams: request.params }, null, 2),
        );
        expect(request.params).toMatchObject({ message: "Review the sample workspace" });
        expect(request.params).not.toHaveProperty("permissionMode");
        expect(existing).toBe("Read only");
        expect(creation).toBe(label);
      });
    },
  );
});
