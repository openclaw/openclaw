import path from "node:path";
import { expect, it } from "vitest";
import type { ModelCatalogEntry } from "../api/types.ts";
import { fillComposer } from "../test-helpers/composer-editor.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Model runtime selection" });
const model = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  provider: "openai",
  available: true,
  contextWindow: 1_000_000,
  agentRuntime: { id: "openclaw", source: "model" },
  runtimeChoices: [
    { agentRuntime: { id: "codex", source: "model" }, available: true, contextWindow: 200_000 },
  ],
} satisfies ModelCatalogEntry;

suite.define(() => {
  it.each([false, true])(
    "keeps Default reset without offering denied models (manual choices: %s)",
    async (hasAllowedModel) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const key = "agent:main:main";
        const row = {
          key,
          sessionId: "manual-policy-reset",
          kind: "direct",
          model: "manual",
          modelProvider: "fixture",
          modelOverrideSource: "user",
          updatedAt: 1,
        };
        const models: ModelCatalogEntry[] = [
          {
            id: "automatic",
            name: "Automatic",
            provider: "fixture",
            available: true,
            manualSelectionAllowed: false,
            agentRuntime: { id: "openclaw", source: "model" },
            runtimeChoices: [
              { agentRuntime: { id: "other-runtime", source: "model" }, available: true },
            ],
          },
        ];
        if (hasAllowedModel) {
          models.push(
            { id: "allowed", name: "Allowed", provider: "fixture", available: true },
            {
              id: "manual",
              name: "Forbidden pinned",
              provider: "fixture",
              available: true,
              manualSelectionAllowed: false,
            },
          );
        }
        const gateway = await installMockGateway(page, {
          agentModel: "fixture/automatic",
          models,
          sessions: [row],
          sessionInfo: row,
          methodResponses: {
            "sessions.list": {
              ts: 1,
              path: "",
              count: 1,
              defaults: { model: "automatic", modelProvider: "fixture", contextTokens: 128_000 },
              sessions: [row],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("models.list");
        const picker = page
          .locator(".agent-chat__input")
          .first()
          .locator(".chat-controls__model-picker");
        await picker.locator("[data-chat-model-select]").click();
        await picker.locator(".chat-controls__model-menu").screenshot({
          path: path.join(suite.artifactDir, `manual-policy-${hasAllowedModel}.png`),
        });
        const reset = picker.locator('[data-chat-model-option="fixture/automatic"]');
        expect(await reset.count()).toBe(1);
        expect(await picker.locator('[data-chat-model-runtime="other-runtime"]').count()).toBe(0);
        expect(await picker.locator('[data-chat-model-option="fixture/manual"]').count()).toBe(
          hasAllowedModel ? 0 : 1,
        );
        await reset.click();
        expect((await gateway.waitForRequest("sessions.patch")).params).toMatchObject({
          key,
          model: null,
        });
      });
    },
  );

  it.each(["chat", "new"])("selects a second same-name harness through /%s", async (route) => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const key = "agent:main:main";
      const row = {
        key,
        sessionId: "runtime-selection",
        kind: "direct",
        model: model.id,
        modelProvider: "openai",
        modelOverrideSource: null,
        agentRuntime: model.agentRuntime,
        updatedAt: 1,
      };
      const result = {
        ts: 1,
        path: "",
        count: 1,
        defaults: {
          model: model.id,
          modelProvider: "openai",
          contextTokens: 1_000_000,
          agentRuntime: model.agentRuntime,
        },
        sessions: [row],
      };
      const gateway = await installMockGateway(page, {
        agentModel: "openai/gpt-5.6-sol",
        models: [model],
        sessions: [row],
        deferredMethods: route === "chat" ? ["sessions.patch"] : [],
        methodResponses: {
          "sessions.list": result,
          "sessions.create": { key: "agent:main:runtime-created", runStarted: true },
        },
      });
      await page.goto(`${suite.server.baseUrl}${route}`);
      const composer = page.locator(".agent-chat__input").first();
      const picker = composer.locator(".chat-controls__model-picker");
      const trigger = picker.locator("[data-chat-model-select]");
      await expect.poll(() => picker.locator("[data-chat-model-option]").count()).toBe(2);
      await trigger.click();
      const codex = picker.locator('[data-chat-model-runtime="codex"]');
      const embedded = picker.locator('[data-chat-model-runtime="openclaw"]');
      expect(await codex.textContent()).toContain("200k · Codex");
      expect(await embedded.textContent()).toContain("1M · OpenClaw");
      await codex.click();
      if (route === "new") {
        await expect.poll(() => codex.getAttribute("aria-selected")).toBe("true");
        await fillComposer(
          composer.locator("openclaw-composer-editor").first(),
          "Reply with the selected runtime.",
        );
        await page.getByRole("button", { name: "Start session" }).click();
        expect((await gateway.waitForRequest("sessions.create")).params).toMatchObject({
          model: "openai/gpt-5.6-sol",
          agentRuntime: "codex",
        });
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      } else {
        expect((await gateway.waitForRequest("sessions.patch")).params).toMatchObject({
          key,
          model: "openai/gpt-5.6-sol",
          agentRuntime: "codex",
        });
        const selected = {
          ...row,
          agentRuntime: { id: "codex", source: "session-key" },
          modelOverrideSource: null,
        };
        await gateway.setSessionsListResponse({ ...result, sessions: [selected] });
        await gateway.resolveDeferred("sessions.patch", {
          ok: true,
          key,
          path: "",
          entry: selected,
        });
        await expect.poll(() => trigger.getAttribute("aria-disabled")).toBe("false");
        await expect.poll(() => codex.getAttribute("aria-selected")).toBe("true");
        expect(await picker.locator('[data-chat-model-option][aria-selected="true"]').count()).toBe(
          1,
        );
        const reset = { key, model: null, agentRuntime: null };
        const after = (await gateway.getRequests("sessions.patch", reset)).length;
        await gateway.deferNext("sessions.patch", reset);
        await trigger.click();
        await embedded.click();
        expect(
          (await gateway.waitForRequest("sessions.patch", { after, match: reset })).params,
        ).toMatchObject(reset);
        await gateway.setSessionsListResponse(result);
        await gateway.resolveDeferred("sessions.patch", { ok: true, key, path: "", entry: row });
        await expect.poll(() => embedded.getAttribute("aria-selected")).toBe("true");
        expect(await picker.locator('[data-chat-model-option][aria-selected="true"]').count()).toBe(
          1,
        );
      }
    });
  });
});
