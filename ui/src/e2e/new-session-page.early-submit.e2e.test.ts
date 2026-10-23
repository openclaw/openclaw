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
  it.each([
    { method: "agents.list", attempt: "Enter", width: 1280 },
    { method: "agents.list", attempt: "Enter", width: 390 },
    { method: "models.list", attempt: "paste+Enter", width: 1280 },
    { method: "agents.list", attempt: "Start", width: 1280 },
  ])(
    "explains $attempt only after attempting submission while $method is pending at $width px",
    async ({ method, attempt, width }) => {
      await suite.withPage(
        {
          viewport: { width, height: 800 },
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
          const frame = page.locator(".new-session-page__composer");
          const bounds = await frame.boundingBox();
          const stableBounds =
            width === 390 ? { x: bounds?.x, width: bounds?.width, height: bounds?.height } : bounds;
          expect(await start.isDisabled()).toBe(true);
          expect(await notice.count()).toBe(0);
          await captureUiProof(suite, page, `${method}-${attempt}-${width}-rendered.png`);
          if (attempt === "Start") {
            await start.click({ force: true });
          } else {
            await composer.press("Enter");
          }
          await notice.waitFor({ state: "visible" });
          expect(await notice.textContent()).toContain(
            method === "agents.list"
              ? "Refreshing agent defaults"
              : "Restoring your last session setup",
          );
          expect(await frame.locator(".new-session-page__blocked-submit").count()).toBe(0);
          expect(await frame.boundingBox()).toMatchObject(stableBounds!);
          await captureUiProof(suite, page, `${method}-${attempt}-${width}-blocked.png`);
          expect(await notice.boundingBox()).toMatchObject({ x: bounds?.x, width: bounds?.width });
          expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
          expect(await composer.inputValue()).toBe(message);

          await gateway.resolveDeferred(method);
          await page.locator(".new-session-page__start-submit:not(:disabled)").waitFor();
          expect(await notice.count()).toBe(0);
          expect(await composer.inputValue()).toBe(message);
          expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
          expect(await frame.boundingBox()).toMatchObject(stableBounds!);
          await composer.press("Enter");
          await waitForCommittedChatRoute(page);
          const creates = await gateway.getRequests("sessions.create");
          expect(creates).toHaveLength(1);
          expect(creates[0]?.params).toMatchObject({ agentId: "main", message });
          await captureUiProof(suite, page, `${method}-${attempt}-${width}-sent.png`);
        },
      );
    },
  );

  it("keeps blocked palette readiness out of creation errors", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, { heldMethods: ["agents.list"] });
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      await page.locator(".new-session-page__message").waitFor({ state: "visible" });
      await page.keyboard.press("ControlOrMeta+K");
      const palette = page.locator("openclaw-command-palette");
      const input = palette.locator(".cmd-palette__input");
      await input.fill("Keep preparation out of errors");
      const start = palette.locator(".cmd-palette__create");
      expect(await start.isDisabled()).toBe(true);
      expect(await palette.locator(".cmd-palette__creation-error").count()).toBe(0);
      await input.press("ControlOrMeta+Enter");
      expect(await palette.locator(".cmd-palette__creation-error").count()).toBe(0);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      await gateway.resolveDeferred("agents.list");
      await palette.locator(".cmd-palette__create:not(:disabled)").waitFor();
      await start.click();
      await gateway.waitForRequest("sessions.create");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
    });
  });
});
