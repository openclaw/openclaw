import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { objectSchema, pageRunner } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Settings config publication recovery" });
const withPage = pageRunner(suite, { viewport: { width: 1280, height: 900 } });
const config = {
  gateway: { mode: "local", auth: { mode: "token", token: "__OPENCLAW_REDACTED__" } },
  agents: { defaults: { workspace: "/workspace" } },
  plugins: { enabled: false },
  logging: { level: "info" },
  messages: { responsePrefix: "initial" },
};
const snapshot = {
  exists: true,
  valid: true,
  config,
  raw: JSON.stringify(config),
  hash: "initial",
};
const configPath = "/settings/openclaw.json";
const recoveryBackupPath = `${configPath}.bak`;
const missing = { ...snapshot, exists: false, config: {}, raw: null, hash: "missing" };

async function edit(prefix: Locator, value: string) {
  await prefix.fill(value);
  await prefix.press("Tab");
}

function publicationError(rollbackStatus: string) {
  return {
    code: "UNAVAILABLE",
    message: `Config publication failed after removing ${configPath}: included config changed since last load. Restoration: ${rollbackStatus}. Inspect recovery backups at ${recoveryBackupPath}.`,
    details: { publication: "partial", rollbackStatus, configPath, recoveryBackupPath },
  };
}

const scenario = {
  methodResponses: {
    "config.get": snapshot,
    "config.schema": {
      schema: objectSchema("", {
        messages: objectSchema("", {
          responsePrefix: { type: "string", title: "Outbound Response Prefix" },
        }),
      }),
      uiHints: { "messages.responsePrefix": { advanced: false } },
      version: "test",
    },
  },
};

suite.define(() => {
  it.each(["unknown", "not-restored", "restored"])(
    "Settings config.set preserves the full draft after partial publication (%s)",
    (rollbackStatus) =>
      withPage(async ({ page, context }) => {
        const restored = rollbackStatus === "restored";
        const finalDraft = restored ? "retained draft" : "saved after recovery";
        if (!restored) {
          await page.clock.install();
        }
        const gateway = await installMockGateway(page, scenario);
        await page.goto(`${suite.server.baseUrl}settings/communications`);
        const prefix = page.getByRole("textbox", { name: "Outbound Response Prefix" });
        await prefix.waitFor();
        await gateway.deferNext("config.set");
        await edit(prefix, "retained draft");
        await gateway.waitForRequest("config.set");
        await gateway.rejectDeferred("config.set", publicationError(rollbackStatus));
        const indicator = page.locator("openclaw-settings-save-indicator");
        await expect
          .poll(() => indicator.textContent())
          .toContain(restored ? "Save failed" : "Your draft is kept");
        expect(await indicator.getByRole("button", { name: "Reload", exact: true }).count()).toBe(
          0,
        );
        if (!restored) {
          const secondPage = await context.newPage();
          const secondGateway = await installMockGateway(secondPage, {
            ...scenario,
            deferredMethods: ["config.get"],
          });
          await secondPage.goto(`${suite.server.baseUrl}settings/communications`);
          await secondGateway.waitForRequest("config.get");
          await secondGateway.resolveDeferred("config.get", {
            ...missing,
            hash: snapshot.hash,
            writeError: publicationError(rollbackStatus),
          });
          await expect
            .poll(() => secondPage.locator("openclaw-settings-save-indicator").textContent())
            .toContain(recoveryBackupPath);
          const secondPrefix = secondPage.getByRole("textbox", {
            name: "Outbound Response Prefix",
          });
          await expect.poll(() => secondPrefix.isDisabled()).toBe(true);
          expect(await secondGateway.getRequests("config.set")).toHaveLength(0);
          await secondPage.close();
          await gateway.setMethodResponse("config.get", missing);
          await edit(prefix, "later draft");
          // Exceed the registered Settings autosave debounce before checking absence.
          await page.clock.runFor(1200);
          expect(await gateway.getRequests("config.set")).toHaveLength(1);
          expect(await prefix.inputValue()).toBe("later draft");
          expect(await indicator.textContent()).toContain(configPath);
          expect(await indicator.textContent()).toContain(recoveryBackupPath);
          const recover = indicator.getByRole("button", { name: "Discard draft and reload" });
          await recover.waitFor();
          await gateway.setOnline(false);
          await recover.click();
          await expect.poll(() => prefix.inputValue()).toBe("later draft");
          expect(await indicator.textContent()).toContain(recoveryBackupPath);
          expect(await gateway.getRequests("config.set")).toHaveLength(1);
          await gateway.setOnline(true);
          await page.waitForFunction(
            () => window.openclawControlUi?.snapshot().gatewayPhase === "connected",
          );
          for (const candidate of [
            missing,
            { ...snapshot, valid: false, raw: "{", hash: "invalid" },
          ]) {
            const reads = (await gateway.getRequests("config.get")).length;
            await gateway.deferNext("config.get");
            await recover.click();
            await gateway.waitForRequest("config.get", { after: reads });
            await gateway.resolveDeferred("config.get", candidate);
            await expect.poll(() => prefix.inputValue()).toBe("later draft");
            expect(await indicator.textContent()).toContain(recoveryBackupPath);
          }
          // A clean draft must retain a usable recovery action after file repair.
          await edit(prefix, "initial");
          await expect.poll(() => prefix.inputValue()).toBe("initial");
          await gateway.setMethodResponse("config.get", { ...snapshot, hash: "recovered" });
          await recover.click();
          await expect.poll(() => indicator.textContent()).not.toContain("Your draft is kept");
          await gateway.deferNext("config.set");
          await edit(prefix, finalDraft);
        } else {
          await gateway.deferNext("config.set");
          await indicator.getByRole("button", { name: "Retry" }).click();
        }
        const saved = await gateway.waitForRequest("config.set", { after: 1 });
        expect(saved.params).toMatchObject(
          restored ? { raw: expect.any(String) } : { baseHash: "recovered" },
        );
        const { raw } = saved.params as { raw: string };
        expect(JSON.parse(raw)).toEqual({ ...config, messages: { responsePrefix: finalDraft } });
        await gateway.resolveDeferred("config.set");
        await expect
          .poll(() => indicator.textContent())
          .toContain(restored ? "Apply changes" : "Saved");
        if (restored) {
          await page.reload();
          await expect.poll(() => prefix.inputValue()).toBe(finalDraft);
        }
      }),
  );

  it("Settings config.get shows ordinary validation issues without claiming restoration failed", () =>
    withPage(async ({ page }) => {
      const issues = [{ path: "gateway.port", message: "Expected number, received string" }];
      await installMockGateway(page, {
        methodResponses: {
          ...scenario.methodResponses,
          "config.get": { ...snapshot, raw: null, config: {}, valid: false, issues },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/advanced`);
      const diagnostics = page.locator(".config-content-callout");
      await expect.poll(() => diagnostics.textContent()).toContain("gateway.port");
      expect(await diagnostics.textContent()).toContain("Expected number, received string");
      const indicator = page.locator("openclaw-settings-save-indicator");
      expect(await indicator.textContent()).not.toContain("restoration");
      expect(
        await indicator.getByRole("button", { name: "Discard draft and reload" }).count(),
      ).toBe(0);
    }));
});
