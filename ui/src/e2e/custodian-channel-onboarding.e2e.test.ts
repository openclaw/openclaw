// Control UI tests cover the first-run model-to-channel onboarding handoff.
import path from "node:path";
import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Custodian channel onboarding mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
let artifactDir: string;
beforeEach(() => {
  artifactDir = createControlUiE2eArtifactDir("custodian-channel-onboarding");
});

async function capture(page: Page, name: string, fullPage = false) {
  await page.screenshot({
    animations: "disabled",
    fullPage,
    path: path.join(artifactDir, `${name}.png`),
  });
}

const channelLabels = { whatsapp: "WhatsApp", telegram: "Telegram", discord: "Discord" };
const emptyChannelSnapshot = {
  ts: 1_700_000_000_000,
  channelOrder: Object.keys(channelLabels),
  channelLabels,
  channelMeta: Object.entries(channelLabels).map(([id, label]) => ({
    id,
    label,
    detailLabel: `${label} ${id === "whatsapp" ? "Web" : "Bot"}`,
  })),
  channels: Object.fromEntries(
    Object.keys(channelLabels).map((id) => [
      id,
      { configured: false, running: false, connected: false },
    ]),
  ),
  channelAccounts: { whatsapp: [], telegram: [], discord: [] },
  channelDefaultAccountId: {},
};

suite.define(() => {
  it("offers optional channels after model setup and opens the real Channels hub", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          deferredMethods: ["channels.status"],
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "channels.pairing.list",
            "channels.status",
            "openclaw.setup.detect",
            "openclaw.setup.activate.start",
            "wizard.next",
            "openclaw.chat",
          ],
          methodResponses: {
            "channels.pairing.list": {
              accounts: [],
              requests: [],
              commandOwnerConfigured: true,
              limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
            },
            "channels.status": emptyChannelSnapshot,
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
            "wizard.next": {
              done: true,
              status: "done",
              modelActivation: { modelRef: "openai/gpt-5" },
            },
            "openclaw.chat": {
              sessionId: "e2e-channel-onboarding",
              reply: "Your AI is ready. The web app works now.",
              action: "none",
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
        expect(response?.status()).toBe(200);
        const providerChoice = page
          .locator('[data-candidate-kind="openai-api-key"]')
          .getByRole("button", { name: "Test & use", exact: true });
        await providerChoice.waitFor();
        expect(await gateway.getRequests("openclaw.setup.activate.start")).toHaveLength(0);
        await providerChoice.click();
        await gateway.waitForRequest("openclaw.setup.activate.start");
        await waitForControlUiRoute(page, {
          pathname: "/custodian",
          routeId: "custodian",
          search: "?onboarding=1",
        });
        await capture(page, "01-after-explicit-model-setup");
        await gateway.waitForRequest("channels.status");
        await gateway.rejectDeferred("channels.status", {
          code: "UNAVAILABLE",
          message: "channel status temporarily unavailable",
          retryable: true,
        });
        const channelStatusError = page.getByRole("alert").filter({
          hasText: "Channel status is unavailable",
        });
        await channelStatusError.waitFor();
        await capture(page, "02-channel-status-error-before-retry");

        await gateway.setMethodResponse("channels.status", emptyChannelSnapshot);
        await channelStatusError.getByRole("button", { name: "Retry" }).click();
        const channelNudge = page.locator(".custodian__nudge--channel-onboarding");
        await channelNudge.waitFor();
        await expect.poll(() => channelNudge.textContent()).toContain("The web app already works");
        await capture(page, "02-after-custodian-channel-nudge");

        await page.setViewportSize({ height: 844, width: 390 });
        await expect
          .poll(() =>
            channelNudge.evaluate((nudge) => {
              const cta = nudge.querySelector<HTMLElement>(".custodian__nudge-cta");
              if (!cta) {
                return null;
              }
              const nudgeBox = nudge.getBoundingClientRect();
              const ctaBox = cta.getBoundingClientRect();
              return {
                ctaVisible: ctaBox.width > 0 && ctaBox.height > 0,
                mobileMediaQuery: window.matchMedia("(max-width: 640px)").matches,
                noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
                nudgeVisible: nudgeBox.width > 0 && nudgeBox.height > 0,
                nudgeWithinViewport: nudgeBox.left >= 0 && nudgeBox.right <= window.innerWidth,
                ctaWithinNudge: ctaBox.left >= nudgeBox.left && ctaBox.right <= nudgeBox.right,
                viewportWidth: window.innerWidth,
              };
            }),
          )
          .toEqual({
            ctaVisible: true,
            mobileMediaQuery: true,
            noHorizontalOverflow: true,
            nudgeVisible: true,
            nudgeWithinViewport: true,
            ctaWithinNudge: true,
            viewportWidth: 390,
          });
        await capture(page, "02b-after-custodian-channel-nudge-mobile");
        await page.setViewportSize({ height: 900, width: 1280 });

        const channelStatusRequests = await gateway.getRequests("channels.status");
        expect(channelStatusRequests).toHaveLength(2);
        expect(channelStatusRequests.map(({ params }) => params)).toEqual([
          expect.objectContaining({ probe: false }),
          expect.objectContaining({ probe: false }),
        ]);

        await page.getByRole("button", { name: "Set up a channel" }).click();
        await waitForControlUiRoute(page, {
          pathname: "/settings/channels",
          routeId: "channels",
          search: "",
        });
        await page.getByText("No channels connected yet. Pick one below to get started.").waitFor();
        await page.getByRole("heading", { name: "Add a channel" }).waitFor();
        expect(new URL(page.url()).searchParams.has("onboarding")).toBe(false);
        await capture(page, "03-after-channels-destination", true);

        await page.goBack();
        await waitForControlUiRoute(page, {
          pathname: "/custodian",
          routeId: "custodian",
          search: "?onboarding=1",
        });
        await expect
          .poll(() => page.locator(".custodian__nudge--channel-onboarding").count())
          .toBe(0);
      },
    );
  });
});
