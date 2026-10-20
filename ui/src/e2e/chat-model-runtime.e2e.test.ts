import { expect, it } from "vitest";
import type { ModelCatalogEntry } from "../api/types.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  openChatModelPicker,
  revealChatModelOption,
  selectChatModelOption,
} from "../test-helpers/select-picker-e2e.ts";
import { polledAttribute, polledCount } from "./chat-presentation.test-support.ts";
import {
  modelPicker,
  modelSessionList,
  runtimeModel,
} from "./chat-runtime-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expectRequest } from "./new-session-shard.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Model runtime selection" });
const key = "agent:main:main";
const selectedRuntime = { model: "openai/gpt-5.6-sol", agentRuntime: "codex" };
function sessionFixture(sessionId: string, model: string, provider: string, extra = {}) {
  return { key, sessionId, kind: "direct", model, modelProvider: provider, updatedAt: 1, ...extra };
}
const model = runtimeModel("gpt-5.6-sol", "openai", "GPT-5.6 Sol", [], {
  contextWindow: 1_000_000,
  runtimeChoices: [
    { agentRuntime: { id: "codex", source: "model" }, available: true, contextWindow: 200_000 },
  ],
});
const manualModel = (id: string, name: string, extra: Partial<ModelCatalogEntry> = {}) => ({
  id,
  name,
  provider: "fixture",
  available: true,
  ...extra,
});

suite.define(() => {
  it.each([false, true])(
    "keeps Default reset without offering denied models (manual choices: %s)",
    async (hasAllowedModel) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const row = sessionFixture("manual-policy-reset", "manual", "fixture", {
          modelOverrideSource: "user",
        });
        const models: ModelCatalogEntry[] = [
          runtimeModel("automatic", "fixture", "Automatic", ["other-runtime"], {
            manualSelectionAllowed: false,
          }),
        ];
        if (hasAllowedModel) {
          models.push(
            manualModel("allowed", "Allowed"),
            manualModel("manual", "Forbidden pinned", { manualSelectionAllowed: false }),
          );
        }
        const gateway = await installMockGateway(page, {
          agentModel: "fixture/automatic",
          models,
          sessions: [row],
          sessionInfo: row,
          methodResponses: {
            "sessions.list": modelSessionList(row, {
              model: "automatic",
              modelProvider: "fixture",
              contextTokens: 128_000,
            }),
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("models.list");
        const { picker, option, runtime } = modelPicker(page);
        await openChatModelPicker(picker);
        const reset = option("fixture/automatic");
        expect({
          reset: await reset.count(),
          deniedRuntime: await runtime("other-runtime").count(),
          pinned: await option("fixture/manual").count(),
        }).toEqual({ reset: 1, deniedRuntime: 0, pinned: hasAllowedModel ? 0 : 1 });
        await selectChatModelOption(reset);
        await expectRequest(gateway, "sessions.patch", { key, model: null });
      });
    },
  );

  it.each(["chat", "new"])("selects a second harness through /%s", async (route) => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const row = sessionFixture("runtime-selection", model.id, "openai", {
        modelOverrideSource: null,
        agentRuntime: model.agentRuntime,
      });
      const result = modelSessionList(row, {
        model: model.id,
        modelProvider: "openai",
        contextTokens: 1_000_000,
        agentRuntime: model.agentRuntime,
      });
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
      const patchResult = (entry: typeof row) => ({ ok: true, key, path: "", entry });
      await page.goto(`${suite.server.baseUrl}${route}`);
      const { composer, picker, trigger, runtime } = modelPicker(page);
      await trigger.click();
      await polledCount(picker.locator("[data-chat-model-option]")).toBe(2);
      const codex = runtime("codex");
      const embedded = runtime("openclaw");
      await revealChatModelOption(codex);
      for (const [option, name, context] of [
        [codex, "GPT-5.6 Sol codex", "200k · Codex"],
        [embedded, "GPT-5.6 Sol", "1M · OpenClaw"],
      ] as const) {
        expect(await option.locator(".chat-controls__model-option-name").textContent()).toBe(name);
        expect(await option.textContent()).toContain(context);
      }
      await selectChatModelOption(codex);
      if (route === "new") {
        await polledAttribute(codex, "aria-selected").toBe("true");
        expect(await trigger.textContent()).toContain("GPT-5.6 Sol codex");
        await composer.locator("textarea").first().fill("Reply with the selected runtime.");
        await page.getByRole("button", { name: "Start session" }).click();
        await expectRequest(gateway, "sessions.create", selectedRuntime);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      } else {
        await expectRequest(gateway, "sessions.patch", { key, ...selectedRuntime });
        const selected = {
          ...row,
          agentRuntime: { id: "codex", source: "session-key" },
        };
        await gateway.setSessionsListResponse({ ...result, sessions: [selected] });
        await gateway.resolveDeferred("sessions.patch", patchResult(selected));
        await polledAttribute(trigger, "aria-disabled").toBe("false");
        await polledAttribute(codex, "aria-selected").toBe("true");
        expect(await trigger.textContent()).toContain("GPT-5.6 Sol codex");
        const selectedOptions = picker.locator('[data-chat-model-option][aria-selected="true"]');
        expect(await selectedOptions.count()).toBe(1);
        const reset = { key, model: null, agentRuntime: null };
        const after = (await gateway.getRequests("sessions.patch", reset)).length;
        await gateway.deferNext("sessions.patch", reset);
        await trigger.click();
        await selectChatModelOption(embedded);
        expect(
          (await gateway.waitForRequest("sessions.patch", { after, match: reset })).params,
        ).toMatchObject(reset);
        await gateway.setSessionsListResponse(result);
        await gateway.resolveDeferred("sessions.patch", patchResult(row));
        await polledAttribute(embedded, "aria-selected").toBe("true");
        expect(await selectedOptions.count()).toBe(1);
      }
    });
  });
});
