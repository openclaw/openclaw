import fs from "node:fs/promises";
// Control UI E2E proves per-agent config writes use the canonical keyed shape.
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, reconnectMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { pickerValue, selectPickerValue } from "../test-helpers/select-picker-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent config save",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("agent-config-save");
  }
});

const requireRecord = createRequireRecord("record", "expected-object-value");

suite.define(() => {
  it("recovers failed loads and resumes autosave after reloading a reconnected draft", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        const config = { agents: { entries: { main: {} } } };
        const gateway = await installMockGateway(page, {
          assistantName: "Main agent",
          defaultAgentId: "main",
          agentModel: null,
          models: [
            { id: "reconnect-draft", name: "Reconnect draft", provider: "openai" },
            { id: "after-reload", name: "After reload", provider: "openai" },
          ],
          methodResponses: {
            "agents.list": {
              agents: [{ id: "main", name: "Main agent" }],
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
            },
            "config.get": {
              __mockError: {
                code: "INTERNAL_ERROR",
                message: "Agent configuration unavailable; retry Reload Config",
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
        const primary = agentsPage.locator(
          'openclaw-select-picker:has([role="listbox"][aria-label^="Primary model"])',
        );
        const decision = agentsPage.locator("openclaw-select-picker:has(#agent-decision-model)");
        const reload = agentsPage.getByRole("button", { name: "Reload Config" });
        await reload.waitFor();
        if (captureUiProof) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(
              proofDir,
              `agent-config-load-${process.env.OPENCLAW_UI_PROOF_LABEL ?? "failed"}.png`,
            ),
          });
        }

        const error = agentsPage
          .getByRole("alert")
          .filter({ hasText: "Agent configuration unavailable" });
        await expect.poll(() => error.isVisible()).toBe(true);
        await expect
          .poll(() => primary.locator(".picker-select__trigger").getAttribute("disabled"))
          .not.toBeNull();

        await gateway.setMethodResponse("config.get", {
          config,
          sourceConfig: config,
          runtimeConfig: config,
          hash: "recovered-agent-config",
          issues: [],
          raw: JSON.stringify(config),
          valid: true,
        });
        const readsBefore = (await gateway.getRequests("config.get")).length;
        await reload.click();
        await gateway.waitForRequest("config.get", { after: readsBefore });
        await expect.poll(() => error.count()).toBe(0);
        await expect
          .poll(() => primary.locator(".picker-select__trigger").getAttribute("disabled"))
          .toBeNull();

        expect(await pickerValue(decision)).toBe("__openclaw_inherit_decision__");
        const indicator = page.locator("openclaw-settings-save-indicator");
        const writesBeforeReconnect = (await gateway.getRequests("config.set")).length;
        await gateway.deferNext("config.set");
        await selectPickerValue(primary, "openai/reconnect-draft");
        const interrupted = await gateway.waitForRequest("config.set", {
          after: writesBeforeReconnect,
        });
        const interruptedParams = requireRecord(interrupted.params);
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
        await expect.poll(() => primary.locator(".picker-select__trigger").isEnabled()).toBe(true);
        await expect.poll(() => pickerValue(primary)).toBe("openai/reconnect-draft");
        await expect.poll(() => indicator.textContent()).toContain("Save failed");
        expect(await indicator.getByRole("status").getAttribute("aria-label")).toContain(
          "The last configuration change could not be confirmed",
        );
        expect(
          await indicator.getByRole("button", { name: "Retry", exact: true }).isEnabled(),
        ).toBe(true);
        expect(await gateway.getRequests("config.set")).toHaveLength(writesBeforeReconnect + 1);

        await gateway.setMethodResponse("config.get", {
          config,
          sourceConfig: config,
          runtimeConfig: config,
          hash: "reloaded-agent-config",
          issues: [],
          raw: JSON.stringify(config),
          valid: true,
        });
        const readsBeforeDiscard = (await gateway.getRequests("config.get")).length;
        await reload.click();
        await gateway.waitForRequest("config.get", { after: readsBeforeDiscard });
        await expect.poll(() => pickerValue(primary)).toBe("");
        await expect.poll(() => primary.locator(".picker-select__trigger").isEnabled()).toBe(true);
        await expect.poll(() => indicator.textContent()).not.toContain("Save failed");

        const writesBeforeFreshEdit = (await gateway.getRequests("config.set")).length;
        expect(writesBeforeFreshEdit).toBe(writesBeforeReconnect + 1);
        await gateway.deferNext("config.set");
        try {
          await selectPickerValue(primary, "openai/after-reload");
          const saved = await gateway.waitForRequest("config.set", {
            after: writesBeforeFreshEdit,
          });
          const params = requireRecord(saved.params);
          const savedConfig = {
            agents: { entries: { main: { model: "openai/after-reload" } } },
          };
          expect(params.baseHash).toBe("reloaded-agent-config");
          expect(JSON.parse(String(params.raw))).toEqual(savedConfig);
          expect(await gateway.getRequests("config.set")).toHaveLength(writesBeforeFreshEdit + 1);
          // The initial read-error fixture has no stateful config store; supply its acknowledgement.
          await gateway.resolveDeferred("config.set", {
            config: savedConfig,
            hash: "saved-agent-config",
          });
          await expect.poll(() => pickerValue(primary)).toBe("openai/after-reload");
          expect(await pickerValue(decision)).toBe("__openclaw_inherit_decision__");
          await expect.poll(() => indicator.textContent()).toContain("Saved");
        } finally {
          if (captureUiProof) {
            await page.screenshot({
              animations: "disabled",
              fullPage: true,
              path: path.join(
                proofDir,
                `agent-config-reload-autosave-${process.env.OPENCLAW_UI_PROOF_LABEL ?? "result"}.png`,
              ),
            });
          }
        }
      },
    );
  });

  it.each([
    {
      name: "profile allow",
      toolId: "read",
      groupId: "fs",
      groupLabel: "Files",
      description: "Read files",
      profileLabel: "Full",
      tools: { profile: "full" },
      expectedTools: { profile: "full", deny: ["read"] },
    },
    {
      name: "wildcard alsoAllow",
      toolId: "web_fetch",
      groupId: "web",
      groupLabel: "Web",
      description: "Fetch web content",
      profileLabel: "Minimal",
      tools: { profile: "minimal", alsoAllow: ["web_*"] },
      expectedTools: { profile: "minimal", alsoAllow: ["web_*"], deny: ["web_fetch"] },
    },
  ])("submits keyed entries and surfaces Gateway validation failures ($name)", async (scenario) => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const config = {
        agents: {
          entries: {
            main: {
              tools: scenario.tools,
            },
          },
        },
      };
      const gateway = await installMockGateway(page, {
        assistantName: "Main agent",
        defaultAgentId: "main",
        methodResponses: {
          "agents.list": {
            agents: [{ id: "main", name: "Main agent" }],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "config.get": {
            config,
            sourceConfig: config,
            runtimeConfig: config,
            hash: "agent-config-hash-1",
            issues: [],
            raw: JSON.stringify(config),
            valid: true,
          },
          "tools.catalog": {
            agentId: "main",
            profiles: [{ id: scenario.tools.profile, label: scenario.profileLabel }],
            groups: [
              {
                id: scenario.groupId,
                label: scenario.groupLabel,
                source: "core",
                tools: [
                  {
                    id: scenario.toolId,
                    label: scenario.toolId,
                    description: scenario.description,
                    source: "core",
                    defaultProfiles: ["full"],
                  },
                ],
              },
            ],
          },
          "tools.effective": {
            agentId: "main",
            profile: scenario.tools.profile,
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
        .filter({ hasText: scenario.groupLabel })
        .locator(".agent-tools-group__summary")
        .click();
      const toggle = page.locator(`#agent-tool-${scenario.toolId} wa-switch`);
      await expect
        .poll(() =>
          toggle.evaluate((element) => (element as HTMLElement & { checked: boolean }).checked),
        )
        .toBe(true);
      await gateway.deferNext("config.set");
      await toggle.click();

      const request = await gateway.waitForRequest("config.set");
      const params = requireRecord(request.params);
      const raw = requireRecord(JSON.parse(String(params.raw)));
      expect(raw).toEqual({
        agents: {
          entries: {
            main: {
              tools: scenario.expectedTools,
            },
          },
        },
      });
      expect(requireRecord(raw.agents)).not.toHaveProperty("list");
      expect(params.baseHash).toBe("agent-config-hash-1");

      await gateway.rejectDeferred("config.set", {
        code: "INVALID_REQUEST",
        message: "mock validation failure",
      });
      await page.getByRole("alert").filter({ hasText: "mock validation failure" }).waitFor();

      if (captureUiProof) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(proofDir, "01-save-error.png"),
        });
      }
    });
  });

  it("shows automatically discovered agent skills without name-list writes", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const config = { agents: { entries: { main: {} } } };
      const skill = (name: string, disabled = false) => ({
        name,
        description: name + " reusable workflow",
        source: "openclaw-workshop",
        bundled: false,
        filePath: "/synthetic/skills/" + name + "/SKILL.md",
        baseDir: "/synthetic/skills/" + name,
        skillKey: name,
        always: false,
        disabled,
        blockedByAllowlist: false,
        eligible: !disabled,
        modelVisible: !disabled,
        userInvocable: true,
        commandVisible: !disabled,
        requirements: { bins: [], anyBins: [], env: [], config: [], os: [] },
        missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
        configChecks: [],
        install: [],
      });
      const gateway = await installMockGateway(page, {
        assistantName: "Main agent",
        defaultAgentId: "main",
        methodResponses: {
          "agents.list": {
            agents: [{ id: "main", name: "Main agent" }],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "config.get": {
            config,
            sourceConfig: config,
            runtimeConfig: config,
            hash: "synthetic-hash",
            issues: [],
            raw: JSON.stringify(config),
            valid: true,
          },
          "skills.status": {
            agentId: "main",
            workspaceDir: "/synthetic/workspace",
            managedSkillsDir: "/synthetic/skills",
            skills: [
              skill("release-checks"),
              skill("new-workshop-skill"),
              skill("disabled-workflow", true),
            ],
          },
        },
      });
      const response = await page.goto(`${suite.server.baseUrl}settings/agents/main/skills`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("skills.status");
      await expect.poll(() => page.locator(".agent-skill-row").count()).toBe(3);
      expect(
        await page.locator(".agent-skill-row", { hasText: "new-workshop-skill" }).textContent(),
      ).toContain("eligible");
      expect(
        await page.locator(".agent-skill-row", { hasText: "disabled-workflow" }).textContent(),
      ).toContain("disabled");
      expect(await page.locator(".agent-skill-row wa-switch").count()).toBe(0);
      expect(await page.getByRole("button", { name: "Disable All", exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Reset", exact: true }).count()).toBe(0);
      await page
        .getByRole("tabpanel", { name: "Skills" })
        .getByRole("button", { name: "Refresh", exact: true })
        .click();
      expect(await gateway.getRequests("config.set")).toHaveLength(0);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      if (captureUiProof) {
        for (const group of await page.locator(".agent-skills-group").all()) {
          if ((await group.getAttribute("open")) === null) {
            await group.locator("summary").click();
          }
        }
        const row = page.locator(".agent-skill-row", { hasText: "new-workshop-skill" });
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator(".settings-workspace").last(),
          [row],
          { animations: "disabled", viewport: { width: 1280, height: 900 } },
        );
        await fs.writeFile(path.join(proofDir, "agent-skill-discovery.png"), frame.png);
      }
    });
  });
});
