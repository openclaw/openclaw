import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import type { ControlUiSessionFixture } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI Home context updates" });
const workKey = "agent:main:parser";
const homeKey = "agent:main:main";
function session(
  key: string,
  label: string,
  overrides: Partial<ControlUiSessionFixture> = {},
): ControlUiSessionFixture {
  return { key, label, kind: "direct", updatedAt: Date.now(), ...overrides };
}
const pageOptions = { viewport: { width: 1280, height: 900 } };

suite.define(() => {
  it.each(["workspace", "dashboard"] as const)(
    "keeps the Home conversation usable with a saved %s main panel",
    async (mainSlot) => {
      await suite.withPage(pageOptions, async ({ page }) => {
        const savedLayout = {
          columns: [
            {
              id: "side-panel-column",
              side: "right",
              panels: [mainSlot, "conversation"].map((slot) => ({ id: slot, slot })),
              activePanelId: "conversation",
              width: 480,
              height: 360,
            },
          ],
          mainPanelId: mainSlot,
          open: true,
        };
        const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
        await page.addInitScript(
          ({ key, settings }) => localStorage.setItem(key, JSON.stringify(settings)),
          {
            key: settingsKey,
            settings: {
              sessionKey: workKey,
              sidebarSessionLayouts: { [homeKey]: savedLayout },
            },
          },
        );
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "board.get"],
          sessionKey: workKey,
          sessions: [session(workKey, "Parser work"), session(homeKey, "Personal Home")],
          historyMessages: [{ role: "assistant", content: "Home is ready to help." }],
          methodResponses: {
            "board.get": {
              sessionKey: homeKey,
              revision: 1,
              tabs: [{ tabId: "main", title: "Main", position: 0 }],
              widgets: [],
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, workKey));
        await gateway.waitForRequest("chat.startup");
        await page.locator(".sidebar-footer-bar__home").click();
        const panel = page.locator("openclaw-assistant-panel");
        await panel.locator("openclaw-chat-pane").waitFor();
        await gateway.waitForRequest("chat.startup", { after: 1 });
        const composer = panel.locator(".agent-chat__composer-combobox textarea");
        await expect.poll(() => composer.isVisible()).toBe(true);
        await composer.fill("Help with the current work");
        await composer.press("Enter");
        expect((await gateway.waitForRequest("chat.send")).params).toMatchObject({
          sessionKey: homeKey,
        });
        const settings = await page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "{}"),
          settingsKey,
        );
        expect(settings.sidebarSessionLayouts[homeKey].mainPanelId).toBe(mainSlot);
      });
    },
  );

  it("refreshes reconnected Home context after a roster-only title update", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const work = session(workKey, "Parser work", {
        agentId: "main",
        sessionId: "parser-incarnation",
        spawnedWorkspaceDir: "/worktrees/parser",
      });
      const home = session(homeKey, "Personal Home", {
        agentId: "main",
        updatedAt: work.updatedAt,
      });
      const gateway = await installMockGateway(page, {
        sessionKey: work.key,
        sessions: [work, home],
        historyMessages: [
          { role: "assistant", content: [{ type: "text", text: "Parser workspace ready." }] },
        ],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, work.key));
      await page.locator(".sidebar-footer-bar__home").click();
      const panel = page.locator("openclaw-assistant-panel");
      const details = panel.locator(".assistant-panel-context details");
      await details.locator("summary").click();
      const reference = details.locator("pre");
      await expect.poll(() => reference.textContent()).toContain('"title":"Parser work"');

      await panel.evaluate(async (element) => {
        const parent = element.parentElement!;
        const next = element.nextSibling;
        element.remove();
        parent.insertBefore(element, next);
        await (element as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
      });

      const renamed = { ...work, label: "Renamed workspace", updatedAt: Date.now() + 1 };
      await gateway.setSessionsListResponse({
        ts: Date.now(),
        path: "",
        count: 2,
        defaults: { modelProvider: "openai", model: "gpt-5.6-luna", contextTokens: null },
        sessions: [renamed, home],
      });
      await gateway.emitGatewayEvent("sessions.changed", {
        ...renamed,
        sessionKey: work.key,
        reason: "patch",
      });
      const row = page.locator(`.sidebar-recent-session[data-session-key="${work.key}"]`);
      await expect.poll(() => row.textContent()).toContain(renamed.label);
      await expect.poll(() => reference.textContent()).toContain('"title":"Renamed workspace"');

      const composer = panel.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Review the current work");
      await composer.press("Enter");
      const sent = await gateway.waitForRequest("chat.send");
      expect(sent.params).toMatchObject({
        message: "Review the current work",
        workContext: { sessionKey: work.key, title: "Renamed workspace" },
      });
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
    });
  });
});
