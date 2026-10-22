import { expect, it } from "vitest";
import type { ModelCatalogEntry } from "../api/types.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  openChatModelPicker,
  revealChatModelOption,
  selectChatModelOption,
} from "../test-helpers/select-picker-e2e.ts";
import {
  modelPicker,
  modelSessionList,
  runtimeModel,
} from "./chat-runtime-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expectRequest } from "./new-session-shard.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Model runtime selection" });
const key = "agent:main:main";
function sessionFixture(sessionId: string, model: string, provider: string, extra = {}) {
  return { key, sessionId, kind: "direct", model, modelProvider: provider, updatedAt: 1, ...extra };
}
const manualModel = (id: string, name: string, extra: Partial<ModelCatalogEntry> = {}) => ({
  id,
  name,
  provider: "fixture",
  available: true,
  ...extra,
});

suite.define(() => {
  it("shows each runtime's own name and context budget", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const model = runtimeModel("gpt-5.6-sol", "openai", "GPT-5.6 Sol", [], {
        contextWindow: 1_000_000,
        runtimeChoices: [
          {
            agentRuntime: { id: "codex", source: "model" },
            available: true,
            contextWindow: 200_000,
          },
        ],
      });
      await installMockGateway(page, { agentModel: "openai/gpt-5.6-sol", models: [model] });
      await page.goto(`${suite.server.baseUrl}chat`);
      const { picker, runtime } = modelPicker(page);
      await openChatModelPicker(picker);
      for (const [id, name, context] of [
        ["codex", "GPT-5.6 Sol codex", "200k · Codex"],
        ["openclaw", "GPT-5.6 Sol", "1M · OpenClaw"],
      ] as const) {
        const option = runtime(id);
        await revealChatModelOption(option);
        expect(await option.locator(".chat-controls__model-option-name").textContent()).toBe(name);
        expect(await option.textContent()).toContain(context);
      }
    });
  });

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
});
