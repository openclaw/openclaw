import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "MCP resource search ownership" });
const server = (serverName: string, label: string) => ({
  serverName,
  label,
  entrypoints: [],
  mentionTool: "search",
});

suite.define(() => {
  it("retires results when discovery replaces their selected server", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const sessionKey = "agent:main:resource-ownership";
      const gateway = await installMockGateway(page, {
        sessionKey,
        featureMethods: ["mcp.app.discover", "mcp.app.mention"],
        methodResponses: {
          "mcp.app.discover": { servers: [server("parts", "Parts"), server("manuals", "Manuals")] },
          "mcp.app.mention": {
            resources: [
              { type: "resource_link", uri: "file:///parts/gear.txt", name: "Gear specification" },
            ],
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const picker = page.locator("openclaw-mcp-app-resources");
      await picker.getByRole("button", { name: "App resources", exact: true }).click();
      await picker.getByRole("searchbox").fill("gear");
      await picker.getByRole("button", { name: "Search app resources", exact: true }).click();
      await picker.getByRole("button", { name: "Gear specification" }).waitFor();
      expect((await gateway.getRequests("mcp.app.mention"))[0]?.params).toEqual({
        sessionKey,
        agentId: "main",
        serverName: "parts",
        query: "gear",
      });
      await gateway.setMethodResponse("mcp.app.discover", {
        servers: [server("manuals", "Manuals")],
      });
      await gateway.emitGatewayEvent("config.changed", {});
      await expect.poll(() => picker.getByRole("combobox").inputValue()).toBe("manuals");
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const dir = createControlUiE2eArtifactDir("mcp-resource-owner");
        const frame = await takeControlUiScreenshotFrame(
          page,
          picker,
          [picker.getByRole("searchbox")],
          { animations: "disabled" },
        );
        await fs.writeFile(path.join(dir, "server-replaced.png"), frame.png);
        console.log("Resource ownership proof: " + dir);
      }
      expect(await picker.getByRole("button", { name: "Gear specification" }).count()).toBe(0);
      expect(await picker.getByRole("searchbox").inputValue()).toBe("gear");
      await gateway.setMethodResponse("mcp.app.mention", {
        resources: [
          { type: "resource_link", uri: "file:///manuals/gear.txt", name: "Gear manual" },
        ],
      });
      await picker.getByRole("button", { name: "Search app resources", exact: true }).click();
      await picker.getByRole("button", { name: "Gear manual" }).waitFor();
      expect((await gateway.getRequests("mcp.app.mention")).at(-1)?.params).toEqual({
        sessionKey,
        agentId: "main",
        serverName: "manuals",
        query: "gear",
      });
    });
  });
});
