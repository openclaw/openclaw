import { expect, it } from "vitest";
import type { AgentSelectElement } from "../components/agent-select.tsx";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { expectAttribute } from "./activity-assertions.test-support.ts";
import { agentRoster } from "./agent-roster.test-support.ts";
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
  it("keeps a stalled avatar blank, then falls back without layout shifts or refetching", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await page.clock.install();

      let avatarRequestCount = 0;
      let avatarAuthorization: string | undefined;
      let failedAvatarRequests = 0;
      page.on("requestfailed", (request) => {
        if (new URL(request.url()).pathname === "/avatar/main") {
          failedAvatarRequests++;
        }
      });
      await page.route(/\/avatar\/main$/, (route) => {
        avatarRequestCount += 1;
        avatarAuthorization = route.request().headers().authorization;
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
          "agents.list": agentRoster({ main: "OpenClaw", writer: "Writer" }, "main", "agent"),
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}settings/agents`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("agent.identity.get");
      await expect.poll(() => avatarRequestCount).toBe(1);
      const picker = page.locator(".settings-sidebar__agent openclaw-agent-select");
      const avatar = picker.locator(".agent-select__trigger .agent-select__avatar");
      const fallback = avatar.locator(".identity-avatar__fallback");
      const face = avatar.locator(".identity-avatar__agent-face");
      await expectAttribute(avatar, "data-avatar-state").toBe("pending");
      await expect.poll(() => fallback.isVisible()).toBe(false);
      const pendingBox = await avatar.boundingBox();
      expect(pendingBox?.width).toBeGreaterThan(0);
      const { width, height } = pendingBox!;
      expect(avatarAuthorization).toBe("Bearer e2e-device-token");
      await captureUiProof(suite, page, "avatar", "01-request-stalled.png");

      await page.clock.runFor(30_000);
      await expect.poll(() => failedAvatarRequests).toBe(1);
      await expect.poll(() => face.isVisible()).toBe(true);
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
      expect(await face.isVisible()).toBe(true);
      expect(avatarRequestCount).toBe(1);
      await captureUiProof(suite, page, "avatar", "02-timeout.png");
    });
  });
});
