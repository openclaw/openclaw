import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { expect, it } from "vitest";
import { controlUiBundledGatewayUrl } from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProof,
  createNewSessionPageE2eSuite,
  installMockGateway,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it.each(["agents.list", "models.list"])(
    "explains unavailable submission while %s is pending",
    async (method) => {
      await suite.withPage(
        {
          viewport: { width: 1280, height: 800 },
          permissions: ["clipboard-read", "clipboard-write"],
        },
        async ({ page }) => {
          if (method === "models.list") {
            await page.addInitScript(
              (key) => {
                localStorage.setItem(
                  key,
                  JSON.stringify({ agents: { main: { model: "openai/gpt-5.5" } } }),
                );
              },
              `openclaw.new-session.preferences.v1:${gatewayOriginScope(controlUiBundledGatewayUrl(suite.server.baseUrl))}`,
            );
          }
          const gateway = await installMockGateway(page, {
            heldMethods: [method],
            agentModel: "openai/gpt-5.5",
          });
          await page.goto(`${suite.server.baseUrl}new?agent=main`);
          const composer = page.locator(".new-session-page__message");
          const message = "Send this once the agent is ready";
          if (method === "models.list") {
            await composer.waitFor({ state: "visible" });
            await page.evaluate((text) => navigator.clipboard.writeText(text), message);
            await composer.focus();
            await page.keyboard.press("ControlOrMeta+V");
          } else {
            await composer.fill(message);
          }
          expect(await composer.inputValue()).toBe(message);
          const start = page.getByRole("button", { name: "Start session", exact: true });
          const notice = page.locator(".new-session-page__blocked-submit");
          await captureUiProof(suite, page, `${method}-rendered.png`);
          const unavailable = {
            disabled: await start.isDisabled(),
            notice: (await notice.allTextContents()).join(""),
          };
          await composer.press("Enter");
          await captureUiProof(suite, page, `${method}-blocked.png`);
          await start.click({ force: true });
          expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
          expect(await composer.inputValue()).toBe(message);

          await gateway.resolveDeferred(method);
          await page.locator(".new-session-page__start-submit:not(:disabled)").waitFor();
          expect(await notice.count()).toBe(0);
          expect(await composer.inputValue()).toBe(message);
          expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
          expect(unavailable.disabled).toBe(true);
          expect(unavailable.notice).toContain(
            method === "agents.list"
              ? "Refreshing agent defaults"
              : "Restoring your last session setup",
          );
          await composer.press("Enter");
          await waitForCommittedChatRoute(page);
          const creates = await gateway.getRequests("sessions.create");
          expect(creates).toHaveLength(1);
          expect(creates[0]?.params).toMatchObject({ agentId: "main", message });
          await captureUiProof(suite, page, `${method}-sent.png`);
        },
      );
    },
  );
});
