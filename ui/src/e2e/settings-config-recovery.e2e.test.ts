import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Settings config publication recovery" });
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

const scenario = {
  methodResponses: {
    "config.get": snapshot,
    "config.schema": {
      schema: {
        type: "object",
        properties: {
          messages: {
            type: "object",
            properties: {
              responsePrefix: { type: "string", title: "Outbound Response Prefix" },
            },
          },
        },
      },
      uiHints: { "messages.responsePrefix": { advanced: false } },
      version: "test",
    },
  },
};

suite.define(() => {
  it.each(["unknown", "not-restored", "restored"])(
    "Settings config.set preserves the full draft after partial publication (%s)",
    async (rollbackStatus) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 } },
        async ({ page, context }) => {
          const gateway = await installMockGateway(page, scenario);
          await page.goto(`${suite.server.baseUrl}settings/communications`);
          const prefix = page.getByRole("textbox", { name: "Outbound Response Prefix" });
          await prefix.waitFor();
          await gateway.deferNext("config.set");
          await prefix.fill("retained draft");
          await prefix.press("Tab");
          await gateway.waitForRequest("config.set");
          const message = `Config publication failed after removing ${configPath}: included config changed since last load. Restoration: ${rollbackStatus}. Inspect recovery backups at ${recoveryBackupPath}.`;
          await gateway.rejectDeferred("config.set", {
            code: "UNAVAILABLE",
            message,
            details: { publication: "partial", rollbackStatus, configPath, recoveryBackupPath },
          });
          const indicator = page.locator("openclaw-settings-save-indicator");
          await expect
            .poll(() => indicator.textContent())
            .toContain(rollbackStatus === "restored" ? "Save failed" : "Your draft is kept");
          expect(await indicator.getByRole("button", { name: "Reload", exact: true }).count()).toBe(
            0,
          );
          if (rollbackStatus !== "restored") {
            const secondPage = await context.newPage();
            const secondGateway = await installMockGateway(secondPage, {
              ...scenario,
              deferredMethods: ["config.get"],
            });
            await secondPage.goto(`${suite.server.baseUrl}settings/communications`);
            await secondGateway.waitForRequest("config.get");
            await secondGateway.resolveDeferred("config.get", {
              ...snapshot,
              exists: false,
              raw: null,
              config: {},
              writeError: {
                code: "UNAVAILABLE",
                message,
                details: { publication: "partial", rollbackStatus, configPath, recoveryBackupPath },
              },
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
            await gateway.setMethodResponse("config.get", {
              ...snapshot,
              exists: false,
              config: {},
              raw: null,
              hash: "missing",
            });
            await prefix.fill("later draft");
            await prefix.press("Tab");
            // Exceed the registered Settings autosave debounce before checking absence.
            await page.waitForTimeout(1200);
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
            await page.waitForFunction(() => {
              const app = document.querySelector("openclaw-app") as HTMLElement & {
                runtime?: { context: { gateway: { snapshot: { phase: string } } } };
              };
              return app.runtime?.context.gateway.snapshot.phase === "connected";
            });
            for (const candidate of [
              { ...snapshot, exists: false, config: {}, raw: null, hash: "missing" },
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
            await prefix.fill("initial");
            await prefix.press("Tab");
            await expect.poll(() => prefix.inputValue()).toBe("initial");
            await gateway.setMethodResponse("config.get", { ...snapshot, hash: "recovered" });
            await recover.click();
            await expect.poll(() => indicator.textContent()).not.toContain("Your draft is kept");
            await gateway.deferNext("config.set");
            await prefix.fill("saved after recovery");
            await prefix.press("Tab");
            const saved = await gateway.waitForRequest("config.set", { after: 1 });
            expect(saved.params).toMatchObject({ baseHash: "recovered" });
            const { raw } = saved.params as { raw: string };
            expect(JSON.parse(raw)).toEqual({
              ...config,
              messages: { responsePrefix: "saved after recovery" },
            });
            await gateway.resolveDeferred("config.set");
            await expect.poll(() => indicator.textContent()).toContain("Saved");
          } else {
            await gateway.deferNext("config.set");
            await indicator.getByRole("button", { name: "Retry" }).click();
            const retried = await gateway.waitForRequest("config.set", { after: 1 });
            expect(retried.params).toEqual(expect.objectContaining({ raw: expect.any(String) }));
            const { raw } = retried.params as { raw: string };
            expect(JSON.parse(raw)).toEqual({
              ...config,
              messages: { responsePrefix: "retained draft" },
            });
            await gateway.resolveDeferred("config.set");
            await expect.poll(() => indicator.textContent()).toContain("Apply changes");
            await page.reload();
            await expect.poll(() => prefix.inputValue()).toBe("retained draft");
          }
        },
      );
    },
  );

  it("Settings config.get shows ordinary validation issues without claiming restoration failed", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
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
    });
  });
});
