import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI first-use Home panel mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const WORK_SESSION_KEY = "agent:main:work";
const SETUP_REPLY = "Your AI is ready. The web app works now.";
const savedDock = JSON.stringify({ open: true, dock: "right", width: 440, height: 420 });
const savedTarget = JSON.stringify({ destination: "home" });
const contextOptions = { colorScheme: "dark", ...createControlUiE2eContextOptions() } as const;

// An earlier visit left Home open; first use must not impose that saved choice.
async function rememberOpenHome(page: Page) {
  await page.addInitScript(
    ({ dock, target }) => {
      if (sessionStorage.getItem("e2e-home-preference")) {
        return;
      }
      sessionStorage.setItem("e2e-home-preference", "1");
      localStorage.setItem("openclaw.custodian.panel.v1", dock);
      localStorage.setItem(`openclaw.assistant.panel.target.v1:ws://${location.host}`, target);
    },
    { dock: savedDock, target: savedTarget },
  );
}

function installFirstUseGateway(page: Page) {
  return installMockGateway(page, {
    communityInvite: true,
    sessions: [{ key: WORK_SESSION_KEY, label: "Work", kind: "direct", updatedAt: 1 }],
    featureMethods: [
      "chat.metadata",
      "chat.startup",
      "chat.history",
      "chat.send",
      "openclaw.setup.detect",
      "openclaw.setup.activate.start",
      "wizard.next",
      "openclaw.chat",
    ],
    methodResponses: {
      "openclaw.setup.detect": {
        candidates: [
          {
            kind: "openai-api-key",
            brandId: "openai",
            label: "OpenAI API key",
            detail: "Saved credentials are available",
            modelRef: "openai/gpt-5",
            recommended: false,
            credentials: true,
          },
        ],
        manualProviders: [{ id: "openai", label: "OpenAI" }],
        workspace: "/tmp/openclaw-e2e",
        setupComplete: false,
      },
      "openclaw.setup.activate.start": {
        sessionId: "activation-session",
        done: false,
        status: "running",
      },
      "wizard.next": { done: true, status: "done", modelActivation: { modelRef: "openai/gpt-5" } },
      "openclaw.chat": { sessionId: "e2e-first-use", reply: SETUP_REPLY, action: "none" },
    },
  });
}

async function openSetup(page: Page) {
  await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
  const useModel = page
    .locator('[data-candidate-kind="openai-api-key"]')
    .getByRole("button", { name: "Test & use", exact: true });
  await useModel.waitFor();
  return useModel;
}

// Restoration runs on the shell's committed update; let it settle before asserting absence.
async function expectClosed(page: Page, dock: Locator) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  expect(await dock.isVisible()).toBe(false);
}

suite.define(() => {
  it.each(["web", "macOS"] as const)(
    "keeps Home closed from setup through the first chat (%s)",
    async (host) => {
      await suite.withPage(contextOptions, async ({ page }) => {
        if (host === "macOS") {
          await installNativeWebChrome(page);
        }
        await rememberOpenHome(page);
        const gateway = await installFirstUseGateway(page);
        const dock = page.locator("openclaw-assistant-panel .assistant-panel");

        const useModel = await openSetup(page);
        await expectClosed(page, dock);
        await useModel.click();
        await waitForControlUiRoute(page, {
          pathname: "/custodian",
          routeId: "custodian",
          search: "?onboarding=1",
        });
        const setupChat = page.locator("openclaw-custodian-page");
        await setupChat.getByText(SETUP_REPLY).first().waitFor();
        await expectClosed(page, dock);

        // A real setup turn makes leaving setup eligible to minimize Ask OpenClaw.
        await setupChat.locator("textarea").fill("Thanks");
        await setupChat.locator("textarea").press("Enter");
        await expect.poll(() => setupChat.getByText(SETUP_REPLY).count()).toBe(2);
        await setupChat.getByRole("button", { name: "Exit setup", exact: true }).click();
        await waitForControlUiRoute(page, { pathname: "/chat/main", routeId: "chat" });

        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor();
        await page.getByRole("button", { name: "Add attachment", exact: true }).waitFor();
        await expectClosed(page, dock);
        expect(await page.locator(".community-invite-card").count()).toBe(0);

        const send = page.getByRole("button", { name: "Send message", exact: true });
        await composer.fill("/help");
        await send.click();
        await page.getByText("Available commands", { exact: true }).waitFor();
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);

        await gateway.deferNext("chat.send");
        await composer.fill("Hello");
        await send.click();
        await gateway.waitForRequest("chat.send");
        await gateway.rejectDeferred("chat.send", {
          code: "INVALID_REQUEST",
          message: "Synthetic delivery rejection",
        });
        await page
          .locator('.chat-send-status[data-send-state="failed"]')
          .getByText("Not sent", { exact: true })
          .waitFor();
        await expectClosed(page, dock);
        expect(
          await page.evaluate(() => ({
            dock: localStorage.getItem("openclaw.custodian.panel.v1"),
            target: localStorage.getItem(
              `openclaw.assistant.panel.target.v1:ws://${location.host}`,
            ),
          })),
        ).toEqual({ dock: savedDock, target: savedTarget });

        // Reopening restores the established choice.
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, WORK_SESSION_KEY));
        await dock.getByRole("button", { name: "Home", exact: true }).waitFor();
        await expect.poll(() => dock.isVisible()).toBe(true);
      });
    },
  );

  it("opens Home from its shortcut during setup", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      await rememberOpenHome(page);
      await installFirstUseGateway(page);
      const dock = page.locator("openclaw-assistant-panel .assistant-panel");
      await openSetup(page);
      await expectClosed(page, dock);
      await page.keyboard.press("ControlOrMeta+Shift+KeyH");
      await expect.poll(() => dock.isVisible()).toBe(true);
      expect(
        await dock.getByRole("button", { name: "Home", exact: true }).getAttribute("aria-pressed"),
      ).toBe("true");
    });
  });
});
