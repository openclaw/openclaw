import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureUiProof,
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it.each([false, true])(
    "reconciles warm agent defaults while preserving explicit folder=%s",
    async (explicit) => {
      await suite.withPage({ viewport: { width: 1280, height: 720 } }, async ({ page }) => {
        const roster = (workspace: string) => ({
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [
            { id: "main", workspace, workspaceGit: false, model: { primary: "openai/gpt-5.5" } },
          ],
        });
        const gateway = await installMockGateway(page, {
          heldMethods: ["connect", "agents.list"],
          authMethod: "token",
          authMode: "token",
          workspace: "/workspace-a",
          presenceUsers: [{ id: "warm-roster-profile", self: true }],
          methodResponses: { "agents.list": roster("/workspace-a") },
        });
        await page.goto(`${suite.server.baseUrl}chat?session=main#token=synthetic-test-token`);
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("agents.list");
        await gateway.resolveDeferred("agents.list");
        await expect
          .poll(() =>
            page.evaluate(() =>
              Object.keys(localStorage).some(
                (key) =>
                  key.startsWith("openclaw.control.bootRecord.v1:") &&
                  localStorage.getItem(key)?.includes("/workspace-a"),
              ),
            ),
          )
          .toBe(true);

        await page.goto(`${suite.server.baseUrl}new?agent=main`, { waitUntil: "commit" });
        const message = page.locator(".new-session-page__message");
        await message.fill("Keep the warm draft");
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("agents.list");
        if (explicit) {
          await page.locator("#new-session-project-trigger").click();
          await page.locator('.new-session-page__project-popover [data-value="workspace"]').click();
        }
        const start = page.getByRole("button", { name: "Start session", exact: true });
        if (!explicit) {
          await captureUiProof(suite, page, "warm-agent-defaults.png");
        }
        expect(await start.getAttribute("aria-disabled")).toBe("true");
        await start.click({ force: true });
        await message.press("Enter");
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);

        await gateway.resolveDeferred("agents.list", roster("/workspace-b"));
        await expect.poll(() => start.getAttribute("aria-disabled")).not.toBe("true");
        expect(await message.inputValue()).toBe("Keep the warm draft");
        await start.click();
        const create = await gateway.waitForRequest("sessions.create");
        expect(create.params).toMatchObject({ agentId: "main", message: "Keep the warm draft" });
        if (explicit) {
          expect(create.params).toHaveProperty("cwd", "/workspace-a");
        } else {
          expect(create.params).not.toHaveProperty("cwd");
        }
      });
    },
  );

  it("keeps a reloaded new-session page responsive before the Gateway reconnects", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        heldMethods: ["connect"],
        authMethod: "token",
        authMode: "token",
        presenceUsers: [{ id: "config-startup-profile", self: true }],
      });
      await page.goto(`${suite.server.baseUrl}chat?session=main#token=synthetic-test-token`);
      await gateway.waitForRequest("connect");
      await gateway.resolveDeferred("connect");
      await waitForControlUiGatewayReady(page);
      await page.locator(".agent-chat__composer-combobox textarea").waitFor({ state: "visible" });
      await expect
        .poll(() =>
          page.evaluate(() =>
            Object.keys(localStorage).some((key) =>
              key.startsWith("openclaw.control.bootRecord.v1:"),
            ),
          ),
        )
        .toBe(true);
      await page.goto(`${suite.server.baseUrl}new?agent=main`, { waitUntil: "commit" });

      const message = page.locator(".new-session-page__message");
      await message.fill("Keep this draft while connecting");
      expect(await message.inputValue()).toBe("Keep this draft while connecting");
      expect(await gateway.getRequests("config.get")).toHaveLength(0);

      await gateway.waitForRequest("connect");
      await gateway.resolveDeferred("connect");
      await waitForControlUiGatewayReady(page);
      await gateway.waitForRequest("config.get");
      expect(await message.inputValue()).toBe("Keep this draft while connecting");
    });
  });

  it("settles a failed config load and reflects the owner's reconnect result", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const config = {
        mcp: { servers: { github: { enabled: true, url: "https://mcp.example.test" } } },
      };
      const gateway = await installMockGateway(page, {
        heldMethods: ["config.get"],
        operatorScopes: ["operator.read", "operator.write", "operator.admin"],
        methodResponses: {
          "config.get": {
            raw: JSON.stringify(config),
            hash: "reconnected-config",
            sourceConfig: config,
            runtimeConfig: config,
            config,
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      await gateway.waitForRequest("config.get");
      expect(await gateway.getRequests("config.get")).toHaveLength(1);
      // Hold the next request so an accidental render-driven retry cannot hide behind success.
      await gateway.deferNext("config.get");
      await gateway.rejectDeferred("config.get", {
        code: "UNAVAILABLE",
        message: "Configuration unavailable; reconnect to retry.",
      });

      const composer = page.locator(".new-session-page__composer");
      const message = page.locator(".new-session-page__message");
      await message.fill("Keep this draft after the config error");
      await composer.getByRole("button", { name: "Add attachment" }).click();
      const menu = composer.locator("wa-dropdown.agent-chat__capability-menu");
      const search = menu.getByRole("menuitemcheckbox", { name: "Web search" });
      await expect.poll(() => search.isVisible()).toBe(true);
      expect(await gateway.getRequests("config.get")).toHaveLength(1);
      expect(await tooltipTitleText(search)).toContain(
        "Configuration unavailable; reconnect to retry.",
      );

      await page.keyboard.press("Escape");
      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      await gateway.setOnline(true);
      await waitForControlUiGatewayReady(page);
      await expect
        .poll(async () => (await gateway.getRequests("config.get")).length)
        .toBeGreaterThan(1);
      await gateway.resolveDeferred("config.get");
      await composer.getByRole("button", { name: "Add attachment" }).click();
      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await expect
        .poll(() => menu.getByRole("menuitemcheckbox", { name: /^github/ }).isEnabled())
        .toBe(true);
      expect(await message.inputValue()).toBe("Keep this draft after the config error");
      const recoveredReads = (await gateway.getRequests("config.get")).length;
      await page.keyboard.press("Escape");
      await message.fill("The recovered draft is still editable");
      await composer.getByRole("button", { name: "Add attachment" }).click();
      expect(await gateway.getRequests("config.get")).toHaveLength(recoveredReads);
    });
  });
});
