import type { Page } from "playwright";
import { expect, it } from "vitest";
import { makeBootRoster } from "../app/bootstrap.test-support.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatTaskProgress } from "./chat-details.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { chooseSidebarMenuOption, closeSidebarMenu } from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat startup request priority" });
const sessionKey = "agent:research:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const historyText = "Authoritative selected conversation.";
const bulkMethods = ["sessions.list", "sessions.catalog.list"];
const secondaryMethods = [
  "taskSuggestions.list",
  "progressCard.get",
  "sessions.groups.list",
  "sessions.groups.defaults",
  "mentions.list",
];
const ownedSession = (key: string, label: string, updatedAt = 1) => ({
  key,
  label,
  updatedAt,
  kind: "direct",
  owner: { actor: { type: "human", id: "reader" } },
});
const task = (id: string, title: string, createdAt = Date.now()) => ({
  id,
  title,
  createdAt,
  sessionKey,
  agentId: "research",
  cwd: "/workspace/client",
  prompt: "Review the current rollout.",
  tldr: "A synthetic suggestion.",
});

async function installStartupGateway(page: Page) {
  const config = { tools: { swarm: { enabled: true } } };
  return installMockGateway(page, {
    sessionKey,
    sessions: [ownedSession(sessionKey, "Selected conversation")],
    historyMessages: [{ role: "assistant", content: historyText }],
    deferredMethods: ["chat.startup"],
    heldMethods: bulkMethods,
    featureMethods: [
      ...defaultControlUiFeatureMethods,
      "sessions.catalog.list",
      "taskSuggestions.dismiss",
      ...secondaryMethods,
    ],
    gatewayBootId: "startup-proof-boot",
    presenceUsers: [{ self: true, id: "reader", identity: { type: "profile", id: "reader" } }],
    sessionGroups: ["Client work"],
    sessionGroupDefaults: { "Client work": { cwd: "/workspace/client", worktree: true } },
    methodResponses: {
      "agents.list": makeBootRoster({ agents: [{ id: "main" }, { id: "research" }] }),
      "sessions.catalog.list": { catalogs: [] },
      "taskSuggestions.list": { suggestions: [] },
      "taskSuggestions.dismiss": { taskId: "explicit-suggestion", dismissed: true },
      "progressCard.get": { card: null },
      "mentions.list": { gatewayInstanceId: "startup-proof-boot", revision: 1, items: [] },
      "config.get": {
        raw: JSON.stringify(config),
        hash: "synthetic-swarm-enabled",
        config,
        sourceConfig: config,
        runtimeConfig: config,
      },
    },
  });
}

type Gateway = Awaited<ReturnType<typeof installStartupGateway>>;

async function setVisibility(page: Page, visibility: "hidden" | "visible") {
  await page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => value,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visibility);
}

async function expectNoRequests(gateway: Gateway, methods: string[], phase: string) {
  for (const method of methods) {
    expect(await gateway.getRequests(method), `${method} ${phase}`).toEqual([]);
  }
}

async function openPendingChat(page: Page, gateway: Gateway) {
  await page.goto(`${suite.server.baseUrl}chat/research/selected-conversation-12345678`);
  expect((await gateway.waitForRequest("sessions.resolve")).params).toMatchObject({
    agentId: "research",
    shortId: "12345678",
  });
  expect((await gateway.waitForRequest("chat.startup")).params).toMatchObject({ sessionKey });
  expect((await gateway.waitForRequest("sessions.subscribe")).params).toEqual({});
  await page
    .locator(".chat-pane-cache__pane--active .chat-thread .lazy-view-state--loading")
    .waitFor();
}

async function expectBulkReadsHeld(gateway: Gateway) {
  // Cover the event refresh debounce as well as immediate mount requests.
  const deadline = Date.now() + 500;
  do {
    await expectNoRequests(gateway, bulkMethods, "before chat startup settled");
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  } while (Date.now() < deadline);
}

async function expectBulkReadsReleased(gateway: Gateway) {
  for (const method of bulkMethods) {
    await gateway.waitForRequest(method, { match: { agentId: "research" } });
    await gateway.resolveDeferred(method);
  }
}

async function withPendingChat(run: (page: Page, gateway: Gateway) => Promise<void>) {
  await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
    const gateway = await installStartupGateway(page);
    await openPendingChat(page, gateway);
    await run(page, gateway);
  });
}

async function settleStartup(page: Page, gateway: Gateway) {
  await gateway.resolveDeferred("chat.startup");
  await page.locator(".chat-thread").getByText(historyText, { exact: true }).waitFor();
}

async function expectProgress(page: Page, text: string) {
  const details = await openChatTaskProgress(page.locator(".chat-pane-cache__pane--active"));
  await details
    .locator(".session-progress-card__markdown")
    .getByText(text, { exact: true })
    .waitFor();
}

async function openNewSession(page: Page) {
  await page.locator("openclaw-app-sidebar .sidebar-rail .sidebar-new-session").click();
  await page.waitForURL((url) => url.pathname === "/new");
  await page.locator("openclaw-new-session-page").waitFor();
}

suite.define(() => {
  it.each([
    { visibility: "hidden document", pendingSnapshot: false },
    { visibility: "retained pane", pendingSnapshot: false },
    { visibility: "hidden document", pendingSnapshot: true },
  ] as const)(
    "parks progress-card invalidations for a $visibility and reconciles on return (pending: $pendingSnapshot)",
    async ({ visibility, pendingSnapshot }) => {
      await withPendingChat(async (page, gateway) => {
        if (pendingSnapshot) {
          await gateway.deferNext("progressCard.get");
        }
        await settleStartup(page, gateway);
        await gateway.waitForRequest("progressCard.get");
        await expectBulkReadsReleased(gateway);
        expect(await gateway.getRequests("progressCard.get")).toHaveLength(1);
        if (visibility === "hidden document") {
          await setVisibility(page, "hidden");
        } else {
          await openNewSession(page);
          await expect
            .poll(() => page.locator(".chat-pane-cache__pane--active").isVisible())
            .toBe(false);
        }
        await gateway.setMethodResponse("progressCard.get", {
          card: { sessionKey, revision: 3, updatedAt: Date.now(), markdown: "Resumed progress" },
        });
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 3 });
        expect(await gateway.getRequests("progressCard.get")).toHaveLength(1);
        if (visibility === "hidden document") {
          await setVisibility(page, "visible");
        } else {
          await page
            .locator("openclaw-app-sidebar")
            .getByText("Selected conversation", { exact: true })
            .click();
        }
        if (pendingSnapshot) {
          await gateway.resolveDeferred("progressCard.get");
        }
        // Sidebar hovercards mirror this markdown; verify the active pane's card.
        await expectProgress(page, "Resumed progress");
        // One coalesced follow-up reconciles events received during the pending snapshot.
        expect(await gateway.getRequests("progressCard.get")).toHaveLength(2);
      });
    },
  );

  it.each([false, true])(
    "reconciles an explicit suggestion refresh after an event while chat remains held (hidden: %s)",
    async (hidden) => {
      await withPendingChat(async (page, gateway) => {
        const suggestion = task("explicit-suggestion", "Dismiss this suggestion");
        await gateway.emitGatewayEvent("task.suggestion", { action: "created", suggestion });
        await gateway.deferNext("taskSuggestions.list");
        await page.locator(".task-suggestion__dismiss").click();
        await gateway.waitForRequest("taskSuggestions.list");
        if (hidden) {
          await setVisibility(page, "hidden");
        }
        const latest = {
          ...suggestion,
          id: "latest-suggestion",
          title: "Latest suggestion remains",
        };
        await gateway.setMethodResponse("taskSuggestions.list", { suggestions: [latest] });
        await gateway.emitGatewayEvent("task.suggestion", {
          action: "created",
          suggestion: latest,
        });
        if (hidden) {
          expect(await gateway.getRequests("taskSuggestions.list")).toHaveLength(1);
          await setVisibility(page, "visible");
        }
        await gateway.waitForRequest("taskSuggestions.list", { after: 1 });
        await gateway.resolveDeferred("taskSuggestions.list", { suggestions: [] });
        await page.getByText(latest.title, { exact: true }).waitFor();
        expect(await page.getByText(historyText, { exact: true }).count()).toBe(0);
        await settleStartup(page, gateway);
      });
    },
  );

  it("lets an explicit sidebar filter load while the selected transcript is still pending", async () => {
    await withPendingChat(async (page, gateway) => {
      await expectBulkReadsHeld(gateway);
      await gateway.setSessionsListResponse({
        ts: 2,
        defaults: { model: null, modelProvider: null, contextTokens: null },
        sessions: [
          {
            ...ownedSession("agent:research:archived-fixture", "Archived fixture", 2),
            archived: true,
          },
        ],
      });
      await page.getByRole("button", { name: "Filter & sort", exact: true }).click();
      await chooseSidebarMenuOption(page, "Status", "Archived");
      await closeSidebarMenu(page);
      await gateway.waitForRequest("sessions.list", {
        match: { agentId: "research", archived: true },
      });
      expect(await gateway.getRequests("sessions.list")).toHaveLength(1);
      await gateway.resolveDeferred("sessions.list");
      await page
        .locator("openclaw-app-sidebar")
        .getByText("Archived fixture", { exact: true })
        .waitFor();
      expect(await gateway.getRequests("sessions.catalog.list")).toEqual([]);
      expect(await gateway.getRequests("sessions.list", { spawnedBy: sessionKey })).toEqual([]);
      expect(await page.getByText(historyText, { exact: true }).count()).toBe(0);
      expect(await gateway.getRequests("chat.startup")).toHaveLength(1);
      await page
        .locator(".chat-pane-cache__pane--active .chat-thread .lazy-view-state--loading")
        .waitFor();
      await settleStartup(page, gateway);
    });
  });
});
