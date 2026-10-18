import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { ModelCatalogEntry } from "../api/types.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
  type MockGatewayControls,
  type ControlUiMockGatewayScenario,
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
    sessions: sessionKeys.map((key: string, index) => ({
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

type ObservedPaneState = {
  chatModelCatalog: ModelCatalogEntry[];
  chatLoading: boolean;
  sessionKey: string;
  assistantAgentId: string;
};
function readPaneState<K extends keyof ObservedPaneState>(pane: Locator, key: K) {
  return pane.evaluate(
    (element, field) => (element as HTMLElement & { state: ObservedPaneState }).state[field],
    key,
  );
}
async function expectCatalog(pane: Locator, name: string) {
  // Opening the picker could conceal a missed publication.
  await expect
    .poll(
      async () =>
        (await readPaneState(pane, "chatModelCatalog")).find(
          (entry) => entry.provider === "example" && entry.id === "model",
        )?.name,
    )
    .toBe(name);
}

async function requestCounts(gateway: MockGatewayControls) {
  const [metadata, catalog] = await Promise.all([
    gateway.getRequests("chat.metadata"),
    gateway.getRequests("models.list"),
  ]);
  return { "chat.metadata": metadata.length, "models.list": catalog.length };
}

async function seedSharedSessionPanes(page: Page) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    controlUiBundledSettingsStorageKey(suite.server.baseUrl),
    JSON.stringify({
      chatSplitLayout: {
        activePaneId: "p1",
        columns: ["p1", "p2"].map((id, index) => ({
          id: `c${index + 1}`,
          panes: [{ id, sessionKey: sessionKeys[0] }],
          paneWeights: [1],
        })),
        columnWeights: [0.5, 0.5],
      },
    }),
  ] as const);
}

async function setDocumentVisibility(page: Page, visibility: DocumentVisibilityState) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visibility);
}

async function openMetadata(
  page: Page,
  overrides: ControlUiMockGatewayScenario = {},
  route = controlUiSessionUrl(suite.server.baseUrl, sessionKeys[0]),
) {
  const gateway = await installMockGateway(page, {
    sessionKey: sessionKeys[0],
    models: [model],
    ...overrides,
    methodResponses: { "sessions.list": sessionsResponse(), ...overrides.methodResponses },
  });
  await page.goto(route);
  return { gateway, panes: page.locator('openclaw-chat-pane[aria-hidden="false"]') };
}
async function deferRefresh(gateway: MockGatewayControls) {
  const before = await requestCounts(gateway);
  for (const method of methods) {
    await gateway.deferNext(method);
  }
  await gateway.emitGatewayEvent("chat.metadata.changed", {});
  for (const method of methods) {
    await gateway.waitForRequest(method, { after: before[method] });
  }
  return before;
}
const withPage = (run: Parameters<typeof suite.withPage>[1]) =>
  suite.withPage({ viewport: { width: 1440, height: 900 } }, run);
const countsAfter = (
  before: Record<(typeof methods)[number], number>,
  metadata: number,
  catalog: number,
) => ({
  "chat.metadata": before["chat.metadata"] + metadata,
  "models.list": before["models.list"] + catalog,
});
async function expectCatalogs(panes: Locator, name: string) {
  for (const pane of await panes.all()) {
    await expectCatalog(pane, name);
  }
}
function startup(metadata = false) {
  return {
    sessionId: "metadata-session",
    sessionInfo: { key: sessionKeys[0], kind: "direct" },
    messages: [],
    thinkingLevel: null,
    ...(metadata ? { metadata: { commands: [], models: [model] } } : {}),
  };
}

suite.define(() => {
  it.each([
    { paneCount: 1, wake: "early" },
    { paneCount: 1, wake: "late" },
    { paneCount: 2, wake: "late" },
  ])(
    "delivers the cold catalog after visibility returns while commands remain pending ($paneCount panes, $wake wakeup)",
    async ({ paneCount, wake }) => {
      await withPage(async ({ page }) => {
        if (paneCount === 2) {
          await seedSharedSessionPanes(page);
        }
        const { gateway, panes } = await openMetadata(page, {
          deferredMethods: [
            "models.list",
            "chat.metadata",
            ...(wake === "early" ? ["chat.startup"] : []),
          ],
          methodResponses: {
            "chat.startup": startup(),
          },
        });
        await expect.poll(() => panes.count()).toBe(paneCount);
        await gateway.waitForRequest("models.list");
        if (wake === "early") {
          await gateway.waitForRequest("chat.startup");
          await setDocumentVisibility(page, "hidden");
          await setDocumentVisibility(page, "visible");
          await gateway.resolveDeferred("chat.startup");
        }
        await expect
          .poll(async () =>
            Promise.all((await panes.all()).map((pane) => readPaneState(pane, "chatLoading"))),
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
      await withPage(async ({ page }) => {
        const { gateway } = await openMetadata(page);
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
        await gateway.setMethodResponse("models.list", { models: [freshModel] });
        await gateway.emitGatewayEvent(event, {});
        await expectCatalog(visible, freshModel.name);
        const after = await requestCounts(gateway);
        expect(after).toEqual(countsAfter(before, 1, 1));
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
        expect(await requestCounts(gateway)).toEqual(countsAfter(after, 1, 1));
      });
    },
  );

  it.each(["patch", "command-metadata"])(
    "coalesces a burst of %s events into one catalog refresh without reloading auth",
    async (reason) => {
      await withPage(async ({ page }) => {
        await seedSharedSessionPanes(page);
        const runtimeChoice = {
          agentRuntime: { id: "alternate", source: "model" },
          available: true,
        };
        const { gateway } = await openMetadata(page, {
          methodResponses: {
            "chat.startup": { ...startup(true), sessionInfo: sessionsResponse().sessions[0] },
            "chat.metadata": { commands: [] },
            "models.list": {
              models: [
                {
                  ...model,
                  manualSelectionAllowed: true,
                  runtimeChoices: [{ ...runtimeChoice, manualSelectionAllowed: true }],
                },
              ],
            },
            "sessions.describe": { session: sessionsResponse().sessions[0] },
          },
        });
        const splitPanes = page.locator("openclaw-chat-pane.chat-split-view__pane");
        await expect.poll(() => splitPanes.count()).toBe(2);
        await expectCatalogs(splitPanes, model.name);
        await gateway.waitForRequest("models.authStatus");
        await page.clock.install();
        await pauseVirtualClock(page);
        const before = await requestCounts(gateway);
        const authBefore = (await gateway.getRequests("models.authStatus")).length;
        // Lineage owns separate key-only describe reads; count this pane's scoped facts.
        const sessionFacts = () =>
          gateway.getRequests("sessions.describe", { key: sessionKeys[0], agentId: "main" });
        const factsBefore = (await sessionFacts()).length;
        const changeSession = (extra = {}) =>
          gateway.emitGatewayEvent("sessions.changed", {
            key: sessionKeys[0],
            agentId: "main",
            reason,
            ...extra,
          });
        for (let index = 0; index < 5; index++) {
          await changeSession();
          await page.clock.runFor(500);
        }
        expect.soft(await requestCounts(gateway)).toEqual(before);
        expect(await sessionFacts()).toHaveLength(factsBefore);
        await page.clock.runFor(2_500);
        expect.soft(await requestCounts(gateway)).toEqual(countsAfter(before, 0, 1));
        expect(await gateway.getRequests("models.authStatus")).toHaveLength(authBefore);
        expect(await sessionFacts()).toHaveLength(factsBefore + 2);
        await expectCatalogs(splitPanes, model.name);

        await setDocumentVisibility(page, "hidden");
        const visibleCounts = await requestCounts(gateway);
        await changeSession();
        await page.clock.runFor(3_000);
        expect(await requestCounts(gateway)).toEqual(visibleCounts);
        expect(await sessionFacts()).toHaveLength(factsBefore + 2);
        await setDocumentVisibility(page, "visible");
        await page.clock.runFor(100);
        expect(await requestCounts(gateway)).toEqual(countsAfter(visibleCounts, 0, 1));

        // The direct catalog refresh catches unmarked selection changes. Explicit
        // selections carry the owner's hint and refresh before the debounce elapses.
        for (const catalogChanged of [false, true]) {
          const selectedModel = catalogChanged ? { ...model, name: "Selected model" } : freshModel;
          await gateway.setMethodResponse("models.list", {
            models: [selectedModel],
            accountSelection: {
              kind: "shared",
              authProfileId: "fixture:replacement",
              label: "Replacement account",
              source: "user",
            },
          });
          const beforeAccount = await requestCounts(gateway);
          await changeSession(catalogChanged ? { catalogChanged: true } : {});
          await page.clock.runFor(catalogChanged ? 100 : 3_000);
          await expectCatalogs(splitPanes, selectedModel.name);
          expect(await requestCounts(gateway)).toEqual(countsAfter(beforeAccount, 0, 1));
        }
        expect(await gateway.getRequests("models.authStatus")).toHaveLength(authBefore);
      });
    },
  );

  it("recovers omitted follower startup commands without duplicating its pending catalog", async () => {
    await withPage(async ({ page }) => {
      const { gateway, panes } = await openMetadata(page);
      await expectCatalog(panes, model.name);
      const before = await deferRefresh(gateway);
      await gateway.setMethodResponse("chat.startup", startup());
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
      await selectChatLayoutAction(page, "Open split view");
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
      expect(await requestCounts(gateway)).toEqual(countsAfter(before, 2, 1));
      await gateway.resolveDeferred("models.list");
      await expectCatalogs(panes, model.name);
    });
  });

  it.each([
    ["single", 1, null, undefined],
    ["shared", 2, null, undefined],
    ["late follower", 1, true, undefined],
    ["late follower without metadata", 1, false, undefined],
    ["late follower without metadata, metadata first", 1, false, "chat.metadata"],
    ["late follower, catalog first", 1, true, "models.list"],
  ] as const)(
    "coalesces fresh catalog reads after pending work (%s)",
    async (_label, paneCount, metadata, first) => {
      await withPage(async ({ page }) => {
        if (paneCount === 2) {
          await seedSharedSessionPanes(page);
        }
        const { gateway, panes } = await openMetadata(page);
        await expect.poll(() => panes.count()).toBe(paneCount);
        await expectCatalogs(panes, model.name);
        const before = await deferRefresh(gateway);
        const pendingCatalogCount = await gateway.deferNext("models.list");
        const resolvePending = (method: (typeof methods)[number]) =>
          gateway.resolveDeferred(
            method,
            method === "models.list"
              ? { models: [{ ...model, name: "Retired model" }] }
              : undefined,
          );
        await gateway.setMethodResponse("models.list", { models: [freshModel] });
        await gateway.emitGatewayEvent("chat.metadata.changed", {});
        await gateway.emitGatewayEvent("chat.metadata.changed", {});
        if (metadata !== null) {
          await gateway.setMethodResponse("chat.startup", startup(metadata));
          await selectChatLayoutAction(page, "Open split view");
          await expect.poll(() => panes.count()).toBe(2);
        }
        expect(await requestCounts(gateway)).toEqual(countsAfter(before, 1, 1));
        if (first) {
          await resolvePending(first);
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() => resolve());
              }),
          );
          expect(await requestCounts(gateway)).toEqual(countsAfter(before, 1, 1));
        }
        for (const method of methods) {
          if (method !== first) {
            await resolvePending(method);
          }
        }
        await gateway.waitForRequest("models.list", { after: pendingCatalogCount });
        expect(await gateway.getRequests("models.list")).toHaveLength(before["models.list"] + 2);
        await expectCatalogs(panes, model.name);
        await gateway.resolveDeferred("models.list");
        await expectCatalogs(panes, freshModel.name);
        expect(await requestCounts(gateway)).toEqual(
          countsAfter(before, metadata === true ? 1 : 2, 2),
        );
      });
    },
  );

  it("redeems document-hidden invalidations once when the document becomes visible", async () => {
    await withPage(async ({ page }) => {
      const { gateway } = await openMetadata(page);
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
      expect(await requestCounts(gateway)).toEqual(countsAfter(before, 1, 1));
    });
  });

  it("keeps a hidden global pane's metadata idle through shared agent selection", async () => {
    await withPage(async ({ page }) => {
      const roster = sessionsResponse();
      roster.sessions.push({
        ...roster.sessions[0]!,
        key: "global",
        kind: "global",
        label: "Global",
        updatedAt: 1,
      });
      roster.count++;
      const { gateway, panes } = await openMetadata(
        page,
        {
          sessionKey: "global",
          sessionScope: "global",
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
        },
        `${suite.server.baseUrl}chat`,
      );
      await expectCatalog(panes, model.name);
      await page.locator(`.sidebar-recent-session[data-session-key="${sessionKeys[0]}"] a`).click();
      await expect.poll(() => page.locator("openclaw-chat-pane").count()).toBe(2);
      const hidden = page.locator('openclaw-chat-pane[aria-hidden="true"]');
      await expect.poll(() => readPaneState(hidden, "sessionKey")).toBe("global");
      await gateway.setMethodResponse("models.list", { models: [freshModel] });
      await evaluateControlUiContext(page, (context) => {
        context.agentSelection.set("work");
      });
      await expect.poll(() => readPaneState(hidden, "assistantAgentId")).toBe("work");
      for (const method of methods) {
        expect(
          await gateway.getRequests(method, { agentId: "work", sessionKey: "global" }),
        ).toHaveLength(0);
      }
    });
  });
});
