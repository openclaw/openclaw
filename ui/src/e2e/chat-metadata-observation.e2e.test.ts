import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI metadata observation" });
const sessionKeys = [
  "agent:main:metadata-a",
  "agent:main:metadata-b",
  "agent:main:metadata-c",
] as const;
const model = { id: "model", name: "Initial model", provider: "example" };
const freshModel = { ...model, name: "Updated model" };
const methods = ["chat.metadata", "models.list"] as const;

function sessionsResponse() {
  return {
    count: sessionKeys.length,
    defaults: { model: model.id, modelProvider: model.provider },
    path: "",
    sessions: sessionKeys.map((key, index) => ({
      key,
      kind: "direct",
      label: `Metadata ${index + 1}`,
      updatedAt: sessionKeys.length - index,
      model: model.id,
      modelProvider: model.provider,
    })),
    ts: 1,
  };
}

async function expectCatalog(pane: Locator, name: string) {
  await expect
    .poll(() => pane.locator('[data-chat-model-option="example/model"]').textContent())
    .toContain(name);
}

async function requestCounts(gateway: MockGatewayControls) {
  return Object.fromEntries(
    await Promise.all(
      methods.map(async (method) => [method, (await gateway.getRequests(method)).length]),
    ),
  );
}

async function seedSharedSessionPanes(page: Page) {
  await page.addInitScript(
    ({ settingsKey, sessionKey }) => {
      localStorage.setItem(
        settingsKey,
        JSON.stringify({
          chatSplitLayout: {
            activePaneId: "p1",
            columns: ["p1", "p2"].map((id, index) => ({
              id: `c${index + 1}`,
              panes: [{ id, sessionKey }],
              paneWeights: [1],
            })),
            columnWeights: [0.5, 0.5],
          },
        }),
      );
    },
    {
      settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
      sessionKey: sessionKeys[0],
    },
  );
}

async function setDocumentVisibility(page: Page, visibility: DocumentVisibilityState) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visibility);
}

suite.define(() => {
  it.each([
    { paneCount: 1, wake: "early" },
    { paneCount: 1, wake: "late" },
    { paneCount: 2, wake: "late" },
  ])(
    "delivers the cold catalog after visibility returns while commands remain pending ($paneCount panes, $wake wakeup)",
    async ({ paneCount, wake }) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        if (paneCount === 2) {
          await seedSharedSessionPanes(page);
        }
        const gateway = await installMockGateway(page, {
          sessionKey: sessionKeys[0],
          models: [model],
          deferredMethods: [
            "models.list",
            "chat.metadata",
            ...(wake === "early" ? ["chat.startup"] : []),
          ],
          methodResponses: {
            "sessions.list": sessionsResponse(),
            "chat.startup": {
              sessionId: "metadata-session",
              sessionInfo: { key: sessionKeys[0], kind: "direct" },
              messages: [],
              thinkingLevel: null,
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKeys[0]));
        const panes = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        await expect.poll(() => panes.count()).toBe(paneCount);
        await gateway.waitForRequest("models.list");
        if (wake === "early") {
          await setDocumentVisibility(page, "hidden");
          await setDocumentVisibility(page, "visible");
          await gateway.resolveDeferred("chat.startup");
        }
        await expect
          .poll(() =>
            panes.evaluateAll((nodes) =>
              nodes.map(
                (pane) =>
                  (pane as HTMLElement & { state: { chatLoading: boolean } }).state.chatLoading,
              ),
            ),
          )
          .toEqual(Array.from({ length: paneCount }, () => false));
        await gateway.waitForRequest("chat.metadata");
        if (wake === "late") {
          await setDocumentVisibility(page, "hidden");
          await setDocumentVisibility(page, "visible");
        }
        await gateway.resolveDeferred("models.list");
        for (const pane of await panes.all()) {
          await expectCatalog(pane, model.name);
          await expect
            .poll(() =>
              pane
                .locator(".chat-controls__model-picker [data-chat-model-select]")
                .getAttribute("aria-disabled"),
            )
            .toBe("false");
        }
        expect(await gateway.getRequests("models.list")).toHaveLength(1);
        expect(await gateway.getRequests("chat.metadata")).toHaveLength(1);
        await gateway.resolveDeferred("chat.metadata");
      });
    },
  );

  it.each(["config.changed", "chat.metadata.changed"])(
    "refreshes only the presented retained pane on %s and catches up on activation",
    async (event) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: sessionKeys[0],
          models: [model],
          methodResponses: { "sessions.list": sessionsResponse() },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKeys[0]));
        for (const [index, key] of sessionKeys.entries()) {
          if (index > 0) {
            await page.locator(`.sidebar-recent-session[data-session-key="${key}"] a`).click();
          }
          await expect.poll(() => page.locator("openclaw-chat-pane").count()).toBe(index + 1);
          await expectCatalog(page.locator('openclaw-chat-pane[aria-hidden="false"]'), model.name);
        }
        const visible = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        const draft = visible.locator(".agent-chat__composer-combobox textarea");
        await draft.fill("Retain this draft");
        const before = await requestCounts(gateway);
        const proof =
          process.env.OPENCLAW_UI_E2E_RECORD === "1"
            ? createControlUiE2eArtifactDir(`chat-metadata-${event}`)
            : undefined;
        if (proof) {
          await page.screenshot({ path: path.join(proof, "before.png") });
        }
        await gateway.setMethodResponse("models.list", { models: [freshModel] });
        await gateway.emitGatewayEvent(event, {});
        await expectCatalog(visible, freshModel.name);
        const after = await requestCounts(gateway);
        if (proof) {
          await page.screenshot({ path: path.join(proof, "after.png") });
          await writeFile(
            path.join(proof, "requests.json"),
            `${JSON.stringify({ event, before, after }, null, 2)}\n`,
          );
        }
        expect(after).toEqual({
          "chat.metadata": before["chat.metadata"] + 1,
          "models.list": before["models.list"] + 1,
        });
        expect(await draft.inputValue()).toBe("Retain this draft");

        await page
          .locator(`.sidebar-recent-session[data-session-key="${sessionKeys[0]}"] a`)
          .click();
        await expect
          .poll(() =>
            visible.evaluate((node) => (node as HTMLElement & { sessionKey: string }).sessionKey),
          )
          .toBe(sessionKeys[0]);
        await expectCatalog(
          page.locator('openclaw-chat-pane[aria-hidden="false"]'),
          freshModel.name,
        );
        expect(await requestCounts(gateway)).toEqual({
          "chat.metadata": after["chat.metadata"] + 1,
          "models.list": after["models.list"] + 1,
        });
      });
    },
  );

  it("invalidates a shared session once when two split panes receive the same patch", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await seedSharedSessionPanes(page);
      const gateway = await installMockGateway(page, {
        sessionKey: sessionKeys[0],
        models: [model],
        methodResponses: { "sessions.list": sessionsResponse() },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKeys[0]));
      const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
      await expect.poll(() => panes.count()).toBe(2);
      await Promise.all([
        expectCatalog(panes.nth(0), model.name),
        expectCatalog(panes.nth(1), model.name),
      ]);
      const before = await requestCounts(gateway);
      await gateway.setMethodResponse("models.list", { models: [freshModel] });
      await gateway.emitGatewayEvent("sessions.changed", {
        key: sessionKeys[0],
        agentId: "main",
        reason: "patch",
      });
      await Promise.all([
        expectCatalog(panes.nth(0), freshModel.name),
        expectCatalog(panes.nth(1), freshModel.name),
      ]);
      expect(await requestCounts(gateway)).toEqual({
        "chat.metadata": before["chat.metadata"] + 1,
        "models.list": before["models.list"] + 1,
      });
    });
  });

  it("recovers omitted follower startup commands without duplicating its pending catalog", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey: sessionKeys[0],
        models: [model],
        methodResponses: { "sessions.list": sessionsResponse() },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKeys[0]));
      const panes = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      await expectCatalog(panes, model.name);
      const before = await requestCounts(gateway);
      for (const method of methods) {
        await gateway.deferNext(method);
      }
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
      for (const method of methods) {
        await gateway.waitForRequest(method, { after: before[method] });
      }
      await gateway.setMethodResponse("chat.startup", {
        sessionId: "metadata-session",
        sessionInfo: { key: sessionKeys[0], kind: "direct" },
        messages: [],
        thinkingLevel: null,
      });
      await gateway.setMethodResponse("chat.metadata", {
        commands: [
          {
            name: "recovered-metadata",
            description: "Recovered startup commands",
            source: "native",
            scope: "text",
            acceptsArgs: false,
          },
        ],
      });
      const startupsBefore = (await gateway.getRequests("chat.startup")).length;
      await page.getByRole("button", { name: "Open split view", exact: true }).click();
      await expect.poll(() => panes.count()).toBe(2);
      await gateway.waitForRequest("chat.startup", { after: startupsBefore });
      await gateway.resolveDeferred("chat.metadata");
      const composer = panes.nth(1).locator(".agent-chat__composer-combobox textarea");
      await composer.fill("/recovered-metadata");
      await expect
        .poll(() =>
          panes
            .nth(1)
            .getByRole("option", { name: /recovered-metadata/u })
            .count(),
        )
        .toBe(1);
      expect(await requestCounts(gateway)).toEqual({
        "chat.metadata": before["chat.metadata"] + 2,
        "models.list": before["models.list"] + 1,
      });
      await gateway.resolveDeferred("models.list");
      for (const pane of await panes.all()) {
        await expectCatalog(pane, model.name);
      }
    });
  });

  it.each([
    "single",
    "shared",
    "late follower",
    "late follower without metadata",
    "late follower without metadata, metadata first",
    "late follower, catalog first",
  ])("coalesces invalidations behind an unfinished pair (%s)", async (presentation) => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const paneCount = presentation === "shared" ? 2 : 1;
      if (presentation === "shared") {
        await seedSharedSessionPanes(page);
      }
      const gateway = await installMockGateway(page, {
        sessionKey: sessionKeys[0],
        models: [model],
        methodResponses: { "sessions.list": sessionsResponse() },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKeys[0]));
      const panes = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      await expect.poll(() => panes.count()).toBe(paneCount);
      for (const pane of await panes.all()) {
        await expectCatalog(pane, model.name);
      }
      const before = await requestCounts(gateway);
      for (const method of methods) {
        await gateway.deferNext(method);
      }
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
      for (const method of methods) {
        await gateway.waitForRequest(method, { after: before[method] });
      }
      await gateway.setMethodResponse("models.list", { models: [freshModel] });
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
      if (presentation.includes("without metadata")) {
        await gateway.setMethodResponse("chat.startup", {
          sessionId: "metadata-session",
          sessionInfo: { key: sessionKeys[0], kind: "direct" },
          messages: [],
          thinkingLevel: null,
        });
      }
      if (presentation.startsWith("late follower")) {
        await page.getByRole("button", { name: "Open split view", exact: true }).click();
        await expect.poll(() => panes.count()).toBe(2);
      }
      expect(await requestCounts(gateway)).toEqual({
        "chat.metadata": before["chat.metadata"] + 1,
        "models.list": before["models.list"] + 1,
      });
      const first = presentation.endsWith("metadata first")
        ? "chat.metadata"
        : presentation.endsWith("catalog first")
          ? "models.list"
          : undefined;
      if (first) {
        await gateway.resolveDeferred(first);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            }),
        );
        expect(await requestCounts(gateway)).toEqual({
          "chat.metadata": before["chat.metadata"] + 1,
          "models.list": before["models.list"] + 1,
        });
      }
      for (const method of methods) {
        if (method !== first) {
          await gateway.resolveDeferred(method);
        }
      }
      for (const pane of await panes.all()) {
        await expectCatalog(pane, freshModel.name);
      }
      expect(await requestCounts(gateway)).toEqual({
        "chat.metadata":
          before["chat.metadata"] +
          (presentation.startsWith("late follower") && !presentation.includes("without metadata")
            ? 1
            : 2),
        "models.list": before["models.list"] + 2,
      });
    });
  });

  it("redeems document-hidden invalidations once when the document becomes visible", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey: sessionKeys[0],
        models: [model],
        methodResponses: { "sessions.list": sessionsResponse() },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKeys[0]));
      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      await expectCatalog(pane, model.name);
      const before = await requestCounts(gateway);
      await setDocumentVisibility(page, "hidden");
      await gateway.setMethodResponse("models.list", { models: [freshModel] });
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
      expect(await requestCounts(gateway)).toEqual(before);
      await setDocumentVisibility(page, "visible");
      await expectCatalog(pane, freshModel.name);
      expect(await requestCounts(gateway)).toEqual({
        "chat.metadata": before["chat.metadata"] + 1,
        "models.list": before["models.list"] + 1,
      });
    });
  });

  it("keeps a hidden global pane's metadata idle through shared agent selection", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const sessions = sessionsResponse();
      const roster = {
        ...sessions,
        count: sessions.count + 1,
        sessions: [
          ...sessions.sessions,
          {
            key: "global",
            kind: "global",
            label: "Global",
            updatedAt: 1,
            model: model.id,
            modelProvider: model.provider,
          },
        ],
      };
      const gateway = await installMockGateway(page, {
        sessionKey: "global",
        sessionScope: "global",
        models: [model],
        methodResponses: {
          "agents.list": {
            agents: [
              { id: "main", name: "Main" },
              { id: "work", name: "Work" },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "global",
          },
          "agent.identity.get": {
            cases: ["main", "work"].map((agentId) => ({
              match: { agentId },
              response: { agentId, name: agentId, avatar: "", avatarStatus: "none" },
            })),
          },
          "sessions.list": roster,
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await expectCatalog(page.locator('openclaw-chat-pane[aria-hidden="false"]'), model.name);
      await page.locator(`.sidebar-recent-session[data-session-key="${sessionKeys[0]}"] a`).click();
      await expect.poll(() => page.locator("openclaw-chat-pane").count()).toBe(2);
      const hidden = page.locator('openclaw-chat-pane[aria-hidden="true"]');
      await expect
        .poll(() =>
          hidden.evaluate(
            (pane) => (pane as HTMLElement & { state: { sessionKey: string } }).state.sessionKey,
          ),
        )
        .toBe("global");
      await gateway.setMethodResponse("models.list", { models: [freshModel] });
      await page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime: { context: { agentSelection: { set: (agent: string) => void } } };
        };
        app.runtime.context.agentSelection.set("work");
      });
      await expect
        .poll(() =>
          hidden.evaluate(
            (pane) =>
              (pane as HTMLElement & { state: { assistantAgentId: string } }).state
                .assistantAgentId,
          ),
        )
        .toBe("work");
      for (const method of methods) {
        expect(
          await gateway.getRequests(method, { agentId: "work", sessionKey: "global" }),
        ).toHaveLength(0);
      }
    });
  });
});
