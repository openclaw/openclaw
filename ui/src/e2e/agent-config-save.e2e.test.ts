// Control UI E2E proves per-agent config writes use the canonical keyed shape.
import { expect, it } from "vitest";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { sourceConfigSnapshot } from "../lib/config/config-snapshot.test-support.ts";
import { createSkill } from "../pages/skills/view.test-support.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  reconnectMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { pickerValue, selectPickerValue } from "../test-helpers/select-picker-e2e.ts";
import { agentRoster as createAgentRoster } from "./agent-roster.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { openMoreModelSettings } from "./model-providers.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent config save",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const requireRecord = createRequireRecord("record", "expected-object-value");
const agentRoster = createAgentRoster({ main: "Main agent" }, "main", "agent");
function configResponse(config: Record<string, unknown>, hash = "agent-config-hash-1") {
  return { ...sourceConfigSnapshot(config, hash), runtimeConfig: config };
}
async function saveParams(gateway: Awaited<ReturnType<typeof installMockGateway>>, after = 0) {
  return requireRecord((await gateway.waitForRequest("config.set", { after })).params);
}

suite.define(() => {
  it("recovers failed loads and resumes autosave after reloading a reconnected draft", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const config = { agents: { entries: { main: {} } } };
      const gateway = await installMockGateway(page, {
        assistantName: "Main agent",
        defaultAgentId: "main",
        agentModel: null,
        featureMethods: [
          ...defaultControlUiFeatureMethods,
          "agents.list",
          "config.get",
          "models.list",
        ],
        models: [
          { id: "reconnect-draft", name: "Reconnect draft", provider: "openai" },
          { id: "after-reload", name: "After reload", provider: "openai" },
        ],
        methodResponses: {
          "agents.list": agentRoster,
          "config.get": {
            __mockError: {
              code: "INTERNAL_ERROR",
              message: "Agent configuration unavailable",
              retryable: true,
            },
          },
        },
      });

      expect(
        (await page.goto(`${suite.server.baseUrl}settings/agents/main/overview`))?.status(),
      ).toBe(200);
      await gateway.waitForRequest("agents.list");
      await gateway.waitForRequest("config.get");
      const agentsPage = page.locator("openclaw-agents-page");
      const primary = agentsPage.locator("openclaw-select-picker:has(#agent-primary-model)");
      const decision = agentsPage.locator("openclaw-select-picker:has(#agent-decision-model)");
      const trigger = primary.locator(".picker-select__trigger");
      const error = agentsPage
        .getByRole("alert")
        .filter({ hasText: "Agent configuration unavailable" });
      await expect.poll(() => error.isVisible()).toBe(true);
      await expect.poll(() => trigger.getAttribute("disabled")).not.toBeNull();

      // A failed read offers its own Retry; the panel has no Reload to fall back on.
      await gateway.setMethodResponse(
        "config.get",
        configResponse(config, "recovered-agent-config"),
      );
      const readsBeforeRetry = (await gateway.getRequests("config.get")).length;
      await error.getByRole("button", { name: "Retry" }).click();
      await gateway.waitForRequest("config.get", { after: readsBeforeRetry });
      await expect.poll(() => error.count()).toBe(0);
      await expect.poll(() => trigger.getAttribute("disabled")).toBeNull();

      await openMoreModelSettings(agentsPage);
      expect(await pickerValue(decision)).toBe("__openclaw_inherit_decision__");
      const indicator = page.locator("openclaw-settings-save-indicator");
      const writesBeforeReconnect = (await gateway.getRequests("config.set")).length;
      await gateway.deferNext("config.set");
      await selectPickerValue(primary, "openai/reconnect-draft");
      const interruptedParams = await saveParams(gateway, writesBeforeReconnect);
      expect(interruptedParams.baseHash).toBe("recovered-agent-config");
      expect(JSON.parse(String(interruptedParams.raw))).toEqual({
        agents: { entries: { main: { model: "openai/reconnect-draft" } } },
      });

      // An unacknowledged save keeps the draft dirty without racing the debounce.
      const readsBeforeReconnect = (await gateway.getRequests("config.get")).length;
      await reconnectMockGateway(page, gateway);
      await gateway.rejectDeferred("config.set", {
        code: "UNAVAILABLE",
        message: "Interrupted settings save",
      });
      await gateway.waitForRequest("config.get", { after: readsBeforeReconnect });
      await expect.poll(() => trigger.isEnabled()).toBe(true);
      await expect.poll(() => pickerValue(primary)).toBe("openai/reconnect-draft");
      await expect
        .poll(() => indicator.textContent())
        .toContain("Couldn’t save settings. Try again.");
      expect(await indicator.getByRole("status").textContent()).toContain(
        "The last configuration change could not be confirmed",
      );
      expect(await indicator.getByRole("button", { name: "Retry", exact: true }).isEnabled()).toBe(
        true,
      );
      expect(await gateway.getRequests("config.set")).toHaveLength(writesBeforeReconnect + 1);

      // The kept draft retries as is, then edits resume saving on their own.
      await gateway.setMethodResponse(
        "config.get",
        configResponse(config, "reloaded-agent-config"),
      );
      const writesBeforeRetry = (await gateway.getRequests("config.set")).length;
      expect(writesBeforeRetry).toBe(writesBeforeReconnect + 1);
      await gateway.deferNext("config.set");
      await indicator.getByRole("button", { name: "Retry", exact: true }).click();
      const retried = await saveParams(gateway, writesBeforeRetry);
      // The initial read-error fixture has no stateful config store; supply its acknowledgement.
      await gateway.resolveDeferred("config.set", {
        config: JSON.parse(String(retried.raw)),
        hash: "retried-agent-config",
      });
      await expect
        .poll(() => indicator.textContent())
        .not.toContain("Couldn’t save settings. Try again.");

      const writesBeforeFreshEdit = (await gateway.getRequests("config.set")).length;
      await gateway.deferNext("config.set");
      await selectPickerValue(primary, "openai/after-reload");
      const params = await saveParams(gateway, writesBeforeFreshEdit);
      const savedConfig = {
        agents: { entries: { main: { model: "openai/after-reload" } } },
      };
      expect(JSON.parse(String(params.raw))).toEqual(savedConfig);
      expect(await gateway.getRequests("config.set")).toHaveLength(writesBeforeFreshEdit + 1);
      await gateway.resolveDeferred("config.set", {
        config: savedConfig,
        hash: "saved-agent-config",
      });
      await expect.poll(() => pickerValue(primary)).toBe("openai/after-reload");
      await openMoreModelSettings(agentsPage);
      expect(await pickerValue(decision)).toBe("__openclaw_inherit_decision__");
      await expect.poll(() => indicator.textContent()).toContain("Apply changes");
    });
  });

  it.each([["profile allow", "read", "fs", "Files", { profile: "full" }]] as const)(
    "submits keyed entries and surfaces Gateway validation failures (%s)",
    async (_name, toolId, groupId, groupLabel, tools) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const config = { agents: { entries: { main: { tools } } } };
        const gateway = await installMockGateway(page, {
          assistantName: "Main agent",
          defaultAgentId: "main",
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "agents.list",
            "config.get",
            "tools.catalog",
            "tools.effective",
          ],
          methodResponses: {
            "agents.list": agentRoster,
            "config.get": configResponse(config),
            "tools.catalog": {
              agentId: "main",
              profiles: [{ id: tools.profile, label: tools.profile }],
              groups: [
                {
                  id: groupId,
                  label: groupLabel,
                  source: "core",
                  tools: [
                    {
                      id: toolId,
                      label: toolId,
                      source: "core",
                      defaultProfiles: ["full"],
                    },
                  ],
                },
              ],
            },
            "tools.effective": {
              agentId: "main",
              profile: tools.profile,
              groups: [],
              notices: [],
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/agents/main/tools`);
        expect(response?.status()).toBe(200);
        await gateway.waitForRequest("agents.list");
        await gateway.waitForRequest("config.get");
        await gateway.waitForRequest("tools.catalog");

        await page
          .locator(".agent-tools-group")
          .filter({ hasText: groupLabel })
          .locator(".agent-tools-group__summary")
          .click();
        const toggle = page.locator(`#agent-tool-${toolId}`).getByRole("switch");
        await expect.poll(() => toggle.isChecked()).toBe(true);
        await gateway.deferNext("config.set");
        await toggle.click();

        const params = await saveParams(gateway);
        const raw = requireRecord(JSON.parse(String(params.raw)));
        expect(raw).toEqual({
          agents: { entries: { main: { tools: { ...tools, deny: [toolId] } } } },
        });
        expect(params.baseHash).toBe("agent-config-hash-1");

        await gateway.rejectDeferred("config.set", {
          code: "INVALID_REQUEST",
          message: "mock validation failure",
        });
        await expect
          .poll(() => page.locator(".settings-save-status").textContent())
          .toContain("mock validation failure");
      });
    },
  );

  it.each(["switch", "phone name"])("edits inherited skills via %s", async (target) => {
    const options = createControlUiE2eContextOptions();
    const context =
      target === "switch"
        ? options
        : { ...options, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
    await suite.withPage(context, async ({ page }) => {
      const name =
        target === "phone name"
          ? "internationalcoastalsurveyobservationsandfieldworkhandoff"
          : "github";
      const config = { agents: { defaults: { skills: [name] }, entries: { main: {} } } };
      const skill = (skillName: string, blockedByAgentFilter: boolean) =>
        createSkill({
          name: skillName,
          description: `${skillName} skill`,
          source: "openclaw-managed",
          skillKey: skillName,
          blockedByAgentFilter,
        });
      const gateway = await installMockGateway(page, {
        featureMethods: [
          ...defaultControlUiFeatureMethods,
          "agents.list",
          "config.get",
          "skills.status",
        ],
        assistantName: "Main agent",
        defaultAgentId: "main",
        methodResponses: {
          "agents.list": agentRoster,
          "config.get": configResponse(config),
          "skills.status": {
            agentId: "main",
            agentSkillFilter: [name],
            workspaceDir: "/tmp/workspace",
            managedSkillsDir: "/tmp/skills",
            skills: [skill(name, false), skill("weather", true)],
          },
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}settings/agents/main/skills`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("config.get");
      await gateway.waitForRequest("skills.status");

      await gateway.deferNext("config.set");
      const row = page.locator(".agent-skill-row", { hasText: `${name} skill` });
      const toggle = row.getByRole("switch", { name, exact: true });
      if (target === "phone name") {
        const title = row.locator(".settings-row__title");
        await title.scrollIntoViewIfNeeded();
        const [text, control] = await Promise.all([title.boundingBox(), toggle.boundingBox()]);
        if (!text || !control) {
          throw new Error("Expected the skill name and switch to be visible");
        }
        expect(control.x).toBeGreaterThanOrEqual(text.x + text.width);
        expect(control.x + control.width).toBeLessThanOrEqual(390);
        expect(Math.abs(control.y + control.height / 2 - text.y - text.height / 2)).toBeLessThan(1);
        expect(await title.getAttribute("title")).toBe(name);
        const line = await title.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).lineHeight),
        );
        expect(Math.abs(text.height - line)).toBeLessThan(1);
        expect(await title.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
          true,
        );
        await title.tap();
      } else {
        await toggle.click();
      }

      const params = await saveParams(gateway);
      expect(JSON.parse(String(params.raw))).toEqual({
        agents: { defaults: { skills: [name] }, entries: { main: { skills: [] } } },
      });
      expect(params.baseHash).toBe("agent-config-hash-1");
      await gateway.resolveDeferred("config.set", {
        config: JSON.parse(String(params.raw)),
        hash: "agent-config-hash-2",
      });
    });
  });
});
