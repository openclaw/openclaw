import path from "node:path";
import { expect, it } from "vitest";
import { waitForControlUiInitialRoster } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

type NotificationProof = {
  type: string;
  event: string | null;
  userActivation: boolean;
};

const suite = createControlUiE2eSuite({
  name: "Native notification loading",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});

suite.define(() => {
  it.each([
    { native: false, route: "chat", background: false },
    { native: true, route: "chat", background: false },
    { native: true, route: "new", background: false },
    { native: true, route: "new", background: true },
  ] as const)(
    "preserves notification startup with native=$native route=$route background=$background",
    async ({ native, route, background }) => {
      const viewport = { width: 1360, height: 1000 };
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport,
          recordVideo: { dir: suite.artifactDir, size: viewport },
        },
        async ({ context, page }) => {
          const notificationModules: string[] = [];
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("request", (request) => {
            if (new URL(request.url()).pathname.endsWith("/app/native-notifications.ts")) {
              notificationModules.push(request.url());
            }
          });
          if (native) {
            await page.addInitScript(() => {
              const messages: NotificationProof[] = [];
              Object.assign(window, {
                notificationProof: messages,
                __OPENCLAW_NATIVE_NOTIFICATIONS__: { permission: "notDetermined" },
                webkit: {
                  messageHandlers: {
                    openclawNotifications: {
                      postMessage(message: { type: string }) {
                        messages.push({
                          type: message.type,
                          event: window.event?.type ?? null,
                          userActivation: navigator.userActivation.isActive,
                        });
                      },
                    },
                  },
                },
              });
            });
          }
          const gateway = await installMockGateway(page, {
            // Observe gesture-free native startup before Playwright readiness evaluation.
            awaitInitialRoster: native ? false : undefined,
            historyMessages: [],
            methodResponses: {
              "sessions.create": {
                key: "agent:main:notification-onboarding",
                initialRun: { status: "idle" },
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}${route}`);
          const composer = page.locator(
            route === "new"
              ? ".new-session-page__composer textarea"
              : ".agent-chat__composer-combobox textarea",
          );
          if (native) {
            // A warm composer can render before native startup. Playwright evaluate
            // grants activation, so observe through CDP before any page interaction.
            const protocol = await context.newCDPSession(page);
            try {
              await expect
                .poll(async () => {
                  const { result } = await protocol.send("Runtime.evaluate", {
                    expression: "window.notificationProof",
                    returnByValue: true,
                    userGesture: false,
                  });
                  return result.value;
                })
                .toContainEqual({ type: "status", event: null, userActivation: false });
            } finally {
              await protocol.detach();
            }
            await waitForControlUiInitialRoster(page);
          }
          await composer.fill("Check notification startup.");
          expect(notificationModules).toHaveLength(native ? 1 : 0);
          await page.screenshot({ path: path.join(suite.artifactDir, "ready.png") });
          if (background) {
            await expect
              .poll(() =>
                page
                  .getByRole("button", { name: "Start session", exact: true })
                  .getAttribute("aria-disabled"),
              )
              .toBe("false");
            await composer.press("Control+Enter");
          } else {
            await page
              .getByRole("button", {
                name: route === "new" ? "Start session" : "Send message",
                exact: true,
              })
              .click();
          }
          const request = await gateway.waitForRequest(
            route === "new" ? "sessions.create" : "chat.send",
          );
          expect(request.params).toMatchObject({ message: "Check notification startup." });
          if (native) {
            const messages = await page.evaluate(
              () =>
                (window as typeof window & { notificationProof: NotificationProof[] })
                  .notificationProof,
            );
            expect(messages).toContainEqual({ type: "status", event: null, userActivation: false });
            expect(messages).toContainEqual({
              type: "request-permission",
              event: background ? "keydown" : "click",
              userActivation: true,
            });
          }
          expect(notificationModules).toHaveLength(native ? 1 : 0);
          expect(errors).toEqual([]);
          await page.screenshot({ path: path.join(suite.artifactDir, "sent.png") });
        },
      );
    },
  );
  it("retires notification presentation before a held native acknowledgement", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1360, height: 1000 } },
      async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.addInitScript(() => {
          Object.assign(window, {
            __OPENCLAW_NATIVE_NOTIFICATIONS__: { permission: "granted", test: null },
            webkit: { messageHandlers: { openclawNotifications: { postMessage() {} } } },
          });
        });
        await installMockGateway(page, { awaitInitialRoster: false });
        await page.goto(`${suite.server.baseUrl}settings/notifications`);
        const send = page.getByRole("button", { name: "Send test", exact: true });
        await send.click();
        const pending = page.getByRole("button", { name: "Sending test…", exact: true });
        await expect.poll(() => pending.isDisabled()).toBe(true);
        await page.locator('a[href="/settings/appearance"]').first().click();
        // The title can advance while Solid still retains the old body.
        const themes = page.locator(".settings-theme-card").first();
        await themes.waitFor();
        await expect.poll(() => pending.count()).toBe(0);
        await page.evaluate(() => {
          for (const test of [{ state: "pending" }, { state: "sent" }]) {
            window.dispatchEvent(
              new CustomEvent("openclaw:native-notifications-status", {
                detail: { permission: "granted", test },
              }),
            );
          }
        });
        await themes.waitFor();
        expect(await send.count()).toBe(0);
        await page.locator('a[href="/settings/notifications"]').first().click();
        await expect.poll(() => send.isEnabled()).toBe(true);
        await page.getByText("Test notification queued", { exact: true }).waitFor();
        expect(errors).toEqual([]);
      },
    );
  });
});
