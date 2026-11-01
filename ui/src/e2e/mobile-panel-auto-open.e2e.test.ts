import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "native mobile panel presentation",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:mobile-proof";

suite.define(() => {
  it.each([true, false])(
    "blocks automatic presentation only in native mobile (%s) and retains manual panels",
    async (nativeMobile) => {
      await suite.withPage(
        {
          viewport: { width: 390, height: 844 },
          userAgent:
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
          isMobile: true,
          hasTouch: true,
          colorScheme: "dark",
        },
        async ({ page }) => {
          // Model the existing iOS shared-auth WebView, which has no native embed flag.
          // This exercises real Control UI code, not an installed native application.
          if (nativeMobile) {
            await page.addInitScript(() => {
              window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
                gatewayUrl: "ws://127.0.0.1:18789",
                token: "synthetic-proof",
              };
            });
          }
          const gateway = await installMockGateway(page, {
            sessionKey,
            sessions: [
              { key: sessionKey, label: "Mobile workspace", kind: "direct", updatedAt: 1 },
            ],
            historyMessages: [
              {
                role: "assistant",
                content: [
                  { type: "text", text: "I am checking the workspace. You can keep reading here." },
                ],
              },
            ],
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await page
            .getByText("I am checking the workspace. You can keep reading here.")
            .first()
            .waitFor();
          await gateway.emitGatewayEvent("ui.command", {
            sessionKey,
            command: { kind: "panel", panel: "browser", open: true },
          });
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              }),
          );
          expect(await page.locator('[data-panel-slot="browser"]:visible').count()).toBe(
            nativeMobile ? 0 : 1,
          );
          const [connect] = await gateway.getRequests("connect");
          expect(connect).toBeDefined();
          const advertised = expect.objectContaining({
            caps: expect.arrayContaining(["ui-commands"]),
          });
          if (nativeMobile) {
            expect(connect?.params).not.toEqual(advertised);
          } else {
            expect(connect?.params).toEqual(advertised);
          }
          await openChatSidePanelType(page, "Files");
          await page.locator('[data-panel-slot="workspace"]:visible').waitFor();
        },
      );
    },
  );
});
