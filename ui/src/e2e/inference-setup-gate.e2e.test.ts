import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  createNewSessionPageE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const pageOptions = {
  colorScheme: "dark",
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 900, width: 1440 },
} as const;
async function withSetupPage(
  run: (page: Page, gateway: Awaited<ReturnType<typeof installMockGateway>>) => Promise<void>,
  options: Parameters<typeof installMockGateway>[1] = { agentModel: null },
  width = 1440,
) {
  return suite.withPage({ ...pageOptions, viewport: { height: 900, width } }, async ({ page }) => {
    await run(page, await installMockGateway(page, options));
  });
}
async function expectSetupRoute(page: Page) {
  await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-providers");
  expect(new URL(page.url()).searchParams.get("connect")).toBe("1");
}

suite.define(() => {
  it("keeps help available on empty chat home while messages require a model", async () => {
    await withSetupPage(async (page, gateway) => {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByRole("heading", { name: "No AI provider configured" }).waitFor();

      await expect.poll(() => page.locator(".agent-chat__composer-shell").count()).toBe(1);
      const textarea = page.locator(".agent-chat__composer-combobox textarea");
      await expect.poll(() => textarea.isDisabled()).toBe(false);
      const welcome = page.locator(".agent-chat__welcome--setup");
      const setupAction = page.getByRole("button", { name: "Connect an AI provider", exact: true });
      await expect.poll(() => setupAction.count()).toBe(1);
      await setupAction.click();
      await expectSetupRoute(page);
      await page.goBack();
      const sendButton = page.getByRole("button", { name: "Send message", exact: true });
      await textarea.fill("/help");
      await expect.poll(() => sendButton.isDisabled()).toBe(false);
      await sendButton.click();
      await page.getByText("Available Commands", { exact: true }).waitFor();
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await expect.poll(() => welcome.count()).toBe(0);
      await expect.poll(() => setupAction.count()).toBe(1);
      await expect
        .poll(() =>
          page.locator(".agent-chat__composer-shell").evaluate((shell) => {
            const banner = shell.querySelector(".agent-chat__disabled-banner");
            const input = shell.querySelector(".agent-chat__input");
            if (!banner || !input) {
              throw new Error("expected setup notice above the composer");
            }
            return {
              stylesMatch: ["border-radius", "corner-shape"].every(
                (key) =>
                  getComputedStyle(banner).getPropertyValue(key) ===
                  getComputedStyle(input).getPropertyValue(key),
              ),
              edgesMatch: (["left", "right"] as const).every(
                (edge) =>
                  Math.abs(
                    banner.getBoundingClientRect()[edge] - input.getBoundingClientRect()[edge],
                  ) <= 1,
              ),
            };
          }),
        )
        .toEqual({ stylesMatch: true, edgesMatch: true });
      await setupAction.click();
      await expectSetupRoute(page);
      await page.goBack();
      await textarea.fill("Start a conversation.");
      await expect.poll(() => sendButton.isDisabled()).toBe(true);
      expect(await textarea.inputValue()).toBe("Start a conversation.");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it.each(["new", "custodian"])("blocks %s until a model is connected", async (surface) => {
    const custodian = surface === "custodian";
    await withSetupPage(
      async (page, gateway) => {
        await page.goto(`${suite.server.baseUrl}${custodian ? "custodian" : "new?agent=main"}`);
        await page.getByRole("heading", { name: "No AI provider configured" }).waitFor();
        const composer = custodian ? ".agent-chat__composer-shell" : ".new-session-page__composer";
        await expect.poll(() => page.locator(composer).count()).toBe(0);
        await expect.poll(() => page.locator("textarea").count()).toBe(0);
        if (custodian) {
          expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
          await expect.poll(() => page.locator(".custodian__error").count()).toBe(0);
          await expect
            .poll(async () => (await page.locator(".custodian__header").boundingBox())?.width ?? 0)
            .toBeGreaterThan(1_000);

          await page.setViewportSize({ height: 520, width: 900 });
          await expect
            .poll(() => page.getByRole("button", { name: "Connect an AI provider" }).isVisible())
            .toBe(true);
          await expect
            .poll(() =>
              page.evaluate(
                () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
              ),
            )
            .toBe(true);

          await page.setViewportSize({ height: 900, width: 1660 });
        }
        await page.getByRole("button", { name: "Connect an AI provider" }).click();
        await expectSetupRoute(page);
        if (custodian) {
          const modelsLink = page.locator(
            '.settings-sidebar__item[href="/settings/model-providers"]',
          );
          await expect.poll(() => modelsLink.getAttribute("aria-current")).toBe("page");
        }
      },
      {
        agentModel: null,
        ...(custodian
          ? { featureMethods: ["chat.metadata", "chat.startup", "openclaw.chat"] }
          : {}),
      },
      custodian ? 1660 : 1440,
    );
  });

  it.each(["page", "panel"])(
    "preserves %s history and the unsent draft while runtime inference recovers",
    async (surface) => {
      const runtimeError =
        "OpenClaw requires working inference: The configured runtime could not start. Repair the launcher and retry.";
      const runtimeOptions = {
        sessionKey: "agent:main:work",
        deferredMethods: ["openclaw.chat"],
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "chat.history",
          "chat.send",
          "openclaw.chat",
          "openclaw.chat.history",
        ],
        methodResponses: {
          "openclaw.chat.history": {
            turns: [
              {
                role: "assistant",
                text: "Your earlier conversation is still here.",
                at: 1_700_000_101_000,
              },
            ],
          },
        },
      };

      await withSetupPage(
        async (page, gateway) => {
          await page.goto(
            surface === "page"
              ? `${suite.server.baseUrl}custodian`
              : controlUiSessionUrl(suite.server.baseUrl, "agent:main:work"),
          );
          if (surface === "panel") {
            await page.locator(".sidebar-footer-bar__home").click();
            await page
              .locator("openclaw-assistant-panel")
              .getByRole("button", { name: "Ask OpenClaw", exact: true })
              .click();
          }
          const chat = page.locator("openclaw-custodian-surface");
          await gateway.waitForRequest("openclaw.chat");
          await gateway.rejectDeferred("openclaw.chat", {
            code: "UNAVAILABLE",
            details: { code: "system_agent_inference_unavailable" },
            message: runtimeError,
          });
          await chat.locator(".custodian__setup-state, .custodian__error").waitFor();
          await expect
            .poll(() => chat.locator(".custodian__error").textContent())
            .toContain(runtimeError);
          await chat.getByText("Your earlier conversation is still here.").waitFor();
          expect(await chat.getByRole("button", { name: "Review connection" }).count()).toBe(0);
          expect(await chat.locator(".agent-chat__composer-shell").count()).toBe(1);
          const composer = chat.getByRole("textbox");
          const send = chat.getByRole("button", { name: "Send", exact: true });
          const reply = async (text: string) => {
            await gateway.resolveDeferred("openclaw.chat", {
              sessionId: "runtime-recovered",
              reply: text,
              action: "none",
            });
            await chat.getByText(text).waitFor();
          };
          expect(await composer.isEnabled()).toBe(true);
          await composer.fill("Check my setup");
          expect(await send.isDisabled()).toBe(true);
          await composer.press("Enter");
          expect(await gateway.getRequests("openclaw.chat")).toHaveLength(1);
          expect(await composer.inputValue()).toBe("Check my setup");

          // Each deferral is consumed by one request, including the failed startup check.
          await gateway.deferNext("openclaw.chat");
          await chat.getByRole("button", { name: "Retry", exact: true }).click();
          const retry = await gateway.waitForRequest("openclaw.chat", { after: 1 });
          expect(retry.params).not.toHaveProperty("message");
          expect(await composer.isEnabled()).toBe(true);
          expect(await send.isDisabled()).toBe(true);
          await composer.press("Enter");
          expect(await gateway.getRequests("openclaw.chat")).toHaveLength(2);
          expect(await composer.inputValue()).toBe("Check my setup");
          await reply("Ready to help again.");
          await expect.poll(() => send.isEnabled()).toBe(true);
          expect(await composer.inputValue()).toBe("Check my setup");
          expect(await chat.locator(".custodian__error").count()).toBe(0);

          await gateway.deferNext("openclaw.chat", { message: "Check my setup" });
          await send.click();
          const turn = await gateway.waitForRequest("openclaw.chat", { after: 2 });
          expect(turn.params).toMatchObject({ message: "Check my setup" });
          await reply("Your setup is working.");
        },
        runtimeOptions,
        1660,
      );
    },
  );
});
