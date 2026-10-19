import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  captureUiProof,
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("captures the unconfigured Cloud picker", async () => {
    await suite.withPage({ locale: "en-US" }, async ({ page }) => {
      const artifactDir = createControlUiE2eArtifactDir("suggested-cloud");
      const gateway = await installMockGateway(page, {
        methodResponses: { "environments.list": { environments: [], profiles: [] } },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();
      const picker = page.locator(".oc-popover.new-session-page__where-popover");
      await picker.getByRole("searchbox").waitFor();
      expect(await picker.getByRole("button", { name: "Cloud", exact: true }).count()).toBe(0);
      await captureUiProof({ artifactDir }, page, "suggested-cloud-before.png", {
        surface: picker,
        content: [picker.getByRole("searchbox")],
      });
    });
  });
  it("saves the suggested Cloud profile before selecting it", async () => {
    await suite.withPage({ locale: "en-US" }, async ({ page }) => {
      const artifactDir = createControlUiE2eArtifactDir("suggested-cloud");
      const profile = {
        id: "cloud",
        providerId: "crabbox",
        providerDisplayId: "aws",
        executionModes: ["worker-turn"],
      };
      const gateway = await installMockGateway(page, {
        featureMethods: ["environments.adoptSuggestedProfile"],
        deferredMethods: ["environments.adoptSuggestedProfile"],
        methodResponses: {
          "environments.list": { environments: [], profiles: [], suggestedProfile: profile },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();
      const picker = page.locator(".oc-popover.new-session-page__where-popover");
      const cloud = picker.getByRole("button", { name: "Cloud", exact: true });
      await cloud.waitFor();
      expect(await cloud.locator('[data-provider-icon="aws"]').count()).toBe(1);
      await captureUiProof({ artifactDir }, page, "suggested-cloud-after.png", {
        surface: picker,
        content: [cloud],
      });
      await cloud.click();
      await gateway.waitForRequest("environments.adoptSuggestedProfile");
      expect(
        await page.locator("#new-session-where-trigger").getAttribute("data-cloud-profile"),
      ).toBeNull();
      expect(await gateway.getRequests("sessions.dispatch")).toEqual([]);
      await gateway.setMethodResponse("environments.list", {
        environments: [],
        profiles: [profile],
      });
      await gateway.resolveDeferred("environments.adoptSuggestedProfile", { profile });
      await expect
        .poll(() => page.locator("#new-session-where-trigger").getAttribute("data-cloud-profile"))
        .toBe("cloud");
    });
  });
});
