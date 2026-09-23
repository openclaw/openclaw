import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  LOCAL_GIT_WORKSPACE_RESPONSES,
  captureUiProof,
  captureUiProofEnabled,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
  openEnvironmentPicker,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it.each(["displayed", "explicitly selected"])(
    "dispatches the %s default machine instead of delegating a different size",
    async (choice) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          const sessionKey = "agent:main:cloud-size";
          const gateway = await installMockGateway(page, {
            operatorScopes: ["operator.admin", "operator.read", "operator.write"],
            workspaceGit: true,
            deferredMethods: ["sessions.dispatch"],
            methodResponses: {
              ...LOCAL_GIT_WORKSPACE_RESPONSES,
              "environments.list": {
                environments: [],
                profiles: [
                  {
                    id: "aws",
                    providerId: "crabbox",
                    operatingSystems: [{ id: "linux", label: "Linux", default: true }],
                    machines: [
                      { id: "small", label: "Small", os: "linux", cpu: 4, memoryGb: 8 },
                      { id: "standard", label: "Standard", os: "linux", cpu: 32, memoryGb: 64 },
                    ],
                  },
                ],
              },
              "sessions.create": { key: sessionKey },
              "sessions.list": createdSessionListResult(sessionKey),
            },
          });

          await page.goto(`${suite.server.baseUrl}new`);
          await gateway.waitForRequest("environments.list");
          await openEnvironmentPicker(page);
          const picker = page.locator("wa-popover.new-session-page__where-popover");
          await picker.getByRole("button", { name: "aws", exact: true }).click();
          const small = picker.locator('[data-value="machine:small"]');
          await expect.poll(() => small.getAttribute("aria-pressed")).toBe("true");
          if (choice === "explicitly selected") {
            await small.click();
          }
          await captureUiProof(suite, page, "selected-cloud-size.png", {
            surface: picker.locator(".new-session-page__cloud-configuration"),
            content: [small],
          });
          await page.keyboard.press("Escape");
          await page.locator(".new-session-page__message").fill("Use the size shown in the picker");
          await page.getByRole("button", { name: "Start session" }).click();
          const dispatch = await gateway.waitForRequest("sessions.dispatch");
          if (captureUiProofEnabled) {
            await writeFile(
              path.join(suite.artifactDir, "dispatch.json"),
              JSON.stringify(dispatch.params, null, 2),
            );
          }
          expect(dispatch.params).toEqual({
            key: sessionKey,
            agentId: "main",
            profileId: "aws",
            os: "linux",
            machineClass: "small",
          });
        },
      );
    },
  );
});
