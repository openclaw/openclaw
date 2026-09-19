import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { SessionsPatchResult } from "../../../src/gateway/session-utils.types.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Model selection recovery" });

suite.define(() => {
  it.each([false, true])(
    "retains a confirmed model selection when the roster refresh fails=%s",
    async (refreshFails) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const artifactDir = createControlUiE2eArtifactDir("model-selection-recovery");
        const key = "agent:main:model-selection-proof";
        const row = {
          key,
          sessionId: "synthetic-model-selection",
          kind: "direct",
          label: "Synthetic model selection",
          model: "gpt-5.4",
          modelProvider: "openai",
          modelOverrideSource: "user",
          updatedAt: 1,
        };
        const selected = { ...row, model: "gpt-5.5", updatedAt: 2 };
        const gateway = await installMockGateway(page, {
          agentModel: "openai/gpt-5.4",
          sessionKey: key,
          sessionInfo: row,
          sessions: [row],
          models: [
            { id: "gpt-5.4", name: "GPT-5.4", provider: "openai", available: true },
            { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
          ],
          deferredMethods: ["sessions.patch"],
          methodResponses: {
            "sessions.list": {
              ts: 1,
              path: "",
              count: 1,
              defaults: { model: "gpt-5.4", modelProvider: "openai", contextTokens: 128_000 },
              sessions: [row],
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        const picker = page.locator(
          'openclaw-chat-pane[aria-hidden="false"] .chat-controls__model-picker',
        );
        const trigger = picker.locator("[data-chat-model-select]");
        await expect.poll(() => trigger.getAttribute("aria-disabled")).toBe("false");
        await trigger.click();
        await picker.locator('[data-chat-model-option="openai/gpt-5.5"]').waitFor();
        await page.screenshot({ path: path.join(artifactDir, "before-selection.png") });
        await picker.locator('[data-chat-model-option="openai/gpt-5.5"]').click();
        const patch = await gateway.waitForRequest("sessions.patch");
        expect(patch.params).toMatchObject({ key, model: "openai/gpt-5.5" });
        await expect.poll(() => trigger.getAttribute("aria-disabled")).toBe("true");

        if (refreshFails) {
          await gateway.setMethodResponse("sessions.list", {
            __mockError: { code: "UNAVAILABLE", message: "Synthetic roster refresh unavailable" },
          });
        }
        const listCount = (await gateway.getRequests("sessions.list")).length;
        // The fixture commits the successful patch to its canonical session owner.
        // No lifecycle event is emitted; the receipt must survive a failed read.
        await gateway.resolveDeferred("sessions.patch", {
          ok: true,
          key,
          path: "",
          entry: {
            sessionId: row.sessionId,
            updatedAt: selected.updatedAt,
            providerOverride: "openai",
            modelOverride: selected.model,
            modelOverrideSource: "user",
          },
          resolved: { modelProvider: "openai", model: selected.model },
        } satisfies SessionsPatchResult);
        await gateway.waitForRequest("sessions.list", { after: listCount });
        await expect.poll(() => trigger.getAttribute("aria-disabled")).toBe("false");
        await trigger.click();
        await picker.locator(".chat-controls__model-menu").waitFor();
        const observedSelection = await trigger.getAttribute("data-chat-select-value");
        const observedLabel = await trigger.textContent();
        // Preserve the actual settled UI and transport evidence before the regression assertion.
        await page.screenshot({ path: path.join(artifactDir, "after-confirmed-selection.png") });
        await writeFile(
          path.join(artifactDir, "selection.json"),
          JSON.stringify(
            {
              refreshFails,
              confirmed: selected,
              observedSelection,
              observedLabel,
              patches: await gateway.getRequests("sessions.patch"),
              lists: await gateway.getRequests("sessions.list"),
            },
            null,
            2,
          ),
        );
        expect(observedSelection).toBe("openai/gpt-5.5");
        expect(observedLabel).toContain("GPT-5.5");
      });
    },
  );
});
