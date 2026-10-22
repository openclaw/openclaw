import type { Route } from "playwright";
import { expect, it } from "vitest";
import type { AgentSelectElement } from "../components/agent-select.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { expectAttribute } from "./activity-assertions.test-support.ts";
import { captureUiProof } from "./chat-flow.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent picker avatar timeout",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it.each(["timeout", "loaded", "invalid image"] as const)(
    "keeps the avatar blank while pending, then handles %s without layout shifts",
    async (outcome) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        await page.clock.install();

        let avatarRequestCount = 0;
        let avatarAuthorization: string | undefined;
        let avatarRoute: Route | undefined;
        let failedAvatarRequests = 0;
        page.on("requestfailed", (request) => {
          if (new URL(request.url()).pathname === "/avatar/main") {
            failedAvatarRequests++;
          }
        });
        await page.route(/\/avatar\/main$/, (route) => {
          avatarRequestCount += 1;
          avatarAuthorization = route.request().headers().authorization;
          avatarRoute = route;
        });
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "agent.identity.get": {
              cases: [
                {
                  agentId: "main",
                  avatar: "/avatar/main",
                  avatarStatus: "local",
                  name: "Main agent",
                },
                { agentId: "writer", avatar: "", avatarStatus: "none", name: "Writer" },
              ].map((response) => ({ match: { agentId: response.agentId }, response })),
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
        const picker = page.locator(".settings-sidebar__agent openclaw-agent-select");
        const avatar = picker.locator(".agent-select__trigger .agent-select__avatar");
        const fallback = avatar.locator(".identity-avatar__fallback");
        const avatarState = async () => ({
          state: await avatar.getAttribute("data-avatar-state"),
          fallback: await fallback.isVisible(),
          image: await avatar.locator("img").isVisible(),
          face: await avatar.locator(".identity-avatar__agent-face").isVisible(),
        });
        const settledState =
          outcome === "loaded" ? { state: "loaded", image: true, fallback: false } : { face: true };
        await expectAttribute(avatar, "data-avatar-state").toBe("pending");
        await expect.poll(() => fallback.isVisible()).toBe(false);
        const pendingBox = await avatar.boundingBox();
        expect(pendingBox?.width).toBeGreaterThan(0);
        const { width, height } = pendingBox!;
        expect(avatarAuthorization).toBe("Bearer e2e-device-token");
        await captureUiProof(suite, page, "avatar", "01-request-stalled.png");

        if (outcome === "timeout") {
          await page.clock.runFor(30_000);
          await expect.poll(() => failedAvatarRequests).toBe(1);
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
        await expect.poll(avatarState).toMatchObject(settledState);
        expect(await avatar.boundingBox()).toMatchObject({ width, height });

        // Updating the label rerenders the existing image without changing its source.
        await picker.evaluate(async (element: AgentSelectElement) => {
          element.accessibleLabel = "Choose agent";
          await element.updateComplete;
        });
        await expectAttribute(picker.locator(".agent-select__trigger"), "aria-label").toMatch(
          /^Choose agent:/,
        );
        await picker.locator(".agent-select__trigger").click();
        expect(await avatarState()).toMatchObject(settledState);
        expect(avatarRequestCount).toBe(1);
        await captureUiProof(suite, page, "avatar", `02-${outcome.replaceAll(" ", "-")}.png`);
      });
    },
  );
});
