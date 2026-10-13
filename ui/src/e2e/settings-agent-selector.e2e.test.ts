import type { Page } from "playwright";
import { expect, it } from "vitest";
import { pathForRoute } from "../app-route-paths.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI shared Settings agent selector" });

function installSettingsGateway(page: Page) {
  const config = {
    agents: {
      defaults: { model: { primary: "openai/gpt-4.1" } },
      entries: { main: {}, research: {} },
    },
  };
  return installMockGateway(page, {
    assistantAgentId: "main",
    assistantName: "Clawd",
    defaultAgentId: "main",
    sessionKey: "agent:main:main",
    agentModel: "openai/gpt-4.1",
    models: [{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }],
    methodResponses: {
      "agents.list": {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "Clawd", identity: { name: "Clawd", emoji: "🦞" } },
          { id: "research", name: "Research", identity: { name: "Research", emoji: "🔬" } },
        ],
      },
      "config.get": {
        config,
        sourceConfig: config,
        hash: "settings-agent-selector-config",
        valid: true,
        issues: [],
        raw: JSON.stringify(config),
      },
      "doctor.memory.status": {
        agentId: "research",
        provider: "none",
        embedding: { ok: false, checked: false },
      },
    },
  });
}

async function expectSelectedAgent(page: Page, name: string) {
  await expect
    .poll(async () =>
      (await page.locator("openclaw-agent-select .agent-select__label").textContent())?.trim(),
    )
    .toBe(name);
}

async function expectSidebarPickerOnly(page: Page) {
  expect(await page.locator(".settings-sidebar openclaw-agent-select").count()).toBe(1);
  expect(await page.locator(".content openclaw-agent-select").count()).toBe(0);
}

suite.define(() => {
  it.each([1440, 390])("closes only the agent menu on Escape at %ipx", async (width) => {
    await suite.withPage(
      { viewport: { width, height: 900 }, locale: "en-US", reducedMotion: "reduce" },
      async ({ page }) => {
        await installSettingsGateway(page);
        await page.goto(`${suite.server.baseUrl}settings/appearance`);
        await waitForControlUiRoute(page, { routeId: "appearance" });
        if (width === 390) {
          await page.locator(".topbar-nav-toggle").click();
        }
        const picker = page.locator(".settings-sidebar openclaw-agent-select");
        const trigger = picker.locator(".agent-select__trigger");
        await trigger.focus();
        await page.keyboard.press("Enter");
        await picker.getByRole("menuitemradio", { name: "Research", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
        expect(new URL(page.url()).pathname).toBe("/settings/appearance");
        expect(await trigger.isVisible()).toBe(true);
        expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
      },
    );
  });

  it("retains the Settings agent across pages and history without changing the chat agent", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        reducedMotion: "reduce",
        viewport: { width: 1440, height: 900 },
      },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const gateway = await installSettingsGateway(page);
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        await waitForControlUiRoute(page, { routeId: "model-providers" });
        await page.getByRole("heading", { name: "Defaults for all agents", exact: true }).waitFor();
        const primaryModel = page.locator(".model-providers__defaults .model-picker").first();
        await primaryModel.getByRole("button", { name: "Model: GPT-4.1", exact: true }).waitFor();

        // Begin with the sole visible picker so the pre-fix failure is the lost
        // selection on Agents, before checking the selector's new location.
        const picker = page.locator("openclaw-agent-select");
        await picker.locator(".agent-select__trigger").press("Enter");
        const selectedOption = picker.getByRole("menuitemradio", { name: /^Clawd(?:,|$)/ });
        await expect
          .poll(() => selectedOption.evaluate((element) => element.matches(":focus")))
          .toBe(true);
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await expectSelectedAgent(page, "Research");
        await gateway.waitForRequest("models.authStatus", { match: { agentId: "research" } });
        await primaryModel.getByRole("button", { name: "Model: GPT-4.1", exact: true }).waitFor();

        for (const routeId of ["memory", "skill-settings", "agents"] as const) {
          await page.locator(`.settings-sidebar__item[href="${pathForRoute(routeId)}"]`).click();
          await waitForControlUiRoute(page, { routeId });
          await expectSelectedAgent(page, "Research");
        }
        await gateway.waitForRequest("doctor.memory.status", { match: { agentId: "research" } });
        await gateway.waitForRequest("skills.status", { match: { agentId: "research" } });
        await gateway.waitForRequest("models.list", {
          match: { agentId: "research", view: "configured" },
        });
        await expect
          .poll(() => page.getByRole("button", { name: "Set Default", exact: true }).isEnabled())
          .toBe(true);
        await expectSidebarPickerOnly(page);

        const sidebarPicker = page.locator(".settings-sidebar openclaw-agent-select");
        await sidebarPicker.locator(".agent-select__trigger").click();
        await sidebarPicker.getByRole("menuitemradio", { name: /^Clawd(?:,|$)/ }).click();
        await waitForControlUiRoute(page, { routeId: "agents", pathname: "/settings/agents/main" });
        await expectSelectedAgent(page, "Clawd");
        await expect
          .poll(() => page.getByRole("button", { name: "Default", exact: true }).isDisabled())
          .toBe(true);
        await sidebarPicker.locator(".agent-select__trigger").click();
        await sidebarPicker.getByRole("menuitemradio", { name: "Research", exact: true }).click();
        await waitForControlUiRoute(page, {
          routeId: "agents",
          pathname: "/settings/agents/research",
        });
        await page.goBack();
        await waitForControlUiRoute(page, { routeId: "agents", pathname: "/settings/agents/main" });
        await expectSelectedAgent(page, "Clawd");
        await page.goForward();
        await waitForControlUiRoute(page, {
          routeId: "agents",
          pathname: "/settings/agents/research",
        });
        await expectSelectedAgent(page, "Research");

        for (const routeId of ["memory", "skill-settings", "model-providers"] as const) {
          await page.locator(`.settings-sidebar__item[href="${pathForRoute(routeId)}"]`).click();
          await waitForControlUiRoute(page, { routeId });
          await expectSelectedAgent(page, "Research");
          await expectSidebarPickerOnly(page);
        }
        await primaryModel.getByRole("button", { name: "Model: GPT-4.1", exact: true }).waitFor();
        await page.locator(".settings-sidebar__back").click();
        await waitForControlUiRoute(page, { routeId: "chat" });
        const startup = await gateway.waitForRequest("chat.startup");
        expect(startup.params).toMatchObject({ sessionKey: "agent:main:main" });
        await expect
          .poll(async () => (await page.locator(".sidebar-agent-card__name").textContent())?.trim())
          .toBe("Clawd");
        expect(pageErrors).toEqual([]);
      },
    );
  });

  it("changes the agent from the mobile Settings drawer and retains it on navigation", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        reducedMotion: "reduce",
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const gateway = await installSettingsGateway(page);
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        await waitForControlUiRoute(page, { routeId: "model-providers" });
        await page.locator(".topbar-nav-toggle").tap();
        const picker = page.locator(".settings-sidebar openclaw-agent-select");
        await picker.locator(".agent-select__trigger").tap();
        await picker.getByRole("menuitemradio", { name: "Research", exact: true }).tap();
        await expectSelectedAgent(page, "Research");
        await gateway.waitForRequest("models.authStatus", { match: { agentId: "research" } });
        await page.locator(`.settings-sidebar__item[href="${pathForRoute("memory")}"]`).tap();
        await waitForControlUiRoute(page, { routeId: "memory" });
        await gateway.waitForRequest("doctor.memory.status", { match: { agentId: "research" } });
        await page.locator(".topbar-nav-toggle").tap();
        await picker.locator(".agent-select__trigger").waitFor();
        await expectSelectedAgent(page, "Research");
        await expectSidebarPickerOnly(page);
        expect(pageErrors).toEqual([]);
      },
    );
  });
});
