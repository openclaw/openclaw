import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Personal enrollment mocked Gateway" });
const owner = {
  id: "gateway-owner",
  displayName: "Shared owner",
  avatarMime: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
  emails: [],
  githubIdentity: null,
  hasAvatar: false,
};
const person = { ...owner, id: "11111111-1111-4111-8111-111111111111", displayName: "Ada" };

suite.define(() => {
  it.each([1280, 390])(
    "enrolls a local person with a stable retry and reconnects at %s px",
    async (width) => {
      await suite.withPage(
        { viewport: { width, height: 900 }, reducedMotion: "reduce" },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            presenceUsers: [{ self: true, id: owner.id, name: owner.displayName }],
            methodResponses: {
              "users.self": { profile: owner },
              "users.list": { profiles: [owner, person] },
            },
          });
          await page.goto(suite.server.baseUrl + "settings/profile");
          const surface = page.locator(".personal-enrollment");
          await surface.getByRole("button", { name: "Set up personal profile" }).click();
          const name = surface.getByRole("textbox", { name: "Your name (optional)" });
          await page.evaluate(() =>
            Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined }),
          );
          await name.fill("Ada");
          if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
            const directory = createControlUiE2eArtifactDir("personal-after-" + width);
            const frame = await takeControlUiScreenshotFrame(page, surface, [name], {
              animations: "disabled",
              scrollTo: surface,
              elements: [surface],
            });
            await writeFile(path.join(directory, "page.png"), frame.png);
          }
          await gateway.deferNext("device.profile.enroll");
          await surface.getByRole("button", { name: "Use this profile", exact: true }).click();
          const first = await gateway.waitForRequest("device.profile.enroll");
          expect(first.params).toEqual({
            enrollmentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            name: "Ada",
          });
          await gateway.rejectDeferred("device.profile.enroll", {
            code: "CONFLICT",
            message: "Synthetic attachment conflict",
          });
          await surface
            .getByRole("alert")
            .getByText("This device or person changed.", { exact: false })
            .waitFor();
          expect(await name.inputValue()).toBe("Ada");
          await gateway.deferNext("device.profile.enroll");
          await surface.getByRole("button", { name: "Use this profile", exact: true }).click();
          const retry = await gateway.waitForRequest("device.profile.enroll", { after: 1 });
          expect(retry.params).toEqual(first.params);
          const connects = await gateway.getRequests("connect");
          const connectParams = connects[0]?.params;
          const deviceId =
            typeof connectParams === "object" &&
            connectParams !== null &&
            "device" in connectParams &&
            typeof connectParams.device === "object" &&
            connectParams.device !== null &&
            "id" in connectParams.device
              ? connectParams.device.id
              : undefined;
          expect(typeof deviceId).toBe("string");
          await gateway.setMethodResponse("users.self", { profile: person });
          await gateway.resolveDeferred("device.profile.enroll", {
            deviceId,
            profileId: person.id,
            operatorToken: {
              token: "personal-device-token",
              scopes: ["operator.admin", "operator.read"],
            },
          });
          const reconnect = await gateway.waitForRequest("connect", { after: connects.length });
          expect(reconnect.params).toMatchObject({
            auth: { deviceToken: "personal-device-token" },
          });
          await page.locator(".profile-hero__name").getByText("Ada", { exact: true }).waitFor();
        },
      );
    },
  );

  it("selects an existing person without a name or enrollment UUID", async () => {
    await suite.withPage(undefined, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        presenceUsers: [{ self: true, id: owner.id, name: owner.displayName }],
        methodResponses: {
          "users.self": { profile: owner },
          "users.list": { profiles: [owner, person] },
        },
      });
      await page.goto(suite.server.baseUrl + "settings/profile");
      const surface = page.locator(".personal-enrollment");
      await surface.getByRole("button", { name: "Set up personal profile" }).click();
      await surface.getByRole("combobox", { name: "Person", exact: true }).selectOption(person.id);
      await gateway.deferNext("device.profile.enroll");
      await surface.getByRole("button", { name: "Use this profile", exact: true }).click();
      expect((await gateway.waitForRequest("device.profile.enroll")).params).toEqual({
        profileId: person.id,
      });
      await gateway.rejectDeferred("device.profile.enroll", {
        code: "FORBIDDEN",
        message: "The operator device was revoked",
      });
      await surface
        .getByRole("alert")
        .getByText("Personal setup requires", { exact: false })
        .waitFor();
    });
  });

  it("assigns another operator device from Devices without exposing another device’s token", async () => {
    await suite.withPage(undefined, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "node.list": { nodes: [] },
          "system-presence": [],
          "device.pair.list": {
            pending: [],
            paired: [
              {
                deviceId: "other-operator",
                displayName: "Office browser",
                roles: ["operator"],
                scopes: ["operator.read"],
              },
            ],
          },
          "users.list": { profiles: [owner, person] },
        },
      });
      await page.goto(suite.server.baseUrl + "settings/devices");
      const device = page.locator('[data-device-id="other-operator"]');
      await device.locator("summary").first().click();
      await device.getByRole("button", { name: "Assign a person" }).click();
      const form = page.locator("openclaw-modal-dialog .personal-enrollment");
      await form.getByRole("button", { name: "Set up personal profile" }).click();
      await form.getByRole("combobox", { name: "Person", exact: true }).selectOption(person.id);
      await gateway.deferNext("device.profile.enroll");
      await form.getByRole("button", { name: "Use this profile", exact: true }).click();
      expect((await gateway.waitForRequest("device.profile.enroll")).params).toEqual({
        deviceId: "other-operator",
        profileId: person.id,
      });
      await gateway.resolveDeferred("device.profile.enroll", {
        deviceId: "other-operator",
        profileId: person.id,
      });
      await form
        .getByRole("status")
        .getByText("Person assigned. That device will use this profile when it reconnects.", {
          exact: true,
        })
        .waitFor();
      expect(await gateway.getRequests("connect")).toHaveLength(1);
    });
  });

  it("offers optional personal setup only after inference verification and can skip it", async () => {
    await suite.withPage(undefined, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "openclaw.chat", "openclaw.setup.auto"],
        deferredMethods: ["openclaw.setup.auto"],
        methodResponses: {
          "openclaw.chat": {
            sessionId: "personal-setup",
            reply: "Your AI is ready.",
            action: "none",
          },
          "users.self": { profile: owner },
        },
      });
      await page.goto(suite.server.baseUrl + "custodian?onboarding=1");
      await page.getByRole("heading", { name: "Connecting your AI…" }).waitFor();
      expect(await page.locator(".personal-enrollment").count()).toBe(0);
      await gateway.resolveDeferred("openclaw.setup.auto", {
        status: "configured",
        selected: {
          kind: "ollama",
          label: "Local model",
          detail: "Local",
          modelRef: "ollama/local-model",
        },
        alternatives: [],
        attempts: [],
        installedPlugins: [],
      });
      await page
        .getByRole("heading", { name: "Your AI is ready. Make this Gateway personal?" })
        .waitFor();
      await page.getByRole("button", { name: "Not now", exact: true }).click();
      expect(await page.locator(".personal-enrollment").count()).toBe(0);
      expect(await gateway.getRequests("device.profile.enroll")).toHaveLength(0);
    });
  });
});
