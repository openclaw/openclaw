import { expect, it } from "vitest";
import type { ToolsEffectiveResult } from "../api/types.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiTeamScaleFixture } from "../test-helpers/control-ui-team-scale-fixture.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI catalog request admission",
  trackBrowserContexts: true,
});

const model = (name: string) => ({ id: "gpt-5-mini", name, provider: "openai" });
const config = { agents: { entries: { main: { model: { primary: "openai/gpt-5-mini" } } } } };
const inventory = (name: string, source: "core" | "mcp" = "core"): ToolsEffectiveResult => ({
  agentId: "main",
  profile: "full",
  groups: [
    {
      id: source,
      label: source,
      source,
      tools: [
        {
          id: source === "core" ? "read" : "mcp_fixture_list",
          label: name,
          description: name,
          rawDescription: name,
          source,
        },
      ],
    },
  ],
});

async function client(path: string) {
  const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
  const page = await context.newPage();
  const fixture = createControlUiTeamScaleFixture({ baseUrl: suite.server.baseUrl });
  const gateway = await installMockGateway(page, {
    ...fixture.scenario,
    models: [model("Initial fixture model")],
    methodResponses: {
      ...fixture.scenario.methodResponses,
      "tools.effective": inventory("Initial fixture tool"),
      "config.get": {
        exists: true,
        valid: true,
        hash: "fixture-config",
        raw: JSON.stringify(config),
        sourceConfig: config,
        runtimeConfig: config,
        config,
      },
    },
  });
  for (const [pathname, asset] of fixture.assets) {
    await page.route(`**${pathname}`, (request) => request.fulfill({ status: 200, ...asset }));
  }
  await page.goto(new URL(path, suite.server.baseUrl).href);
  await waitForControlUiRoute(page, {
    routeId: path === "new" ? "new-session" : "agents",
  });
  return { page, gateway, fixture };
}

suite.define(() => {
  it.each(["new", "settings/agents/main/overview"])(
    "defers hidden catalog changes and catches up once at %s",
    async (path) => {
      const { page, gateway } = await client(path);
      const trigger =
        path === "new"
          ? page.locator('.new-session-page__composer [data-chat-model-select="true"]')
          : page.getByRole("button", { name: /^Primary model/ });
      await trigger.click();
      await page.getByRole("option", { name: /Initial fixture model/ }).waitFor();
      await page.keyboard.press("Escape");
      const before = (await gateway.getRequests("models.list")).length;
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await gateway.setMethodResponse("models.list", {
        models: [model("Updated fixture model")],
      });
      for (let index = 0; index < 60; index++) {
        await gateway.emitGatewayEvent("chat.metadata.changed", {
          modelCatalogChanged: true,
          authChanged: false,
          commandsChanged: false,
        });
      }
      expect(await gateway.getRequests("models.list")).toHaveLength(before);
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await gateway.waitForRequest("models.list", { after: before });
      await trigger.click();
      await page.getByRole("option", { name: /Updated fixture model/ }).waitFor();
      expect(await gateway.getRequests("models.list")).toHaveLength(before + 1);
      await gateway.setMethodResponse("models.list", {
        models: [model("Authenticated fixture model")],
      });
      await gateway.emitGatewayEvent("chat.metadata.changed", {
        modelCatalogChanged: true,
        authChanged: true,
        commandsChanged: false,
      });
      await page.getByRole("option", { name: /Authenticated fixture model/ }).waitFor();
      expect(await gateway.getRequests("models.list")).toHaveLength(before + 2);
    },
  );

  it("ignores unrelated session churn and reflects its own inventory changes", async () => {
    const { page, gateway, fixture } = await client("settings/agents/main/tools");
    await page
      .locator(".agent-tools-runtime-chip")
      .filter({ hasText: "Initial fixture tool" })
      .waitFor();
    await page.clock.install();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 5_000);
    const before = (await gateway.getRequests("tools.effective")).length;
    const row = fixture.scenario.sessions?.[1];
    if (!row) {
      throw new Error("Expected unrelated fixture session");
    }
    for (let index = 0; index < 60; index++) {
      const now = await page.evaluate(() => Date.now());
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: row.key,
        agentId: "main",
        reason: "patch",
        ts: now,
        session: {
          ...row,
          updatedAt: now,
          snapshotAt: now,
          toolOverrides: { webSearch: index % 2 === 0 },
        },
      });
      await page.clock.fastForward(1_000);
    }
    await page.clock.fastForward(5_000);
    expect(await gateway.getRequests("tools.effective")).toHaveLength(before);
    for (let index = 0; index < 60; index++) {
      await gateway.emitGatewayEvent("chat.metadata.changed", {
        agentId: "main",
        modelCatalogChanged: true,
        authChanged: false,
        commandsChanged: false,
      });
      await page.clock.fastForward(1_000);
    }
    expect(await gateway.getRequests("tools.effective")).toHaveLength(before);
    await gateway.setMethodResponse("tools.effective", inventory("Updated catalog fixture tool"));
    await gateway.emitGatewayEvent("chat.metadata.changed", {
      agentId: "main",
      modelCatalogChanged: true,
      authChanged: true,
      commandsChanged: false,
    });
    await page.clock.runFor(100);
    await page
      .locator(".agent-tools-runtime-chip")
      .filter({ hasText: "Updated catalog fixture tool" })
      .waitFor();
    expect(await gateway.getRequests("tools.effective")).toHaveLength(before + 1);
    await gateway.setMethodResponse(
      "tools.effective",
      inventory("Discovered fixture MCP tool", "mcp"),
    );
    await gateway.emitGatewayEvent("sessions.changed", {
      sessionKey: "agent:main:main",
      agentId: "main",
      reason: "patch",
      session: { key: "agent:main:main", agentId: "main", toolOverrides: { webSearch: false } },
    });
    await page.clock.runFor(100);
    await page
      .locator(".agent-tools-runtime-chip")
      .filter({ hasText: "Discovered fixture MCP tool" })
      .waitFor();
    expect(await gateway.getRequests("tools.effective")).toHaveLength(before + 2);
  });
});
