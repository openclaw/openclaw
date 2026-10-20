import type { BrowserContext, Page } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiInitialRoster } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

type NotificationProof = [type: string, event: string | null, userActivation: boolean];
type NotificationWindow = Window & { notificationProof: NotificationProof[] };

const suite = createControlUiE2eSuite({
  name: "Native notification loading",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});

async function checkNotifications(
  { context, page }: { context: BrowserContext; page: Page },
  native: boolean,
  route: "new" | "chat",
  background: boolean,
) {
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
      const postMessage = ({ type }: { type: string }) =>
        messages.push([type, window.event?.type ?? null, navigator.userActivation.isActive]);
      Object.assign(window, {
        notificationProof: messages,
        __OPENCLAW_NATIVE_NOTIFICATIONS__: { permission: "notDetermined" },
        webkit: { messageHandlers: { openclawNotifications: { postMessage } } },
      });
    });
  }
  const created = { key: "agent:main:notifications", initialRun: { status: "idle" } };
  const gateway = await installMockGateway(page, {
    // Observe gesture-free native startup before Playwright readiness evaluation.
    awaitInitialRoster: native ? false : undefined,
    methodResponses: { "sessions.create": created },
  });
  await page.goto(`${suite.server.baseUrl}${route}`);
  const composer = page.locator(
    route === "new"
      ? ".new-session-page__composer textarea"
      : ".agent-chat__composer-combobox textarea",
  );
  if (native) {
    // CDP observes startup without granting Playwright's user activation.
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
        .toContainEqual(["status", null, false]);
    } finally {
      await protocol.detach();
    }
    await waitForControlUiInitialRoster(page);
  }
  await composer.fill("Check notification startup.");
  expect(notificationModules).toHaveLength(native ? 1 : 0);
  const send = page.getByRole("button", {
    name: route === "new" ? "Start session" : "Send message",
    exact: true,
  });
  if (background) {
    await expect.poll(() => send.getAttribute("aria-disabled")).toBe("false");
    await composer.press("Control+Enter");
  } else {
    await send.click();
  }
  const request = await gateway.waitForRequest(route === "new" ? "sessions.create" : "chat.send");
  expect(request.params).toMatchObject({ message: "Check notification startup." });
  if (native) {
    expect(
      await page.evaluate(() => (window as NotificationWindow).notificationProof),
    ).toContainEqual(["request-permission", background ? "keydown" : "click", true]);
  }
  expect(notificationModules).toHaveLength(native ? 1 : 0);
  expect(errors).toEqual([]);
}

suite.define(() => {
  it.each([
    [false, "chat", false],
    [true, "chat", false],
    [true, "new", false],
    [true, "new", true],
  ] as const)(
    "preserves notification startup with native=%s route=%s background=%s",
    (native, route, background) =>
      suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1360, height: 1000 } },
        (fixture) => checkNotifications(fixture, native, route, background),
      ),
  );
});
