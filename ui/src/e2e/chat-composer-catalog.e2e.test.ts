// Control UI E2E tests cover chat composer catalog discovery.
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { buildGatewaySessionSnapshot } from "../../../src/gateway/session-event-payload.ts";
import type { GatewaySessionRow, ModelCatalogEntry } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
  type ControlUiMockGateway,
  type MockGatewayWindow,
} from "../test-helpers/control-ui-e2e.ts";
import { revealChatModelOption, selectChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat composer catalog",
});

type CatalogModel = { id: string; name: string; provider: string };
const modelOption = (scope: Locator, model: string) =>
  scope.locator(`[data-chat-model-option="${model}"]`);

function availableModel(id: string, name: string, provider: string) {
  return { id, name, provider, available: true };
}

function sessionRow(model: CatalogModel, overrides: Partial<GatewaySessionRow> = {}) {
  return {
    key: "main",
    kind: "direct",
    model: model.id,
    modelProvider: model.provider,
    status: "done",
    updatedAt: Date.now(),
    ...overrides,
  };
}

function sessionList(
  model: CatalogModel,
  sessions = [sessionRow(model)],
  contextTokens?: number,
  ts = Date.now(),
) {
  return {
    count: sessions.length,
    defaults: {
      model: model.id,
      modelProvider: model.provider,
      ...(contextTokens === undefined ? {} : { contextTokens }),
    },
    sessions,
    path: "",
    ts,
  };
}

async function expectCount(target: Locator, count: number) {
  await expect.poll(() => target.count()).toBe(count);
}

async function expectVisible(target: Locator) {
  await expect.poll(() => target.isVisible()).toBe(true);
}

async function expectText(target: Locator, text: string) {
  await expect.poll(() => target.textContent()).toContain(text);
}

function optionalCapture(page: Page) {
  const root = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
  const dir = root ? createControlUiE2eArtifactDir("chat-composer-catalog", root) : undefined;
  return async (name: string, region?: Locator) => {
    if (!dir) {
      return;
    }
    const options = { animations: "disabled" as const, path: `${dir}/${name}.png` };
    if (region) {
      await region.screenshot(options);
    } else {
      await page.screenshot({ ...options, fullPage: true });
    }
  };
}

suite.define(() => {
  it.each(["config.changed", "chat.metadata.changed"])(
    "recovers the retained composer after %s without reloading",
    async (event) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const model = { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" };
        const gateway = await installMockGateway(page, {
          agentModel: "openai/gpt-5.6-luna",
          models: [{ ...model, available: false, unavailableReason: "missing-auth" }],
          historyMessages: [
            { role: "assistant", content: [{ type: "text", text: "Earlier reply" }] },
          ],
          methodResponses: {
            "sessions.list": sessionList(model, [
              {
                key: "main",
                kind: "direct",
                model: model.id,
                modelProvider: model.provider,
                status: "error",
                lastRunError: "No route-compatible authentication source is configured",
                updatedAt: Date.now(),
              },
            ]),
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        const textarea = page.locator(".agent-chat__composer-combobox > textarea");
        const send = page.getByRole("button", { name: "Send message", exact: true });
        const draft = "Continue our conversation.";
        await expect.poll(() => textarea.isDisabled()).toBe(false);
        await textarea.fill(draft);
        await expect.poll(() => send.isDisabled()).toBe(true);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        const startupCount = (await gateway.getRequests("chat.startup")).length;
        const socketCount = await gateway.getSocketCount();

        await gateway.deferNext("models.list");
        await gateway.setMethodResponse("models.list", {
          commands: [],
          models: [{ ...model, available: true }],
        });
        await gateway.emitGatewayEvent(event, {});
        await gateway.waitForRequest("models.list", { after: 1 });
        expect(await textarea.isDisabled()).toBe(false);
        expect(await textarea.inputValue()).toBe(draft);
        expect(await send.isDisabled()).toBe(true);
        await gateway.resolveDeferred("models.list");
        await expect.poll(() => send.isDisabled()).toBe(false);
        expect(await textarea.isDisabled()).toBe(false);
        expect(await textarea.inputValue()).toBe(draft);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await expectCount(page.getByText("Earlier reply", { exact: true }), 1);
        expect(await gateway.getRequests("chat.startup")).toHaveLength(startupCount);
        expect(await gateway.getRequests("models.list")).toHaveLength(2);
        expect(await gateway.getSocketCount()).toBe(socketCount);
      });
    },
  );

  it.each([1280, 390])(
    "keeps the saved preference through startup, fallback, reload, and recovery at %ipx",
    async (width) => {
      const artifactDir = suite.artifactDir;
      await suite.withPage(
        {
          viewport: { width, height: 900 },
          recordVideo:
            process.env.OPENCLAW_CAPTURE_UI_PROOF === "1" ? { dir: artifactDir } : undefined,
        },
        async ({ page }) => {
          const selectedModel = { id: "gpt-5.5", name: "GPT-5.5", provider: "codex" };
          const activeModel = { id: "qwen3.5:9b", name: "Qwen 3.5 9B", provider: "ollama" };
          const session = {
            key: "agent:main:fallback-recovery",
            sessionId: "fallback-recovery-session",
            kind: "direct",
            model: selectedModel.id,
            modelProvider: selectedModel.provider,
            status: "done",
            updatedAt: Date.now(),
          } satisfies GatewaySessionRow;
          const gateway = await installMockGateway(page, {
            sessionKey: session.key,
            agentModel: "codex/gpt-5.5",
            models: [selectedModel, activeModel],
            methodResponses: {
              "sessions.list": sessionList(selectedModel, [
                {
                  ...session,
                  activeModel: activeModel.id,
                  activeModelProvider: activeModel.provider,
                },
              ]),
            },
          });

          await page.goto(controlUiSessionUrl(suite.server.baseUrl, session.key));
          await gateway.waitForRequest("chat.startup");
          const composer = page.locator(".agent-chat__input");
          const trigger = composer.locator('[data-chat-model-select="true"]');
          const selected = modelOption(composer, "codex/gpt-5.5");

          await expectText(trigger, selectedModel.name);
          await composer.locator("textarea").click();
          await trigger.click();
          await expect.poll(() => selected.getAttribute("aria-selected")).toBe("true");
          await trigger.click();
          await page.screenshot({ path: `${artifactDir}/active-fallback-model.png` });
          await composer
            .locator(".agent-chat__composer-combobox textarea")
            .fill("Try the selected model again.");
          await gateway.deferNext("chat.send");
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          const send = await gateway.waitForRequest("chat.send");
          const runId = (send.params as { idempotencyKey: string }).idempotencyKey;
          await expectText(trigger, selectedModel.name);
          expect(await trigger.textContent()).not.toContain(activeModel.name);
          expect(await trigger.getAttribute("aria-busy")).toBe("false");
          expect(await trigger.locator(".btn__spinner").count()).toBe(0);
          await page.screenshot({ path: `${artifactDir}/send-admission-model.png` });
          await gateway.resolveDeferred("chat.send");
          await page.getByRole("button", { name: "Stop generating" }).waitFor();
          await expectText(trigger, selectedModel.name);
          expect(await trigger.textContent()).not.toContain("Model pending");
          expect(await trigger.getAttribute("aria-busy")).toBe("false");
          await page.screenshot({ path: `${artifactDir}/pending-executing-model.png` });
          const startedAt = Date.now();
          for (const [index, model] of [selectedModel, activeModel].entries()) {
            const running = {
              ...session,
              status: "running" as const,
              hasActiveRun: true,
              activeModel: model.id,
              activeModelProvider: model.provider,
              updatedAt: startedAt + index + 1,
            };
            await gateway.setSessionsListResponse(
              sessionList(selectedModel, [running], undefined, running.updatedAt),
            );
            await gateway.setMethodResponse("chat.history", {
              messages: [],
              sessionId: session.sessionId,
              sessionInfo: running,
              inFlightRun: { runId, text: "", startedAt },
            });
            await gateway.emitGatewayEvent("sessions.changed", {
              sessionKey: session.key,
              agentId: "main",
              phase: "model",
              runId,
              ...buildGatewaySessionSnapshot({
                sessionRow: running,
                agentId: "main",
                activeRunState: { active: true },
              }),
            });
            await expectText(trigger, selectedModel.name);
            await expect.poll(() => trigger.getAttribute("aria-busy")).toBe("false");
            expect(await trigger.locator(".btn__spinner").count()).toBe(0);
            expect(await selected.getAttribute("aria-selected")).toBe("true");
            await page.screenshot({
              path: `${artifactDir}/running-${index === 0 ? "primary" : "fallback"}-model.png`,
            });
          }
          await page.reload();
          await gateway.waitForRequest("chat.startup");
          await expectText(trigger, selectedModel.name);
          await composer.locator("textarea").click();
          await trigger.click();
          expect(await selected.getAttribute("aria-selected")).toBe("true");
          await trigger.click();
          await page.screenshot({ path: `${artifactDir}/refreshed-fallback-model.png` });
          const recovered = {
            ...session,
            hasActiveRun: false,
            activeRunIds: [],
            lastRunId: runId,
            updatedAt: Date.now() + 3,
          };
          const message = {
            role: "assistant",
            content: "The selected model recovered.",
            timestamp: recovered.updatedAt,
          };
          await gateway.setHistoryMessages([message]);
          await gateway.setMethodResponse("chat.history", {
            messages: [message],
            sessionId: session.sessionId,
            sessionInfo: recovered,
          });
          // Swarm child hydration shares sessions.list with the primary roster.
          // Hold all later replies so only the event/history can repair this label.
          const releaseLists = await page.evaluateHandle((row) => {
            const fixture = (
              window as Window & {
                openclawControlUiE2eGateway?: ControlUiMockGateway;
              }
            ).openclawControlUiE2eGateway;
            if (!fixture) {
              throw new Error("Mock Gateway is not installed");
            }
            const waiting: Array<() => void> = [];
            let released = false;
            const snapshot = {
              count: 1,
              defaults: { model: row.model, modelProvider: row.modelProvider },
              sessions: [row],
              path: "",
              ts: row.updatedAt,
            };
            fixture.setRequestHandler("sessions.list", ({ respond }) => {
              if (released) {
                respond(snapshot);
              } else {
                waiting.push(() => respond(snapshot));
              }
            });
            return () => {
              released = true;
              for (const respond of waiting.splice(0)) {
                respond();
              }
            };
          }, recovered);
          try {
            await gateway.setSessionsListResponse(
              sessionList(selectedModel, [recovered], undefined, recovered.updatedAt),
            );
            const historyBefore = (await gateway.getRequests("chat.history")).length;
            await gateway.emitGatewayEvent("chat", {
              runId,
              sessionKey: session.key,
              state: "final",
            });
            await gateway.emitGatewayEvent("session.message", {
              sessionKey: session.key,
              agentId: "main",
              message,
              messageId: "model-recovered",
              messageSeq: 1,
              ...buildGatewaySessionSnapshot({
                sessionRow: recovered,
                agentId: "main",
                activeRunState: { active: false, runIds: [] },
              }),
            });
            await gateway.waitForRequest("chat.history", { after: historyBefore });
            await page
              .getByRole("button", { name: "Stop generating" })
              .waitFor({ state: "hidden" });
            await page.locator(".chat-text").getByText(message.content, { exact: true }).waitFor();
            await expectText(trigger, selectedModel.name);
            expect(await selected.getAttribute("aria-selected")).toBe("true");
            await page.screenshot({ path: `${artifactDir}/recovered-model.png` });
          } finally {
            await releaseLists.evaluate((release) => release());
            await releaseLists.dispose();
          }
        },
      );
    },
  );

  it("refreshes the configured usable catalog after advertised chat metadata", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const models: ModelCatalogEntry[] = [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
        {
          id: "gpt-5.3-codex-spark",
          name: "GPT-5.3 Codex Spark",
          provider: "codex",
          available: false,
          unavailableReason: "missing-auth",
        },
      ];
      const gateway = await installMockGateway(page, {
        agentModel: "openai/gpt-5.3-codex-spark",
        models,
        methodResponses: {
          "chat.startup": {
            agentsList: {
              agents: [{ id: "main", name: "OpenClaw" }],
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
            },
            messages: [],
            sessionId: "session:agent:main:main",
            thinkingLevel: null,
          },
          "chat.metadata": {
            commands: [],
            models,
          },
          "sessions.list": {
            count: 1,
            defaults: {
              contextTokens: 200_000,
              model: "gpt-5.3-codex-spark",
              modelProvider: "openai",
            },
            path: "",
            sessions: [
              {
                contextTokens: 200_000,
                displayName: "Main",
                hasActiveRun: false,
                key: "main",
                kind: "direct",
                label: "Main",
                model: "gpt-5.5",
                modelProvider: "openai",
                status: "done",
                totalTokens: 0,
                updatedAt: Date.now(),
              },
            ],
            ts: Date.now(),
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.metadata");
      await gateway.waitForRequest("models.list");

      const composer = page.locator(".agent-chat__input");
      await composer.locator('[data-chat-model-select="true"]').click();
      const providers = composer.locator(
        "[data-chat-model-provider] .chat-controls__provider-label",
      );
      await expect
        .poll(async () => (await providers.allTextContents()).map((label) => label.trim()))
        .toEqual(["OpenAI"]);
      await expectText(composer.locator('[data-chat-model-provider-group="openai"]'), "GPT-5.5");
      await expectCount(composer.locator('[data-chat-model-provider-group="codex"]'), 0);
      // The advertised default stays visible as a setup action while the usable
      // model remains selectable.
      const unavailableDefault = composer.locator('[data-chat-model-default="true"]');
      await expectCount(unavailableDefault, 1);
      await expect.poll(() => unavailableDefault.getAttribute("disabled")).toBeNull();
      await expect
        .poll(() => unavailableDefault.getAttribute("data-chat-model-setup"))
        .toBe("true");
      await expectCount(composer.locator('[data-chat-model-option=""]'), 0);
    });
  });

  it("keeps an auth-cold configured catalog visible and blocks messages until setup", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const models = ["Sol", "Luna"].map((name) => ({
        id: `gpt-5.6-${name.toLowerCase()}`,
        name: `GPT-5.6 ${name}`,
        provider: "openai",
        contextWindow: 1_000_000,
        available: false,
        unavailableReason: "missing-auth" as const,
      }));
      const gateway = await installMockGateway(page, {
        agentModel: "openai/gpt-5.6-sol",
        models,
        methodResponses: {
          "sessions.list": sessionList(models[0]!, undefined, 200_000),
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("models.list");

      const composer = page.locator(".agent-chat__input");
      const textarea = composer.locator("textarea");
      const send = composer.getByRole("button", { name: "Send message", exact: true });
      const draft = "Continue our conversation.";
      await expect.poll(() => textarea.isDisabled()).toBe(false);
      await textarea.fill(draft);
      const picker = composer.locator("details.chat-controls__model-picker");
      const options = picker.locator(
        "button[data-chat-model-option]:not([data-chat-model-target])",
      );
      await picker.locator("summary").click();
      await gateway.waitForRequest("models.list");
      await expectCount(options, 2);
      await revealChatModelOption(picker, "openai/gpt-5.6-luna");
      await expectVisible(options.last());
      await expectText(options.first(), "GPT-5.6 Sol");
      await expectText(options.first(), "Default");
      await expect
        .poll(() =>
          options.evaluateAll((rows) =>
            rows.every((row) => {
              const warning = row.querySelector("[data-chat-model-auth-warning]");
              return (
                warning?.textContent?.trim() === "Sign-in needed" &&
                warning.querySelector("svg") !== null &&
                row.querySelector(".chat-controls__model-option-meta") === null &&
                !row.textContent?.includes("1M")
              );
            }),
          ),
        )
        .toBe(true);
      await expect
        .poll(() =>
          options.evaluateAll(
            (rows) =>
              rows.every((row) => !row.hasAttribute("disabled")) &&
              rows.every((row) => row.getAttribute("data-chat-model-setup") === "true"),
          ),
        )
        .toBe(true);
      await expectText(
        composer.locator(".chat-controls__model-catalog-state"),
        "No models available",
      );
      expect(await textarea.isDisabled()).toBe(false);
      expect(await textarea.inputValue()).toBe(draft);
      await expect.poll(() => send.isDisabled()).toBe(true);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await optionalCapture(page)("auth-cold-model-picker", composer);
      await selectChatModelOption(picker, "openai/gpt-5.6-sol", { default: true });
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-providers");
      expect(new URL(page.url()).searchParams.get("connect")).toBe("1");
    });
  });

  it("keeps the selected model visible while loading the next session's scoped catalog", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const workModel = availableModel("work-model", "Work Model", "openai");
      const otherModel = availableModel("other-model", "Other Model", "anthropic");
      const startupResponse = (sessionId: string, model: typeof workModel) => ({
        agentsList: {
          agents: [
            { id: "work", name: "Work" },
            { id: "other", name: "Other" },
          ],
          defaultId: "work",
          mainKey: "main",
          scope: "agent",
        },
        messages: [],
        metadata: { commands: [], models: [model] },
        sessionId,
        thinkingLevel: null,
      });
      const gateway = await installMockGateway(page, {
        defaultAgentId: "work",
        sessionKey: "agent:work:main",
        methodResponses: {
          "chat.startup": {
            cases: [
              {
                match: { sessionKey: "agent:work:main" },
                response: startupResponse("work-session", workModel),
              },
              {
                match: { sessionKey: "agent:other:main" },
                response: startupResponse("other-session", otherModel),
              },
            ],
          },
          "models.list": {
            cases: [
              {
                match: { agentId: "other", view: "configured" },
                response: { models: [otherModel] },
              },
            ],
          },
          "sessions.list": sessionList(
            otherModel,
            [
              sessionRow(workModel, { key: "agent:work:main" }),
              sessionRow(otherModel, { key: "agent:other:main" }),
            ],
            200_000,
          ),
        },
        models: [workModel],
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:work:main"));
      await gateway.waitForRequest("chat.startup");
      expect(await gateway.getRequests("chat.metadata")).toHaveLength(0);

      const activeComposer = () =>
        page.locator('openclaw-chat-pane[aria-hidden="false"] .agent-chat__input');
      await activeComposer().locator('[data-chat-model-select="true"]').click();
      await expect.poll(() => modelOption(activeComposer(), "openai/work-model").count()).toBe(1);
      await activeComposer().locator('[data-chat-model-select="true"]').click();
      await gateway.waitForRequest("models.list");

      await gateway.deferNext("chat.startup", { sessionKey: "agent:other:main" });
      await gateway.deferNext("models.list", { sessionKey: "agent:other:main" });
      await navigateToControlUiSession(page, "agent:other:main");
      await gateway.waitForRequest("chat.startup", { after: 1 });
      const targetModelTrigger = activeComposer().locator('[data-chat-model-select="true"]');
      await expectText(targetModelTrigger, "other-model");
      expect(await targetModelTrigger.getAttribute("aria-busy")).toBe("false");
      expect(
        await targetModelTrigger.locator(".chat-controls__model-trigger-skeleton").count(),
      ).toBe(0);
      expect(await activeComposer().locator("[data-chat-model-option]").count()).toBe(0);
      expect(
        await activeComposer()
          .locator('.chat-controls__effort-picker:not([aria-hidden="true"])')
          .count(),
      ).toBe(0);
      if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim()) {
        await activeComposer().screenshot({
          animations: "disabled",
          path: `${suite.artifactDir}/selected-model-during-session-startup.png`,
        });
      }
      await gateway.resolveDeferred("chat.startup");
      expect(await activeComposer().locator("[data-chat-model-option]").count()).toBe(0);
      await gateway.resolveDeferred("models.list");
      const startupRequests = await gateway.getRequests("chat.startup");
      expect(
        startupRequests.filter(
          (request) =>
            (request.params as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:other:main",
        ),
      ).toHaveLength(1);
      expect(await gateway.getRequests("chat.metadata")).toHaveLength(0);
      await targetModelTrigger.click();
      await expect
        .poll(() => modelOption(activeComposer(), "anthropic/other-model").count())
        .toBe(1);
      const modelSearch = activeComposer().locator("[data-chat-model-search]");
      await modelSearch.fill("openai/work-model");
      await expectVisible(activeComposer().locator("[data-chat-model-search-empty]"));
      await expect.poll(() => modelOption(activeComposer(), "openai/work-model").count()).toBe(0);
      await modelSearch.clear();
      await expectVisible(modelOption(activeComposer(), "anthropic/other-model"));
      await gateway.waitForRequest("models.list");
    });
  });

  it("keeps published models visible and retries a failed publication read on reopen", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const startupModel = availableModel("startup-model", "Startup Model", "openai");
      const discoveredModel = availableModel("discovered-model", "Discovered Model", "anthropic");
      const gateway = await installMockGateway(page, {
        models: [startupModel],
        methodResponses: {
          "models.list": {
            sequence: [
              { models: [startupModel] },
              {
                __mockError: {
                  code: "UNAVAILABLE",
                  message: "catalog discovery failed",
                },
              },
              { models: [startupModel, discoveredModel] },
            ],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await gateway.waitForRequest("models.list");

      const composer = page.locator(".agent-chat__input");
      await composer.locator('[data-chat-model-select="true"]').click();
      await revealChatModelOption(composer, "openai/startup-model");
      expect(await gateway.getRequests("models.list")).toHaveLength(1);
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
      await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(2);
      await expectText(
        composer.locator("[data-chat-model-catalog-state]"),
        "Some models could not be refreshed.",
      );
      await expectVisible(modelOption(composer, "openai/startup-model"));

      await composer.locator('[data-chat-model-select="true"]').click();
      await composer.locator('[data-chat-model-select="true"]').click();

      await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(3);
      await revealChatModelOption(composer, "anthropic/discovered-model");
      await expect
        .poll(() => modelOption(composer, "anthropic/discovered-model").isVisible())
        .toBe(true);
      expect(await composer.locator("[data-chat-model-catalog-state]").count()).toBe(0);
      for (const request of await gateway.getRequests("models.list")) {
        expect(request.params).toEqual(expect.objectContaining({ view: "configured" }));
        expect(request.params).not.toEqual(expect.objectContaining({ preparedOnly: true }));
      }
    });
  });

  it("retires an empty picker snapshot when the Gateway reconnects", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const routedModel = availableModel("gpt-5.6-luna", "GPT-5.6 Luna", "openai");
      const gateway = await installMockGateway(page, {
        agentModel: "openai/gpt-5.6-luna",
        models: [routedModel],
        methodResponses: {
          "chat.metadata": {
            sequence: [
              { commands: [], models: [] },
              { commands: [], models: [routedModel] },
            ],
          },
          "models.list": {
            sequence: [{ models: [] }, { models: [routedModel] }],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const composer = page.locator(".agent-chat__input");
      const pickerTrigger = composer.locator('[data-chat-model-select="true"]');
      await pickerTrigger.click();
      await gateway.waitForRequest("models.list");
      await expectText(composer.locator("[data-chat-model-catalog-state]"), "No models available");
      const capture = optionalCapture(page);
      await capture("01-empty-catalog-before-reconnect");
      await pickerTrigger.click();

      const startupCount = (await gateway.getRequests("chat.startup")).length;
      await gateway.setOnline(false);
      await expect.poll(() => pickerTrigger.getAttribute("aria-disabled")).toBe("true");
      await gateway.setOnline(true);
      await gateway.waitForRequest("chat.startup", { after: startupCount });

      await pickerTrigger.click();
      expect(await gateway.getRequests("models.list")).toHaveLength(2);
      await revealChatModelOption(composer, "openai/gpt-5.6-luna");
      await expectCount(modelOption(composer, "openai/gpt-5.6-luna"), 1);
      await expectVisible(modelOption(composer, "openai/gpt-5.6-luna"));
      await expectCount(composer.locator("[data-chat-model-catalog-state]"), 0);
      await capture("02-routable-model-after-reconnect");
    });
  });

  it("reuses the account catalog on reopen and follows publications without provider discovery", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const existing = { id: "existing", name: "Existing", provider: "example", available: true };
      const firstOpen = availableModel("first-open", "First open", "example");
      const published = availableModel("published", "Published", "example");
      const gateway = await installMockGateway(page, {
        models: [existing],
        sessionKey: "agent:main:main",
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      const composer = page.locator(".agent-chat__input");
      const picker = composer.locator("details.chat-controls__model-picker");
      const trigger = composer.locator('[data-chat-model-select="true"]');
      await gateway.setMethodResponse("models.list", { models: [existing, firstOpen] });
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
      await trigger.click();
      await revealChatModelOption(composer, "example/existing");
      await expectCount(modelOption(composer, "example/existing"), 1);
      await revealChatModelOption(composer, "example/first-open");
      await expectVisible(modelOption(composer, "example/first-open"));
      await gateway.setMethodResponse("models.list", { models: [existing, firstOpen, published] });
      const refreshBaseline = await gateway.deferNext("models.list", {
        agentId: "main",
        sessionKey: "agent:main:main",
      });
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
      await gateway.waitForRequest("models.list", { after: refreshBaseline });
      const previousRequestCount = (await gateway.getRequests("models.list")).length;

      const reopened = await picker.evaluate(
        async (details: HTMLDetailsElement, models) => {
          const pane = details.closest<HTMLElement & { updateComplete: Promise<boolean> }>(
            "openclaw-chat-pane",
          );
          const summary = details.querySelector<HTMLElement>(":scope > summary");
          if (!pane || !summary) {
            throw new Error("Expected the native picker and its chat pane");
          }
          // SAFETY: installMockGateway installs this typed browser fixture before navigation.
          const mockGateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
          if (!mockGateway) {
            throw new Error("Expected the mock Gateway publication owner");
          }
          if (document.visibilityState !== "visible") {
            throw new Error("Expected a visible document before native picker activation");
          }
          await pane.updateComplete;
          if (!details.open || !details.isConnected) {
            throw new Error("Expected the first-open catalog to remain rendered");
          }
          const listeners = new Set<() => void>();
          const nextToggle = () =>
            new Promise<void>((resolve) => {
              const listener = () => {
                listeners.delete(listener);
                resolve();
              };
              listeners.add(listener);
              details.addEventListener("toggle", listener, { once: true });
            });
          try {
            const closed = nextToggle();
            summary.click();
            if (details.open) {
              throw new Error("Expected native close activation to close the picker");
            }
            await closed;
            const opened = nextToggle();
            summary.click();
            if (!details.open) {
              throw new Error("Expected native reopen activation to open the picker");
            }
            // A catalog publication must preserve native open before its queued toggle publishes.
            mockGateway.resolveDeferred(
              "models.list",
              { models },
              { match: { agentId: "main", sessionKey: "agent:main:main" } },
            );
            await pane.updateComplete;
            await opened;
            return { open: details.open, connected: details.isConnected };
          } finally {
            for (const listener of listeners) {
              details.removeEventListener("toggle", listener);
            }
          }
        },
        [existing, { ...firstOpen, name: "First open republished" }],
      );

      expect(reopened).toEqual({ open: true, connected: true });
      expect(await gateway.getRequests("models.list")).toHaveLength(previousRequestCount);
      await revealChatModelOption(composer, "example/first-open");
      expect(await modelOption(composer, "example/first-open").isVisible()).toBe(true);
      await expectText(modelOption(composer, "example/first-open"), "First open republished");
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
      await gateway.waitForRequest("models.list", { after: previousRequestCount });
      await expectVisible(modelOption(composer, "example/published"));
      expect(await gateway.getRequests("models.list")).toHaveLength(previousRequestCount + 1);
      for (const request of await gateway.getRequests("models.list")) {
        expect(request.params).toMatchObject({
          view: "configured",
          agentId: "main",
          sessionKey: "agent:main:main",
        });
        expect(request.params).not.toHaveProperty("refresh");
      }
    });
  });
});
