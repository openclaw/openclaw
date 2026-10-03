import path from "node:path";
import { expect, it } from "vitest";
import { buildOnboardingWelcome } from "../../../src/system-agent/onboarding-welcome.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI onboarding locale" });

suite.define(() => {
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
