import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.ts";
import type { OpenClawIdStatusResult } from "../lib/openclaw-id/types.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  createControlUiMockBootstrapConfig,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "OpenClaw ID member welcome" });

suite.define(() => {
  it("asks a member named from their email who they are before offering a composer", async () => {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 760 },
    ]) {
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport },
        async ({ page }) => {
          const status: OpenClawIdStatusResult = {
            status: { state: "on", tunnel: { state: "running", relayOnline: true } },
            channel: "tunnel",
            remoteAccessSetup: null,
            accountSignIn: null,
            owner: false,
            connection: {
              kind: "member",
              role: "operator",
              accountId: "fixture-member",
              email: "sam.rivera@example.test",
              displayName: "sam.rivera",
              invitedBy: { name: "Demo owner", email: null },
            },
            link: { linked: true, hostname: "harbor-a1b2.claws.example.test" },
            services: { issuerUrl: null, discoveryUrl: null, loaderDomain: null },
          };
          const scenario = {
            featureMethods: [...defaultControlUiFeatureMethods, "openclawId.status"],
            methodResponses: { "openclawId.status": status },
            presenceUsers: [{ id: "profile-member", name: "sam.rivera", self: true }],
          };
          const gateway = await installMockGateway(page, scenario, {
            requestHandlers: {
              "users.setDisplayName": (input) => ({
                profile: {
                  id: "profile-member",
                  // SAFETY: the mock echoes the validated request's own display name.
                  displayName: (input as { displayName: string }).displayName,
                  emails: [],
                  avatarMime: null,
                  hasAvatar: false,
                  githubIdentity: null,
                  mergedInto: null,
                  createdAt: 1,
                  updatedAt: 2,
                },
              }),
            },
          });
          await page.route("**" + CONTROL_UI_BOOTSTRAP_CONFIG_PATH, (route) =>
            route.fulfill({
              contentType: "application/json",
              body: JSON.stringify({
                ...createControlUiMockBootstrapConfig(scenario),
                openclawIdEnabled: true,
              }),
            }),
          );
          const step = page.locator(".openclaw-id-welcome-step");
          // The default landing takes a new member to a new session, not the main one.
          await page.goto(suite.server.baseUrl);
          await page.waitForURL((url) => url.pathname.endsWith("/new"));
          await step.getByText("What should people here call you?").waitFor();
          // An explicit link to a session is kept; the welcome stands in for its composer.
          await page.goto(suite.server.baseUrl + "chat/main/~key/elsewhere");
          await step.getByText("What should people here call you?").waitFor();
          expect(await page.getByRole("textbox", { name: "Chat composer" }).count()).toBe(0);
          expect(new URL(page.url()).pathname).toContain("/chat/");
          await page.goto(suite.server.baseUrl + "new");
          await step.getByText("Welcome to harbor. Demo owner invited you.").waitFor();
          await step.getByText("You are signed in as sam.rivera@example.test.").waitFor();
          const composer = page.locator(".new-session-page textarea");
          // The welcome stands where the composer will be: there is no other place to type.
          expect(await composer.count()).toBe(0);
          expect(await page.locator(".agent-chat__suggestion").count()).toBe(0);
          const name = step.getByLabel("Your name");
          expect(await name.evaluate((input) => input === document.activeElement)).toBe(true);
          const proceed = step.getByRole("button", { name: "Continue", exact: true });
          expect(await proceed.isDisabled()).toBe(true);
          const surface = page.locator(".agent-chat__welcome");
          const capture = async (stage: string) => {
            const frame = await takeControlUiScreenshotFrame(page, surface, [surface], {
              animations: "disabled",
            });
            await writeFile(
              path.join(suite.artifactDir, `${stage}-${viewport.width}.png`),
              frame.png,
            );
          };
          await capture("1-ask-name");
          await name.fill("Sam Rivera");
          await name.press("Enter");
          await gateway.waitForRequest("users.setDisplayName", {
            match: { profileId: "profile-member", displayName: "Sam Rivera" },
          });
          await step.getByText("Nice to meet you, Sam Rivera. Want to add a photo?").waitFor();
          expect(await composer.count()).toBe(0);
          await capture("2-ask-photo");
          // The photo control is a real button: reachable and operable from the keyboard.
          const upload = step.getByRole("button", { name: "Upload photo", exact: true });
          await upload.focus();
          const chooser = page.waitForEvent("filechooser");
          await page.keyboard.press("Enter");
          await chooser;
          await step.getByRole("button", { name: "Not now", exact: true }).click();
          await composer.first().waitFor();
          expect(await step.count()).toBe(0);
          await page.getByText("People here see you as Sam Rivera.", { exact: false }).waitFor();
          await capture("3-composer");
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          await page.reload();
          await gateway.waitForRequest("openclawId.status");
          await composer.first().waitFor();
          expect(await step.count()).toBe(0);
        },
      );
    }
  });
});
