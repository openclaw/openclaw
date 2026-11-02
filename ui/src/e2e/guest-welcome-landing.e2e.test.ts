import type { Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { GUEST_WELCOME_ENSURE_METHOD } from "../app/guest-welcome-handle.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { ownerRoster, sessionPerson } from "./session-ownership-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Guest welcome landing" });

const sam = sessionPerson("profile-sam", "Sam");
const josh = sessionPerson("profile-josh", "Josh");
const row = (id: string, label: string, owner: typeof sam, updatedAt: number) => ({
  key: `agent:main:${id}`,
  sessionId: id,
  kind: "direct" as const,
  label,
  owner: { actor: owner },
  updatedAt,
});
const welcome = row("welcome-sam", "Welcome, Sam", sam, 3);
const shared = row("guest-onboarding", "Guest onboarding flow", josh, 2);
const ready = (created: boolean) => ({
  status: "ready",
  sessionKey: welcome.key,
  agentId: "main",
  created,
});

function guestScenario(
  ensure: unknown,
  overrides: ControlUiMockGatewayScenario = {},
): ControlUiMockGatewayScenario {
  return {
    // The restricted role shape Visitor Access requires for invited guests.
    operatorScopes: ["operator.sessions.write"],
    operatorSessionCap: "view",
    presenceUsers: [{ self: true, id: sam.id, name: sam.label }],
    featureMethods: [...defaultControlUiFeatureMethods, GUEST_WELCOME_ENSURE_METHOD],
    sessionTranscripts: {
      [welcome.key]: {
        messages: [chatMessage("assistant", "Welcome to OpenClaw Team, Sam.", { timestamp: 1 })],
      },
      [shared.key]: {
        messages: [chatMessage("assistant", "Onboarding notes.", { timestamp: 1 })],
      },
    },
    methodResponses: {
      "sessions.list": {
        ...ownerRoster([welcome, shared], [sam, josh]),
        hasMore: false,
        nextOffset: null,
      },
      ...(ensure === undefined ? {} : { [GUEST_WELCOME_ENSURE_METHOD]: ensure }),
    },
    ...overrides,
  };
}

const onSession = (sessionId: string) => (url: URL) =>
  decodeURIComponent(url.pathname).includes(sessionId);
const visitedKeys = (page: Page) =>
  page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith("openclaw.guestWelcome.visited.v1:")),
  );

async function expectQuietLanding(
  page: Page,
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
) {
  await gateway.waitForRequest("sessions.list");
  await page.waitForTimeout(500);
  expect(await gateway.getRequests(GUEST_WELCOME_ENSURE_METHOD)).toHaveLength(0);
  await expectBrowser(page.locator(".chat-guest-welcome-status")).toHaveCount(0);
}

suite.define(() => {
  it("lands a guest from Home on the welcome session once, then leaves Home reachable", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      const gateway = await installMockGateway(
        page,
        // Any call after creation reports the existing session.
        guestScenario(ready(false)),
      );
      await page.goto(suite.server.baseUrl);
      await expectBrowser(page).toHaveURL(onSession(welcome.sessionId));
      await expectBrowser(page.getByText("Welcome to OpenClaw Team, Sam.")).toBeVisible();
      expect(await gateway.getRequests(GUEST_WELCOME_ENSURE_METHOD)).toHaveLength(1);
      expect((await gateway.waitForRequest(GUEST_WELCOME_ENSURE_METHOD)).params).toEqual({});
      expect(await visitedKeys(page)).toHaveLength(1);

      // Home stays Home on the next load: the welcome redirect happens once per browser.
      await page.goto(`${suite.server.baseUrl}chat/main`);
      // The reloaded page has a fresh mock Gateway; it is asked again and stays put.
      await gateway.waitForRequest(GUEST_WELCOME_ENSURE_METHOD);
      await page.waitForTimeout(500);
      await expectBrowser(page).toHaveURL((url) => url.pathname.endsWith("/chat/main"));
    });
  });

  it("never redirects away from a deep link", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, guestScenario(ready(true)));
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, shared.key));
      await gateway.waitForRequest(GUEST_WELCOME_ENSURE_METHOD);
      await expectBrowser(page.getByText("Onboarding notes.")).toBeVisible();
      await page.waitForTimeout(500);
      await expectBrowser(page).toHaveURL(onSession(shared.sessionId));
      expect(await visitedKeys(page)).toEqual([]);
    });
  });

  it("shows setup progress while pending, then lands on the ready session", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      const pending = { status: "pending", retryAfterMs: 600 };
      const gateway = await installMockGateway(
        page,
        guestScenario({ sequence: [pending, pending, pending, ready(true)] }),
      );
      await page.goto(suite.server.baseUrl);
      const status = page
        .getByRole("status")
        .filter({ hasText: "Setting up your welcome session…" });
      await expectBrowser(status).toBeVisible();
      await expectBrowser(status).toHaveAttribute("aria-live", "polite");
      await expectBrowser(page).toHaveURL(onSession(welcome.sessionId));
      await expectBrowser(page.locator(".chat-guest-welcome-status")).toHaveCount(0);
      expect(await gateway.getRequests(GUEST_WELCOME_ENSURE_METHOD)).toHaveLength(4);
    });
  });

  it("explains a failed setup without blocking the UI and tries again on request", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      const gateway = await installMockGateway(
        page,
        guestScenario({
          sequence: [
            { status: "failed", retryable: true, message: "Roboclaw is busy right now." },
            { __mockError: { code: "UNAVAILABLE", message: "Gateway restarting" } },
            ready(true),
          ],
        }),
      );
      await page.goto(suite.server.baseUrl);
      const failure = page
        .getByRole("alert")
        .filter({ hasText: "We couldn't set up your welcome session." });
      await expectBrowser(failure).toContainText("Roboclaw is busy right now.");
      // The rest of the UI stays usable while the failure is shown.
      await page.locator(`openclaw-app-sidebar [data-session-key="${shared.key}"]`).first().click();
      await expectBrowser(page.getByText("Onboarding notes.")).toBeVisible();
      await expectBrowser(failure).toBeVisible();

      await failure.getByRole("button", { name: "Try again" }).click();
      await expectBrowser(failure).not.toContainText("Roboclaw is busy right now.");
      await expectBrowser(failure).toBeVisible();
      await failure.getByRole("button", { name: "Try again" }).click();
      await expectBrowser(page.locator(".chat-guest-welcome-status")).toHaveCount(0);
      expect(await gateway.getRequests(GUEST_WELCOME_ENSURE_METHOD)).toHaveLength(3);
      // Retried from a deep link: setup finishes quietly without moving the guest.
      await expectBrowser(page).toHaveURL(onSession(shared.sessionId));
    });
  });

  it("changes nothing when the Gateway does not advertise the method", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      const gateway = await installMockGateway(
        page,
        guestScenario(ready(true), { featureMethods: [...defaultControlUiFeatureMethods] }),
      );
      await page.goto(suite.server.baseUrl);
      await expectQuietLanding(page, gateway);
      await expectBrowser(page).not.toHaveURL(onSession(welcome.sessionId));
    });
  });

  it("changes nothing for a signed-in team member", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      const gateway = await installMockGateway(
        page,
        guestScenario(ready(true), {
          operatorScopes: ["operator.read", "operator.write", "operator.admin"],
          operatorSessionCap: null,
        }),
      );
      await page.goto(suite.server.baseUrl);
      await expectQuietLanding(page, gateway);
      await expectBrowser(page).not.toHaveURL(onSession(welcome.sessionId));
    });
  });
});
