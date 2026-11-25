import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { openDesktopPanel, sessionsList } from "./desktop-panel.test-support.ts";
import { installDesktopClientFake } from "./desktop-rfb-test-support.ts";

const suite = createControlUiE2eSuite({
  name: "desktop account credentials",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("retries host observe with ARD credentials without passing them to noVNC", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["desktop.observe", "environments.list"],
        methodResponses: {
          "sessions.list": sessionsList("local"),
          "environments.list": {
            environments: [{ id: "gateway", type: "local", status: "available", desktop: true }],
          },
          "desktop.observe": {
            sequence: [
              {
                __mockError: {
                  code: "INVALID_REQUEST",
                  message: "macOS account credentials are required to observe Screen Sharing",
                  details: {
                    code: "DESKTOP_CREDENTIALS_REQUIRED",
                    auth: "ard-account",
                  },
                },
              },
              {
                transport: "rfb",
                wsPath: "/desktop/observe?token=ard-host",
                expiresAtMs: 60_000,
                control: false,
                auth: "ard-account",
              },
            ],
          },
        },
      });

      const panel = await openDesktopPanel(page, suite.server.baseUrl);
      await gateway.waitForRequest("environments.list");
      await installDesktopClientFake(panel);
      await panel.getByRole("button", { name: "Connect", exact: true }).click();
      await panel
        .getByText(
          "Enter a macOS account allowed in System Settings → General → Sharing. Remote Management also requires Observe/Control permissions.",
          { exact: true },
        )
        .waitFor();
      expect((await gateway.getRequests("desktop.observe"))[0]?.params).toEqual({
        source: { kind: "host" },
        control: false,
      });

      await panel.getByLabel("macOS username", { exact: true }).fill("operator");
      await panel
        .getByLabel("macOS password", { exact: true })
        .fill("memory-only-account-password");
      await panel.getByRole("button", { name: "Connect", exact: true }).click();
      await expect.poll(async () => await panel.getAttribute("data-connect-count")).toBe("1");
      expect(await panel.getAttribute("data-used-credentials")).toBe("false");
      const requests = await gateway.getRequests("desktop.observe");
      expect(requests).toHaveLength(2);
      expect(requests[1]?.params).toEqual({
        source: { kind: "host" },
        control: false,
        credentials: { username: "operator", password: "memory-only-account-password" },
      });
    });
  });
});
