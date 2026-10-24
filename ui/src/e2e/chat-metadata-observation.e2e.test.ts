import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { ModelCatalogEntry } from "../api/types.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
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
suite.define(() => {
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
