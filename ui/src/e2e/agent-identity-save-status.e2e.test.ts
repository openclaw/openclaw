import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { captureUiProof } from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Agent identity save status" });
const config = { agents: { entries: { main: {} } } };
const snapshot = {
  config,
  sourceConfig: config,
  runtimeConfig: config,
  raw: JSON.stringify(config),
  hash: "identity-config",
  configRevisionHash: "identity-config",
  appliedConfigHash: "identity-config",
  issues: [],
  valid: true,
};

suite.define(() => {
  it("reports identity edits through the shared status and recovers a failure", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        assistantName: "Main agent",
        defaultAgentId: "main",
        featureMethods: [
          ...defaultControlUiFeatureMethods,
          "agents.list",
          "agents.update",
          "config.get",
          "agent.identity.get",
        ],
        methodResponses: {
          "agents.list": {
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
            agents: [{ id: "main", name: "Main" }],
          },
          "agents.update": { ok: true, agentId: "main" },
          "config.get": snapshot,
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/agents/main/overview`);
      const name = page.getByRole("textbox", { name: "Display name", exact: true });
      await name.waitFor();
      const status = page.locator(".settings-save-status openclaw-settings-save-indicator");
      const before = await name.boundingBox();

      await gateway.deferNext("agents.update");
      await name.fill("Garden guide");
      await name.blur();
      await gateway.waitForRequest("agents.update");
      await expect.poll(() => status.textContent()).toContain("Saving");
      expect(await page.locator('.agent-identity-editor [role="status"]').count()).toBe(0);
      await gateway.resolveDeferred("agents.update", { ok: true, agentId: "main" });
      await expect.poll(() => status.textContent()).toContain("Saved");
      expect(await name.boundingBox()).toEqual(before);

      const updates = (await gateway.getRequests("agents.update")).length;
      await gateway.deferNext("agents.update");
      await name.fill("Garden curator");
      await name.blur();
      await gateway.waitForRequest("agents.update", { after: updates });
      await gateway.rejectDeferred("agents.update", {
        code: "UNAVAILABLE",
        message: "Agent store is read-only",
      });
      await expect.poll(() => status.textContent()).toContain("Couldn’t save settings. Try again.");
      expect(await name.inputValue()).toBe("Garden curator");
      expect(await page.locator("#agent-panel [role=alert]").count()).toBe(0);
      expect(await name.boundingBox()).toEqual(before);

      await status.getByRole("button", { name: "Retry", exact: true }).click();
      const retried = await gateway.waitForRequest("agents.update", { after: updates + 1 });
      expect(retried.params).toEqual({ agentId: "main", name: "Garden curator" });
      await expect.poll(() => status.textContent()).toContain("Saved");
    });
  });
  it("keeps a deferred identity save waiting until the saved revision applies", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        assistantName: "Main agent",
        defaultAgentId: "main",
        featureMethods: [
          ...defaultControlUiFeatureMethods,
          "agents.list",
          "agents.update",
          "config.get",
          "agent.identity.get",
        ],
        methodResponses: {
          "agents.list": {
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
            agents: [{ id: "main", name: "Main" }],
          },
          "agents.update": { ok: true, agentId: "main" },
          "config.get": snapshot,
        },
      });
      await page.goto(suite.server.baseUrl + "settings/agents/main/overview");
      const name = page.getByRole("textbox", { name: "Display name", exact: true });
      await name.waitFor();
      const status = page.locator(".settings-save-status openclaw-settings-save-indicator");
      await gateway.deferNext("agents.update");
      await name.fill("Garden guide");
      await name.blur();
      await gateway.waitForRequest("agents.update");
      await gateway.setMethodResponse("config.get", {
        ...snapshot,
        hash: "saved",
        configRevisionHash: "saved",
      });
      await gateway.rejectDeferred("agents.update", {
        code: "UNAVAILABLE",
        message: "Agent configuration saved but deferred: plugin reload is waiting.",
        details: { application: { status: "deferred" } },
      });
      await expect.poll(() => status.textContent()).not.toContain("Saving");
      await captureUiProof(suite, page, "deferred-identity-save.png");
      await expect.poll(() => status.textContent()).toContain("Saved; waiting to apply");
      expect(await name.inputValue()).toBe("Garden guide");
      await gateway.setMethodResponse("config.get", {
        ...snapshot,
        hash: "applied",
        configRevisionHash: "applied",
        appliedConfigHash: "applied",
      });
      await expect
        .poll(() => status.textContent(), { timeout: 15000 })
        .not.toContain("waiting to apply");
    });
  });
});
