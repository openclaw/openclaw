import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { composerValue, fillComposer } from "../test-helpers/composer-editor.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Home command recovery across presentations",
  trackBrowserContexts: true,
});

suite.define(() => {
  it.each([
    { handoff: false, newerDraft: false },
    { handoff: true, newerDraft: false },
    { handoff: true, newerDraft: true },
  ])(
    "recovers a rejected command without replacing newer input (handoff=$handoff, newer=$newerDraft)",
    async ({ handoff, newerDraft }) => {
      const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const homeKey = "agent:main:main";
      const command = "/steer QA recovery message";
      const newer = "QA newer draft stays here";
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "chat.history", "chat.send"],
        sessionKey: homeKey,
        sessions: [{ key: homeKey, kind: "direct", label: "Main", updatedAt: 1 }],
      });
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, homeKey));
        const composer = page.locator(
          "openclaw-chat-page .agent-chat__composer-combobox openclaw-composer-editor",
        );
        await composer.waitFor({ state: "visible" });
        await gateway.deferNext("chat.send", { queueMode: "steer" });
        await fillComposer(composer, command);
        await composer.press("Enter");
        const request = await gateway.waitForRequest("chat.send");
        expect(request.params).toMatchObject({
          sessionKey: homeKey,
          message: "QA recovery message",
          queueMode: "steer",
        });
        await expect.poll(() => composerValue(composer)).toBe("");
        await page.screenshot({ path: `${suite.artifactDir}/command-pending.png`, fullPage: true });

        const dockComposer = page.locator(
          "openclaw-assistant-panel .agent-chat__composer-combobox openclaw-composer-editor",
        );
        if (handoff) {
          await page.getByRole("link", { name: "Agents", exact: true }).click();
          await page.waitForURL((url) => url.pathname.endsWith("/agents"));
          await page.locator(".sidebar-footer-bar__home").click();
          await dockComposer.waitFor({ state: "visible" });
          await expect.poll(() => composerValue(dockComposer)).toBe("");
          if (newerDraft) {
            await fillComposer(dockComposer, newer);
          }
          await page.screenshot({
            path: `${suite.artifactDir}/dock-before-failure.png`,
            fullPage: true,
          });
        }

        await gateway.rejectDeferred("chat.send", {
          code: "UNAVAILABLE",
          message: "QA synthetic command rejection",
        });
        await page
          .locator("openclaw-chat-page .chat-error", { hasText: "QA synthetic command rejection" })
          .waitFor({ state: "attached" });
        const failureObservation = {
          sourceDraft: await composerValue(composer),
          dockDraft: handoff ? await composerValue(dockComposer) : null,
          errors: await page.locator(".chat-error").allTextContents(),
        };
        await page.screenshot({
          path: `${suite.artifactDir}/command-rejected.png`,
          fullPage: true,
        });
        if (handoff) {
          await page.locator("a.nav-item--home").click();
          await composer.waitFor({ state: "visible" });
          await expect.poll(() => dockComposer.isVisible()).toBe(false);
        }
        const receipt = {
          handoff,
          newerDraft,
          failureObservation,
          returnedDraft: await composerValue(composer),
          pageErrors,
          requests: await gateway.getRequests("chat.send"),
        };
        await writeFile(`${suite.artifactDir}/recovery.json`, JSON.stringify(receipt, null, 2));
        await page.screenshot({ path: `${suite.artifactDir}/returned-home.png`, fullPage: true });
        console.log(JSON.stringify({ artifactDir: suite.artifactDir, ...receipt }));
        expect(receipt.requests).toHaveLength(1);
        await expect.poll(() => composerValue(composer)).toBe(newerDraft ? newer : command);
        await page.screenshot({
          path: `${suite.artifactDir}/returned-home-verified.png`,
          fullPage: true,
          animations: "disabled",
        });
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
