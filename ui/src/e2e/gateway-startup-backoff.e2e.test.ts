import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { openChatPublication } from "./chat-details.test-support.ts";
import {
  publicationMethods,
  publicationOptions,
  showPublicationBranch,
} from "./chat-github-publication.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Gateway startup request backoff" });
const methods = ["mentions.list", "sessions.github.options", "models.list", "tools.effective"];

suite.define(() => {
  it("bounds startup retries and loads chat data after admission opens", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const row = createControlUiSessionRow("agent:main:main", "Startup recovery", Date.now());
      const model = { id: "startup-model", name: "Recovered model", provider: "openai" };
      const config = { mcp: { servers: { fixture: { url: "https://mcp.example.test" } } } };
      const ready: Record<string, unknown> = {
        "mentions.list": {
          gatewayInstanceId: "e2e-gateway-boot",
          revision: 1,
          items: [
            {
              id: "startup-mention",
              senderProfileId: "reader",
              senderLabel: "Reader",
              sessionKey: row.key,
              agentId: "main",
              sessionTitle: "Recovered mention",
              messageId: "startup-message",
              createdAt: Date.now(),
              expiresAt: Date.now() + 60_000,
            },
          ],
        },
        "sessions.github.options": publicationOptions,
        "models.list": { models: [model] },
        "tools.effective": {
          agentId: "main",
          profile: "full",
          groups: [
            {
              id: "mcp",
              label: "MCP",
              source: "mcp",
              tools: [
                {
                  id: "mcp_fixture_recovered",
                  label: "Recovered tool",
                  description: "Available after startup",
                  source: "mcp",
                  mcpServer: "fixture",
                  mcpToolName: "recovered",
                },
              ],
            },
          ],
          notices: [],
        },
      };
      const gateway = await installMockGateway(page, {
        sessionKey: row.key,
        sessions: [row],
        presenceUsers: [{ self: true, id: "reader", identity: { type: "profile", id: "reader" } }],
        featureMethods: [...defaultControlUiFeatureMethods, ...publicationMethods, ...methods],
        methodResponses: {
          "config.get": {
            config,
            sourceConfig: config,
            runtimeConfig: config,
            raw: JSON.stringify(config),
            hash: "startup-fixture",
          },
          ...Object.fromEntries(
            methods.map((method) => [
              method,
              {
                __mockError: {
                  code: "UNAVAILABLE",
                  message: `${method} unavailable during gateway startup`,
                  retryable: true,
                  retryAfterMs: 500,
                  details: { reason: "startup-sidecars", method },
                },
              },
            ]),
          ),
        },
      });
      await page.clock.install();
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, row.key));
      await showPublicationBranch(gateway);
      await openChatPublication(page);
      const composer = page.locator(".agent-chat__input");
      await composer.getByRole("button", { name: "Add attachment" }).click();
      const menu = composer.locator(".agent-chat__capability-menu");
      await menu.getByRole("menuitem", { name: /^Plugins/ }).click();
      for (const method of methods) {
        await gateway.waitForRequest(method);
      }
      const initialCounts = await Promise.all(
        methods.map(async (method) => (await gateway.getRequests(method)).length),
      );

      // Run every timer, rather than fast-forwarding past intermediate retry attempts.
      await page.clock.runFor(13_000);
      for (const [index, method] of methods.entries()) {
        const count = (await gateway.getRequests(method)).length;
        expect(
          count - initialCounts[index]!,
          `${method} retries during 13s startup`,
        ).toBeLessThanOrEqual(5);
      }
      for (const method of methods) {
        await gateway.setMethodResponse(method, ready[method]);
      }
      await page.clock.runFor(8_000);
      await menu.locator('[data-value="server:fixture"]').click();
      await menu.getByText("Recovered tool", { exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await page.locator('[data-chat-model-select="true"]').click();
      await revealChatModelOption(page, "openai/startup-model");
      await page.keyboard.press("Escape");
      await openChatPublication(page);
      await page.getByRole("menuitemradio", { name: "@system-bot", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await page.locator(".sidebar-issues-button:visible").click();
      await page.locator('[data-mention-id="startup-mention"]').waitFor();
      const recoveredCounts = await Promise.all(
        methods.map(async (method) => (await gateway.getRequests(method)).length),
      );
      await page.clock.runFor(8_000);
      expect(
        await Promise.all(
          methods.map(async (method) => (await gateway.getRequests(method)).length),
        ),
      ).toEqual(recoveredCounts);
    });
  });
});
