import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiMockBootstrapConfig } from "../test-helpers/control-ui-e2e.ts";
import { openChatModelPicker, revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { openFromForeground, scenario } from "./command-palette.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "command palette model memory" });

suite.define(() => {
  it("sends an unchanged palette draft after switching models", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, colorScheme: "light" },
      async ({ page }) => {
        const modelId = "openai/gpt-5.5-mini";
        const message = "Summarize the planning notes.";
        const fixture = scenario({
          "projects.list": { projects: [] },
          "sessions.create": { key: "agent:main:dashboard:palette-model", runStarted: true },
        });
        const gateway = await installMockGateway(page, {
          ...fixture,
          models: [
            { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
            { provider: "openai", id: "gpt-5.5-mini", name: "GPT-5.5 mini" },
          ],
          presenceUsers: [{ self: true, id: "palette-user", name: "Sample User" }],
          featureMethods: [
            ...(fixture.featureMethods ?? []),
            "projects.list",
            "users.prefs.get",
            "users.prefs.set",
          ],
          bootstrapPreferences: {
            profileId: "palette-user",
            entries: { "new-session.migration.v1": true },
          },
        });
        const { palette, input } = await openFromForeground(page, suite.server.baseUrl);
        await palette.getByRole("tab", { name: "Compose", exact: true }).click();
        await input.fill(message);
        const send = palette.getByRole("button", { name: "Start new session in background" });
        await expect.poll(() => send.isEnabled()).toBe(true);
        await gateway.deferNext("users.prefs.set");
        await openChatModelPicker(palette);
        await (await revealChatModelOption(palette, modelId)).click();
        await gateway.waitForRequest("users.prefs.set");
        await gateway.resolveDeferred("users.prefs.set");
        expect(await input.inputValue()).toBe(message);
        await expect
          .poll(() => send.isEnabled(), {
            timeout: 3000,
            message: "Send re-enables after the model preference is saved",
          })
          .toBe(true);
        await send.click();
        const created = await gateway.waitForRequest("sessions.create");
        expect(created.params).toMatchObject({ message, model: modelId });
      },
    );
  });

  it.each(["session", "palette"])(
    "prefers recommended models in %s picker search",
    async (surface) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, colorScheme: "dark" },
        async ({ page }) => {
          const opus = "clawrouter/anthropic/claude-opus-5-5";
          const gpt = "openai/gpt-5.5";
          const fixture = scenario();
          await installMockGateway(page, {
            ...fixture,
            featureMethods: [...(fixture.featureMethods ?? []), "sessions.patch"],
            agentModel: gpt,
            models: [
              { provider: "openai", id: "gpt-5.5", name: "GPT-5.5", contextWindow: 1_000_000 },
              {
                provider: "openai",
                id: "gpt-5.5-pro",
                name: "GPT-5.5 Pro",
                contextWindow: 1_000_000,
              },
              {
                provider: "clawrouter",
                id: "anthropic/claude-opus-5-5",
                name: "Claude Opus 5.5 via ClawRouter",
                contextWindow: 1_000_000,
                recommended: true,
              },
            ],
          });
          const { palette, input } = await openFromForeground(page, suite.server.baseUrl);
          if (surface === "palette") {
            await palette.getByRole("tab", { name: "Compose", exact: true }).click();
          } else {
            await input.press("Escape");
            await palette.waitFor({ state: "hidden" });
          }
          const scope =
            surface === "palette" ? palette : page.locator(".agent-chat__input").first();
          await openChatModelPicker(scope);
          const menu = scope.locator(".chat-controls__model-menu");
          const search = menu.locator("[data-chat-model-search]");
          const selectedResult = () =>
            menu
              .locator('[data-chat-model-option][data-chat-model-rank="0"]')
              .getAttribute("data-chat-model-option");
          await search.fill("5.5");
          const options = menu.locator("[data-chat-model-option]:visible");
          await expect.poll(() => options.count()).toBe(3);
          if (process.env.OPENCLAW_PICKER_RANKING_PROOF === "1") {
            const frame = await takeControlUiScreenshotFrame(
              page,
              menu,
              [search, ...(await options.all())],
              { animations: "disabled" },
            );
            await writeFile(`${suite.artifactDir}/${surface}.png`, frame.png);
          }
          expect.soft(await selectedResult()).toBe(opus);
          await search.fill("gpt-5.5");
          await expect.poll(selectedResult).toBe(gpt);
        },
      );
    },
  );

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
