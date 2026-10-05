import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  captureComposerProof,
  installTalkBrowserFixtures,
  TALK_READY_HISTORY_MESSAGE,
} from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI foreground voice policy" });
const reason =
  "Talk and dictation cannot confirm foreground cleanup. Send a new chat message on this Gateway.";

suite.define(() => {
  for (const policy of ["role", "session"] as const) {
    it.each([
      { name: "desktop", viewport: { width: 1440, height: 1000 } },
      { name: "mobile", viewport: { width: 390, height: 844 } },
    ])(
      `explains ${policy} foreground voice limits on $name without blocking chat`,
      async ({ name, viewport }) => {
        await suite.withPage({ viewport, permissions: ["microphone"] }, async ({ page }) => {
          const gateway = await installMockGateway(page, {
            featureMethods: [...defaultControlUiFeatureMethods, "projects.list"],
            operatorScopes: ["operator.admin"],
            historyMessages: [TALK_READY_HISTORY_MESSAGE],
            sessions: [
              {
                key: "agent:main:main",
                label: "Main",
                kind: "direct",
                updatedAt: 1,
                ...(policy === "session" ? { execution: "foreground-only" } : {}),
              },
            ],
            methodResponses: {
              "projects.list": {
                projects: [],
                ...(policy === "role" ? { creationPolicy: { execution: "foreground-only" } } : {}),
              },
              "talk.catalog": {
                realtime: { ready: true, providers: [] },
                transcription: { ready: true, providers: [] },
              },
            },
          });
          await installTalkBrowserFixtures(page);
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.getByText(TALK_READY_HISTORY_MESSAGE.content, { exact: true }).waitFor();
          await expect
            .poll(() => page.locator(".agent-chat__composer-status").textContent())
            .toContain(reason);
          const voiceButtons = page.locator(".chat-send-btn--voice, .chat-send-btn--talk-mode");
          expect(await voiceButtons.count()).toBeGreaterThanOrEqual(3);
          for (const button of await voiceButtons.all()) {
            expect(await button.isDisabled()).toBe(true);
          }
          expect(await page.locator(".chat-talk-input-picker").count()).toBe(0);
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            await captureComposerProof(suite, page, `foreground-${policy}-${name}.png`);
          }
          await page
            .locator(".agent-chat__composer-combobox textarea")
            .fill("Continue through a new message");
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          const request = await gateway.waitForRequest("chat.send");
          expect(request.params).toMatchObject({
            sessionKey: "agent:main:main",
            message: "Continue through a new message",
          });
          await page.getByRole("button", { name: "Stop generating", exact: true }).click();
          await gateway.waitForRequest("chat.abort");
          expect(await gateway.getRequests("talk.client.create")).toHaveLength(0);
          expect(await gateway.getRequests("talk.session.create")).toHaveLength(0);
          expect(
            await page.evaluate(
              () =>
                (window as Window & { openclawTalkE2eState?: { constraints: unknown[] } })
                  .openclawTalkE2eState?.constraints,
            ),
          ).toEqual([]);
        });
      },
    );
  }
});
