// Control UI tests cover bounded authenticated agent-picker avatar fetches.
import path from "node:path";
import type { Page, Route } from "playwright";
import { beforeEach, expect, it } from "vitest";
import type { AgentSelect } from "../components/agent-select.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent picker avatar timeout",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("agent-select-avatar-timeout");
  }
});

async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}

suite.define(() => {
  it.each(["timeout", "loaded", "invalid image"] as const)(
    "keeps the avatar blank while pending, then handles %s without layout shifts",
    async (outcome) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        await page.clock.install();

        let avatarRequestCount = 0;
        let avatarAuthorization: string | undefined;
        let avatarRoute: Route | undefined;
        const failedAvatarRequests: string[] = [];
        page.on("requestfailed", (request) => {
          if (new URL(request.url()).pathname === "/avatar/main") {
            failedAvatarRequests.push(request.failure()?.errorText ?? "unknown");
          }
        });
        await page.route(/\/avatar\/main$/, (route) => {
          avatarRequestCount += 1;
          avatarAuthorization = route.request().headers().authorization;
          avatarRoute = route;
          // Hold the response until the pending avatar has been inspected.
        });
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "agent.identity.get": {
              cases: [
                {
                  match: { agentId: "main" },
                  response: {
                    agentId: "main",
                    avatar: "/avatar/main",
                    avatarStatus: "local",
                    name: "Main agent",
                  },
                },
                {
                  match: { agentId: "writer" },
                  response: {
                    agentId: "writer",
                    avatar: "",
                    avatarStatus: "none",
                    name: "Writer",
                  },
                },
              ],
            },
            "agents.list": {
              agents: [
                { id: "main", name: "OpenClaw" },
                { id: "writer", name: "Writer" },
              ],
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/agents`);
        expect(response?.status()).toBe(200);
        await gateway.waitForRequest("agent.identity.get");
        await expect.poll(() => avatarRequestCount).toBe(1);
        const picker = page.locator("openclaw-agent-select");
        const avatar = picker.locator(".agent-select__trigger .agent-select__avatar");
        const fallback = avatar.locator(".identity-avatar__fallback");
        await expect.poll(() => avatar.getAttribute("data-avatar-state")).toBe("pending");
        await expect.poll(() => fallback.isVisible()).toBe(false);
        const pendingBox = await avatar.boundingBox();
        expect(pendingBox?.width).toBeGreaterThan(0);
        expect(avatarAuthorization).toBe("Bearer e2e-device-token");
        await screenshot(page, "01-request-stalled.png");

        if (outcome === "timeout") {
          await page.clock.runFor(30_000);
          await expect.poll(() => failedAvatarRequests.length).toBe(1);
        } else {
          if (!avatarRoute) {
            throw new Error("Avatar request was not intercepted");
          }
          await avatarRoute.fulfill({
            contentType: "image/svg+xml",
            body:
              outcome === "loaded"
                ? '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="16" fill="coral"/></svg>'
                : "not an image",
          });
        }
        if (outcome === "loaded") {
          await expect.poll(() => avatar.getAttribute("data-avatar-state")).toBe("loaded");
          expect(await avatar.locator("img").isVisible()).toBe(true);
          expect(await fallback.isVisible()).toBe(false);
        } else {
          await expect
            .poll(() => avatar.locator(".identity-avatar__agent-face").isVisible())
            .toBe(true);
        }
        const settledBox = await avatar.boundingBox();
        expect(settledBox?.width).toBe(pendingBox?.width);
        expect(settledBox?.height).toBe(pendingBox?.height);

        // Updating the label rerenders the existing image without changing its source.
        await picker.evaluate(async (element: AgentSelect) => {
          element.accessibleLabel = "Choose agent";
          await element.updateComplete;
        });
        await expect
          .poll(() => picker.locator(".agent-select__trigger").getAttribute("aria-label"))
          .toMatch(/^Choose agent:/);
        await picker.locator(".agent-select__trigger").click();
        if (outcome === "loaded") {
          expect(await avatar.getAttribute("data-avatar-state")).toBe("loaded");
          expect(await fallback.isVisible()).toBe(false);
        } else {
          expect(await avatar.locator(".identity-avatar__agent-face").isVisible()).toBe(true);
        }
        expect(avatarRequestCount).toBe(1);
        await screenshot(page, `02-${outcome.replaceAll(" ", "-")}.png`);
      });
    },
  );
});
