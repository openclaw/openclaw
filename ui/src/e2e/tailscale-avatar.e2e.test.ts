import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { agentRoster } from "./agent-roster.test-support.ts";
import { captureUiProof } from "./chat-flow.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Tailscale avatar identity",
  startServerBeforeBrowser: true,
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgmD8LAAHcATr29YW/AAAAAElFTkSuQmCC",
  "base64",
);
suite.define(() => {
  it("renders the agent image without first presenting the incompatible device token", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const requests: Array<string | undefined> = [];
      await page.route(/\/avatar\/main(?:\?.*)?$/, async (route) => {
        const authorization = route.request().headers().authorization;
        requests.push(authorization);
        await route.fulfill(
          authorization
            ? { status: 401, body: "Rejected device token" }
            : { status: 200, contentType: "image/png", body: png },
        );
      });
      await installMockGateway(page, {
        authMethod: "tailscale",
        deviceToken: "synthetic-issuerless-device",
        methodResponses: {
          "agent.identity.get": {
            agentId: "main",
            avatar: "/avatar/main",
            avatarStatus: "local",
            name: "Main agent",
          },
          "agents.list": agentRoster({ main: "OpenClaw" }, "main", "agent"),
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/agents`);
      const avatar = page.locator(
        ".settings-sidebar__agent .agent-select__trigger .agent-select__avatar",
      );
      await expect.poll(() => requests.length).toBeGreaterThan(0);
      await expect.poll(() => avatar.getAttribute("data-avatar-state")).not.toBe("pending");
      await captureUiProof(suite, page, "tailscale-avatar", "avatar.png");
      expect(requests).toEqual([undefined]);
      await expect
        .poll(() =>
          avatar
            .locator("img")
            .evaluateAll((images) =>
              images.some(
                (image) =>
                  image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
              ),
            ),
        )
        .toBe(true);
    });
  });
});
