import { expect, it } from "vitest";
import { createControlUiMockBootstrapConfig } from "../test-helpers/control-ui-e2e.ts";
import { revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { openFromForeground, scenario } from "./command-palette.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "command palette model memory" });

suite.define(() => {
  it.each(["last-used", "configured"] as const)(
    "saves the selected model without placement settings and honors %s defaults",
    async (policy) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, colorScheme: "light" },
        async ({ page }) => {
          const fixture = scenario();
          const gateway = await installMockGateway(page, {
            ...fixture,
            models: [
              { provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
              { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 mini" },
            ],
            presenceUsers: [{ self: true, id: "palette-user", name: "Sample User" }],
            featureMethods: [
              ...(fixture.featureMethods ?? []),
              "users.prefs.get",
              "users.prefs.set",
            ],
            bootstrapPreferences: {
              profileId: "palette-user",
              entries: {
                "new-session.migration.v1": true,
                "new-session.v1:main": { worktreeName: "foreground-only" },
              },
            },
            methodResponses: {
              ...fixture.methodResponses,
              "agents.list": {
                defaultId: "main",
                mainKey: "main",
                scope: "per-sender",
                agents: [{ id: "main", name: "Main", model: { primary: "openai/gpt-4.1" } }],
              },
              "sessions.create": { key: "agent:main:dashboard:palette-model", runStarted: true },
            },
          });
          await page.route("**/control-ui-config.json", (route) =>
            route.fulfill({
              json: { ...createControlUiMockBootstrapConfig(), newSessionModelDefaults: policy },
            }),
          );
          const { palette, input } = await openFromForeground(page, suite.server.baseUrl);
          await palette.getByRole("tab", { name: "Compose", exact: true }).click();
          const model = palette.locator('[data-chat-model-select="true"]');
          await expect.poll(() => model.textContent()).toContain("GPT-4.1");
          await gateway.deferNext("users.prefs.set");
          await model.click();
          await (await revealChatModelOption(palette, "openai/gpt-4.1-mini")).click();
          await expect.poll(() => model.textContent()).toContain("GPT-4.1 mini");
          await input.press("Escape");
          await input.waitFor({ state: "hidden" });
          await page.keyboard.press("ControlOrMeta+K");
          await input.waitFor({ state: "visible" });
          const write = await gateway.waitForRequest("users.prefs.set");
          expect(write.params).toMatchObject({
            entries: {
              "new-session.v1:main": {
                model: "openai/gpt-4.1-mini",
                worktreeName: "foreground-only",
              },
            },
          });
          expect(write.params).not.toHaveProperty(["entries", "new-session.palette.v1"]);
          await gateway.resolveDeferred("users.prefs.set");
          const expectedModel = policy === "last-used" ? "GPT-4.1 mini" : "GPT-4.1";
          await expect.poll(async () => (await model.textContent())?.trim()).toBe(expectedModel);
          await page.reload();
          await page.locator(".agent-chat__composer-combobox textarea:visible").waitFor();
          await page.keyboard.press("ControlOrMeta+K");
          await input.waitFor({ state: "visible" });
          await expect.poll(async () => (await model.textContent())?.trim()).toBe(expectedModel);
          await input.fill("Check the saved model selection.");
          await expect
            .poll(() =>
              palette
                .getByRole("button", { name: "Start new session in background", exact: true })
                .isEnabled(),
            )
            .toBe(true);
          await input.press("ControlOrMeta+Enter");
          const created = await gateway.waitForRequest("sessions.create");
          if (policy === "last-used") {
            expect(created.params).toMatchObject({ model: "openai/gpt-4.1-mini" });
          } else {
            expect(created.params).not.toHaveProperty("model");
          }
          expect(created.params).not.toHaveProperty("worktreeName");
        },
      );
    },
  );
});
