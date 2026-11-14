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
  const label = (await trigger.textContent())?.trim();
  await defaultOption.click();
  return label;
}

suite.define(() => {
  it("shows the attended creation default without overriding an existing session or the create request", async () => {
    const artifacts = createControlUiE2eArtifactDir("new-session-permission-default");
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const session = {
        key: "agent:main:existing-permission",
        kind: "direct",
        label: "Existing session",
        sessionId: "existing-permission-generation",
        updatedAt: 1,
      };
      const gateway = await installMockGateway(page, {
        assistantName: "Permission demo",
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
                newSessionPermissionMode: "full",
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
      const existing = await capturePermissionPicker(page, existingTrigger, artifacts, "existing");

      await page.goto(suite.server.baseUrl + "new");
      const trigger = page.locator('[data-chat-permission-select="true"]');
      await expect.poll(async () => (await trigger.textContent())?.trim()).toBe("Full access");
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
      expect(creation).toBe("Full access");
    });
  });
});
