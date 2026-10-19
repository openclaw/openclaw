import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { SessionsPatchResult } from "../../../src/gateway/session-utils.types.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

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
        await revealChatModelOption(picker.locator('[data-chat-model-option="openai/gpt-5.5"]'));
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
  it.each([
    { status: "error", message: "Models unavailable" },
    { status: "offline", message: "Offline" },
  ] as const)(
    "shows the $status catalog state when the panel arrives",
    async ({ status, message }) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const held = await holdModuleResponse(
          page,
          controlUiE2eBuiltModuleRequest(
            "ui/src/pages/chat/components/chat-model-picker-options.tsx",
          ),
        );
        try {
          const gateway = await installMockGateway(page, {
            models: [],
            methodResponses: {
              "models.list": {
                __mockError: { code: "UNAVAILABLE", message: "Synthetic catalog unavailable" },
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          const picker = page.locator(".chat-controls__model-picker").first();
          const trigger = picker.locator("[data-chat-model-select]");
          await expect.poll(() => trigger.getAttribute("aria-disabled")).toBe("false");
          await trigger.click();
          await held.request;
          await gateway.waitForRequest("models.list");
          await expect
            .poll(() => picker.locator('[role="status"]').textContent())
            .toContain("Loading models");
          if (status === "offline") {
            await gateway.setOnline(false);
            await expect.poll(() => trigger.getAttribute("aria-disabled")).toBe("true");
          }
          held.release();
          await picker.locator(".chat-controls__model-menu").waitFor();
          const notice = picker.locator(`[data-chat-model-catalog-state="${status}"]`);
          await expect.poll(() => notice.isVisible()).toBe(true);
          expect(await notice.textContent()).toBe(message);
          expect(await notice.getAttribute("aria-live")).toBe("polite");
          const artifactDir = createControlUiE2eArtifactDir(`model-panel-${status}`);
          await page.screenshot({ path: path.join(artifactDir, "loaded-catalog-state.png") });
        } finally {
          held.release();
        }
      });
    },
  );
  it.each([
    ["new", "open"],
    ["new", "closed"],
    ["new", "focus moved"],
    ["chat", "open"],
    ["chat", "closed"],
    ["chat", "focus moved"],
  ] as const)("keeps /%s usable while model choices load (%s)", async (route, state) => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const held = await holdModuleResponse(
        page,
        controlUiE2eBuiltModuleRequest(
          "ui/src/pages/chat/components/chat-model-picker-options.tsx",
        ),
      );
      try {
        const models = ["Alpha", "Beta"].map((name) => ({
          id: name.toLowerCase(),
          name,
          provider: "example",
          contextWindow: 128_000,
        }));
        await installMockGateway(page, {
          models,
          agentModel: "example/alpha",
          sessionInfo: { model: "alpha", modelProvider: "example" },
        });
        await page.goto(`${suite.server.baseUrl}${route}`);
        const picker = page.locator(".chat-controls__model-picker").first();
        const trigger = picker.locator("[data-chat-model-select]");
        const textarea = page.locator(".agent-chat__input textarea").first();
        await expect.poll(() => trigger.getAttribute("aria-disabled")).toBe("false");
        expect(held.requests()).toBe(0);
        await trigger.click();
        await held.request;
        await expect
          .poll(() => picker.locator('[role="status"]').textContent())
          .toContain("Loading models");
        expect(await picker.getAttribute("open")).not.toBeNull();
        if (state === "closed") {
          await trigger.click();
          expect(await picker.getAttribute("open")).toBeNull();
        }
        if (state !== "open") {
          await textarea.focus();
        }
        held.release();
        const search = picker.locator("[data-chat-model-search]");
        await expect.poll(() => search.count()).toBe(1);
        await expect
          .poll(() =>
            page.evaluate(() => document.activeElement?.hasAttribute("data-chat-model-search")),
          )
          .toBe(state === "open");
        if (state !== "open") {
          expect(await textarea.evaluate((element) => document.activeElement === element)).toBe(
            true,
          );
        }
        if (state !== "open") {
          expect(await picker.getAttribute("open")).toBeNull();
          await trigger.click();
        }
        await search.fill("Beta");
        const choice = picker.locator('[data-chat-model-option="example/beta"]');
        await expect.poll(() => choice.isVisible()).toBe(true);
        await search.press("Enter");
        await expect.poll(() => picker.getAttribute("open")).toBeNull();
        expect(held.requests()).toBe(1);
      } finally {
        held.release();
      }
    });
  });
});
