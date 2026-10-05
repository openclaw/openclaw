import path from "node:path";
import { expect, it } from "vitest";
import type { UserProfile } from "../../../packages/gateway-protocol/src/index.ts";
import { buildOnboardingWelcome } from "../../../src/system-agent/onboarding-welcome.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI onboarding locale" });
const unnamedProfile = {
  id: "profile-onboarding-name",
  displayName: null,
  emails: [],
  avatarMime: null,
  hasAvatar: false,
  githubIdentity: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 1,
} satisfies UserProfile;

suite.define(() => {
  it("keeps the optional profile-name prompt usable at desktop and mobile widths", async () => {
    await suite.withPage(
      { serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        await installMockGateway(page, {
          operatorScopes: ["operator.admin", "operator.read", "operator.write"],
          featureMethods: ["openclaw.chat"],
          presenceUsers: [{ id: unnamedProfile.id, self: true }],
          methodResponses: {
            "channels.status": {
              ts: 1,
              channelOrder: [],
              channelLabels: {},
              channels: {},
              channelAccounts: {},
              channelDefaultAccountId: {},
            },
            "users.self": { profile: unnamedProfile },
          },
        });
        await page.goto(`${suite.server.baseUrl}custodian?onboarding=1`, {
          waitUntil: "domcontentloaded",
        });

        const nameInput = page.getByRole("textbox", { name: "Your name" });
        const heading = page.getByRole("heading", { name: "What should we call you?" });
        const skipButton = page.getByRole("button", { name: "Maybe later" });
        await heading.waitFor();
        await nameInput.waitFor();
        await skipButton.waitFor();
        expect(await heading.isVisible()).toBe(true);
        expect(await nameInput.isVisible()).toBe(true);
        expect(await skipButton.isVisible()).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({
          animations: "disabled",
          path: path.join(suite.artifactDir, "profile-name-desktop.png"),
        });

        await page.setViewportSize({ width: 390, height: 844 });
        expect(await nameInput.isVisible()).toBe(true);
        expect(await skipButton.isVisible()).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({
          animations: "disabled",
          path: path.join(suite.artifactDir, "profile-name-mobile.png"),
        });

        await skipButton.click();
        await page.locator(".custodian__name-prompt").waitFor({ state: "detached" });
        expect(
          await page
            .locator(".custodian--page")
            .evaluate((element) => element.classList.contains("custodian--onboarding")),
        ).toBe(false);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({
          animations: "disabled",
          path: path.join(suite.artifactDir, "profile-name-skipped-mobile.png"),
        });

        await page.setViewportSize({ width: 1280, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({
          animations: "disabled",
          path: path.join(suite.artifactDir, "profile-name-skipped-desktop.png"),
        });
      },
    );
  });

  it("uses the selected Chinese UI locale for the onboarding welcome and keeps replies actionable", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 1000 } },
      async ({ page }) => {
        const localeLoad = await holdModuleResponse(page, /\/assets\/zh-CN-[^/]+\.js$/);
        await page.addInitScript(() => {
          localStorage.setItem("openclaw.i18n.locale", "zh-CN");
        });
        const welcome = await buildOnboardingWelcome({
          engine: {
            loadOverview: async () => ({
              config: { exists: false, valid: true },
              defaultModel: "example/verified-model",
            }),
            propose: () => undefined,
            noteAssistantMessage: () => undefined,
          } as never,
          workspace: "/workspace/example",
          locale: "zh-CN",
        });
        const gateway = await installMockGateway(page, {
          featureMethods: ["openclaw.chat"],
          methodResponses: {
            "openclaw.chat": {
              sessionId: "locale-onboarding",
              reply: welcome.text,
              question: welcome.question,
              action: "none",
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}custodian?onboarding=1`, {
          waitUntil: "domcontentloaded",
        });
        await localeLoad.request;
        const connect = await gateway.waitForRequest("connect");
        localeLoad.release();
        await page.locator(".custodian__messages h2").first().waitFor();
        await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe("zh-CN");
        await page.screenshot({
          animations: "disabled",
          path: path.join(suite.artifactDir, "onboarding-welcome-zh-CN.png"),
        });
        expect(connect.params).toMatchObject({ locale: "zh-CN" });
        await page
          .getByRole("heading", { name: "你好，我是 OpenClaw — 我们来孵化你的智能体吧。" })
          .waitFor();
        await page.getByRole("radio", { name: /是的 — 开始设置/ }).click();
        const answer = await gateway.waitForRequest("openclaw.chat", { match: { message: "yes" } });
        expect(answer.params).toMatchObject({ message: "yes" });
      },
    );
  });
});
