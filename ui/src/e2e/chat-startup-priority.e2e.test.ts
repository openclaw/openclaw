import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { TaskSummary } from "@openclaw/gateway-protocol";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { composerEnabled, composerValue, fillComposer } from "../test-helpers/composer-editor.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat startup request priority" });
const sessionKey = "agent:research:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const historyText = "Authoritative selected conversation.";
const bulkMethods = ["sessions.list", "sessions.catalog.list"];
const secondaryMethods = [
  "tasks.list",
  "taskSuggestions.list",
  "progressCard.get",
  "sessions.groups.list",
  "sessions.groups.defaults",
  "mentions.list",
];

async function installStartupGateway(page: Page) {
  const config = { tools: { swarm: { enabled: true } } };
  return installMockGateway(page, {
    defaultAgentId: "main",
    assistantAgentId: "main",
    mainSessionKey: "agent:main:main",
    sessionKey,
    sessions: [{ key: sessionKey, kind: "direct", label: "Selected conversation", updatedAt: 1 }],
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
    presenceUsers: [
      { self: true, id: "reader", name: "Reader", identity: { type: "profile", id: "reader" } },
    ],
    sessionGroups: ["Client work"],
    sessionGroupDefaults: { "Client work": { cwd: "/workspace/client", worktree: true } },
    methodResponses: {
      "agents.list": {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "Main" },
          { id: "research", name: "Research" },
        ],
      },
      "sessions.catalog.list": { catalogs: [] },
      "tasks.list": { tasks: [] },
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

async function openPendingChat(page: Page, gateway: Gateway) {
  await page.goto(`${suite.server.baseUrl}chat/research/selected-conversation-12345678`);
  const resolution = await gateway.waitForRequest("sessions.resolve");
  expect(resolution.params).toMatchObject({ agentId: "research", shortId: "12345678" });
  const startup = await gateway.waitForRequest("chat.startup");
  expect(startup.params).toMatchObject({ sessionKey });
  const subscription = await gateway.waitForRequest("sessions.subscribe");
  expect(subscription.params).toEqual({});
  await page
    .locator(".chat-pane-cache__pane--active .chat-thread .lazy-view-state--loading")
    .waitFor();
}

async function expectBulkReadsHeld(gateway: Gateway) {
  // Cover the event refresh debounce as well as immediate mount requests.
  const deadline = Date.now() + 500;
  do {
    for (const method of bulkMethods) {
      expect(await gateway.getRequests(method), `${method} before chat startup settled`).toEqual(
        [],
      );
    }
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

suite.define(() => {
  it("loads selected history before automatic rosters, including event refreshes, and keeps live messages", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installStartupGateway(page);
      try {
        await openPendingChat(page, gateway);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await page.screenshot({
            path: path.join(suite.artifactDir, "01-selected-chat-pending.png"),
          });
        }
        for (const method of secondaryMethods) {
          expect(await gateway.getRequests(method), `${method} before history`).toEqual([]);
        }
        await expectBulkReadsHeld(gateway);
        const fixtureTime = Date.now();
        const task = {
          id: "startup-task",
          taskId: "startup-task",
          status: "running",
          runtime: "subagent",
          agentId: "research",
          title: "Queued task during startup",
          sessionKey,
          createdAt: fixtureTime,
          updatedAt: fixtureTime,
          startedAt: fixtureTime,
        } satisfies TaskSummary;
        const suggestion = {
          id: "startup-suggestion",
          title: "Queued suggestion during startup",
          prompt: "Review the current rollout.",
          tldr: "A synthetic suggestion.",
          cwd: "/workspace/client",
          sessionKey,
          agentId: "research",
          createdAt: fixtureTime,
        };
        await gateway.setMethodResponse("tasks.list", { tasks: [task] });
        await gateway.setMethodResponse("taskSuggestions.list", { suggestions: [suggestion] });
        await gateway.setMethodResponse("progressCard.get", {
          card: {
            sessionKey,
            revision: 2,
            updatedAt: fixtureTime,
            markdown: "Current rollout progress",
          },
        });
        await gateway.emitGatewayEvent("task", { action: "upserted", task });
        await gateway.emitGatewayEvent("task.suggestion", { action: "created", suggestion });
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 2 });
        await gateway.emitGatewayEvent("sessions.changed", {
          agentId: "research",
          sessionKey,
          reason: "patch",
        });
        await gateway.emitGatewayEvent("presence", {
          presence: [{ instanceId: "synthetic-worker", mode: "node", host: "fixture", ts: 1 }],
        });
        await expectBulkReadsHeld(gateway);
        for (const method of secondaryMethods) {
          expect(await gateway.getRequests(method), `${method} after queued events`).toEqual([]);
        }
        expect(await gateway.getRequests("sessions.list", { spawnedBy: sessionKey })).toEqual([]);

        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await page.screenshot({
            path: path.join(suite.artifactDir, "02-selected-chat-queued-events.png"),
          });
        }

        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "hidden",
          });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await gateway.resolveDeferred("chat.startup");
        const transcript = page.locator(".chat-pane-cache__pane--active .chat-thread");
        await expect
          .poll(() =>
            page
              .locator(".chat-pane-cache__pane--active")
              .evaluate(
                (pane) => (pane as HTMLElement & { transcriptReady: boolean }).transcriptReady,
              ),
          )
          .toBe(true);
        for (const method of ["tasks.list", "taskSuggestions.list", "progressCard.get"]) {
          expect(await gateway.getRequests(method), `${method} while hidden`).toEqual([]);
        }
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "visible",
          });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await transcript.getByText(historyText, { exact: true }).waitFor();
        for (const method of secondaryMethods) {
          await gateway.waitForRequest(method);
          expect(await gateway.getRequests(method)).toHaveLength(method === "tasks.list" ? 2 : 1);
        }
        await page.getByText("Current rollout progress", { exact: true }).waitFor();
        await page.getByText(suggestion.title, { exact: true }).waitFor();
        const composer = page.locator(
          ".chat-pane-cache__pane--active .agent-chat__composer-combobox openclaw-composer-editor",
        );
        const draft = "Synthetic draft while background lists are pending.";
        await expect.poll(() => composerEnabled(composer)).toBe(true);
        await fillComposer(composer, draft);
        await gateway.waitForRequest("sessions.messages.subscribe", { match: { key: sessionKey } });
        // Bulk replies are still held: the selected transcript and its live stream must work alone.
        await gateway.deferNext("chat.history");
        await gateway.emitGatewayEvent("session.message", {
          sessionKey,
          messageId: "synthetic-live-answer",
          messageSeq: 2,
          session: { key: sessionKey, kind: "direct", updatedAt: 2 },
          message: {
            role: "user",
            content: [{ type: "text", text: "Live peer message after startup." }],
            __openclaw: { id: "synthetic-live-answer", seq: 2 },
          },
        });
        await transcript.getByText("Live peer message after startup.", { exact: true }).waitFor();
        expect(await composerValue(composer)).toBe(draft);
        expect(await composer.locator(".cm-content").isEditable()).toBe(true);
        await fillComposer(composer, `${draft} Still editable.`);
        expect(await composerValue(composer)).toBe(`${draft} Still editable.`);
        expect(await gateway.getRequests("chat.send")).toEqual([]);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await page.screenshot({
            path: path.join(suite.artifactDir, "03-selected-chat-completed.png"),
          });
        }
        await expectBulkReadsReleased(gateway);
        await gateway.waitForRequest("sessions.list", { match: { spawnedBy: sessionKey } });
      } finally {
        await writeFile(
          path.join(suite.artifactDir, "selected-chat-startup-requests.json"),
          JSON.stringify(await gateway.getRequests(), null, 2),
        );
      }
    });
  });

  it.each([
    { outcome: "success", opener: "toolbar" },
    { outcome: "hidden failure", opener: "toolbar" },
    { outcome: "hidden retry", opener: "toolbar" },
    { outcome: "success", opener: "keyboard" },
  ] as const)(
    "keeps explicitly opened Tasks current after $outcome via $opener while chat remains held",
    async ({ outcome, opener }) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const gateway = await installStartupGateway(page);
        await openPendingChat(page, gateway);
        for (const method of secondaryMethods) {
          expect(await gateway.getRequests(method)).toEqual([]);
        }
        await gateway.deferNext("tasks.list");
        if (opener === "keyboard") {
          await page.keyboard.press("Meta+Alt+Shift+K");
        } else {
          await page.locator(".chat-pane-cache__pane--active .chat-tasks-toggle").click();
        }
        await gateway.waitForRequest("tasks.list");
        expect(await gateway.getRequests("tasks.list")).toHaveLength(2);
        await gateway.emitGatewayEvent("task", { action: "restored" });
        if (outcome !== "success") {
          await page.evaluate(() => {
            Object.defineProperty(document, "visibilityState", {
              configurable: true,
              get: () => "hidden",
            });
            document.dispatchEvent(new Event("visibilitychange"));
          });
          await gateway.rejectDeferred("tasks.list", {
            code: "UNAVAILABLE",
            message: "Superseded task snapshot failed.",
            ...(outcome === "hidden retry" ? { retryable: true, retryAfterMs: 1 } : {}),
          });
          await expect
            .poll(() =>
              page.locator(".chat-pane-cache__pane--active").evaluate(
                (pane) =>
                  (
                    pane as HTMLElement & {
                      state: { backgroundTasksState: { loading: boolean } };
                    }
                  ).state.backgroundTasksState.loading,
              ),
            )
            .toBe(false);
          expect(await gateway.getRequests("tasks.list")).toHaveLength(2);
          await page.evaluate(() => {
            Object.defineProperty(document, "visibilityState", {
              configurable: true,
              get: () => "visible",
            });
            document.dispatchEvent(new Event("visibilitychange"));
          });
        } else {
          await gateway.resolveDeferred("tasks.list");
        }
        await gateway.waitForRequest("tasks.list", { after: 2 });
        expect(await gateway.getRequests("tasks.list")).toHaveLength(4);
        for (const method of secondaryMethods.filter((candidate) => candidate !== "tasks.list")) {
          expect(await gateway.getRequests(method)).toEqual([]);
        }
        expect(await page.getByText(historyText, { exact: true }).count()).toBe(0);
        await gateway.resolveDeferred("chat.startup");
        await page.locator(".chat-thread").getByText(historyText, { exact: true }).waitFor();
        expect(await gateway.getRequests("tasks.list")).toHaveLength(4);
      });
    },
  );

  it.each([
    { visibility: "hidden document", pendingSnapshot: false },
    { visibility: "retained pane", pendingSnapshot: false },
    { visibility: "hidden document", pendingSnapshot: true },
  ] as const)(
    "parks progress-card invalidations for a $visibility and reconciles on return (pending: $pendingSnapshot)",
    async ({ visibility, pendingSnapshot }) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const gateway = await installStartupGateway(page);
        await openPendingChat(page, gateway);
        if (pendingSnapshot) {
          await gateway.deferNext("progressCard.get");
        }
        await gateway.resolveDeferred("chat.startup");
        await page.locator(".chat-thread").getByText(historyText, { exact: true }).waitFor();
        await gateway.waitForRequest("progressCard.get");
        await expectBulkReadsReleased(gateway);
        expect(await gateway.getRequests("progressCard.get")).toHaveLength(1);
        if (visibility === "hidden document") {
          await page.evaluate(() => {
            Object.defineProperty(document, "visibilityState", {
              configurable: true,
              get: () => "hidden",
            });
            document.dispatchEvent(new Event("visibilitychange"));
          });
        } else {
          await page.locator("openclaw-app-sidebar .sidebar-brand__new-thread").click();
          await page.waitForURL((url) => url.pathname === "/new");
          await page.locator("openclaw-new-session-page").waitFor();
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
          await page.evaluate(() => {
            Object.defineProperty(document, "visibilityState", {
              configurable: true,
              get: () => "visible",
            });
            document.dispatchEvent(new Event("visibilitychange"));
          });
        } else {
          await page
            .locator("openclaw-app-sidebar")
            .getByText("Selected conversation", { exact: true })
            .click();
        }
        if (pendingSnapshot) {
          await gateway.resolveDeferred("progressCard.get");
        }
        await page.getByText("Resumed progress", { exact: true }).waitFor();
        expect(await gateway.getRequests("progressCard.get")).toHaveLength(2);
      });
    },
  );

  it.each([false, true])(
    "keeps task events through initial snapshot failure (before admission: %s)",
    async (early) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const gateway = await installStartupGateway(page);
        await openPendingChat(page, gateway);
        const task = {
          id: "resumed-task",
          taskId: "resumed-task",
          status: "running",
          runtime: "subagent",
          agentId: "research",
          title: "Task received around snapshot failure",
          sessionKey,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } satisfies TaskSummary;
        if (early) {
          await gateway.emitGatewayEvent("task", { action: "upserted", task });
          expect(await gateway.getRequests("tasks.list")).toHaveLength(0);
        }
        await gateway.deferNext("tasks.list");
        await gateway.resolveDeferred("chat.startup");
        await gateway.waitForRequest("tasks.list");
        await gateway.rejectDeferred("tasks.list", {
          code: "INVALID_REQUEST",
          message: "Synthetic task snapshot failure.",
        });
        await expect
          .poll(() =>
            page.locator(".chat-pane-cache__pane--active").evaluate(
              (pane) =>
                (
                  pane as HTMLElement & {
                    state: { backgroundTasksState: { error: string | null } };
                  }
                ).state.backgroundTasksState.error,
            ),
          )
          .toBe("Synthetic task snapshot failure.");
        if (early) {
          await page.getByText(task.title, { exact: true }).waitFor();
          expect(await gateway.getRequests("tasks.list")).toHaveLength(2);
          return;
        }
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "hidden",
          });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await gateway.setMethodResponse("tasks.list", { tasks: [task] });
        await gateway.emitGatewayEvent("task", { action: "upserted", task });
        expect(await gateway.getRequests("tasks.list")).toHaveLength(2);
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "visible",
          });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await gateway.waitForRequest("tasks.list", { after: 2 });
        expect(await gateway.getRequests("tasks.list")).toHaveLength(4);
      });
    },
  );

  it.each([false, true])(
    "reconciles an explicit suggestion refresh after an event while chat remains held (hidden: %s)",
    async (hidden) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const gateway = await installStartupGateway(page);
        await openPendingChat(page, gateway);
        const suggestion = {
          id: "explicit-suggestion",
          title: "Dismiss this suggestion",
          prompt: "A synthetic suggestion to dismiss.",
          tldr: "Synthetic explicit action.",
          cwd: "/workspace/client",
          sessionKey,
          agentId: "research",
          createdAt: Date.now(),
        };
        await gateway.emitGatewayEvent("task.suggestion", { action: "created", suggestion });
        await gateway.deferNext("taskSuggestions.list");
        await page.locator(".task-suggestion__dismiss").click();
        await gateway.waitForRequest("taskSuggestions.list");
        if (hidden) {
          await page.evaluate(() => {
            Object.defineProperty(document, "visibilityState", {
              configurable: true,
              get: () => "hidden",
            });
            document.dispatchEvent(new Event("visibilitychange"));
          });
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
          await page.evaluate(() => {
            Object.defineProperty(document, "visibilityState", {
              configurable: true,
              get: () => "visible",
            });
            document.dispatchEvent(new Event("visibilitychange"));
          });
        }
        await gateway.waitForRequest("taskSuggestions.list", { after: 1 });
        await gateway.resolveDeferred("taskSuggestions.list", { suggestions: [] });
        await page.getByText(latest.title, { exact: true }).waitFor();
        expect(await page.getByText(historyText, { exact: true }).count()).toBe(0);
        await gateway.resolveDeferred("chat.startup");
        await page.locator(".chat-thread").getByText(historyText, { exact: true }).waitFor();
      });
    },
  );

  it("lets an explicit sidebar filter load while the selected transcript is still pending", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installStartupGateway(page);
      await openPendingChat(page, gateway);
      await expectBulkReadsHeld(gateway);
      await gateway.setSessionsListResponse({
        ts: 2,
        path: "",
        count: 1,
        defaults: { model: null, modelProvider: null, contextTokens: null },
        sessions: [
          {
            key: "agent:research:archived-fixture",
            kind: "direct",
            label: "Archived fixture",
            updatedAt: 2,
            archived: true,
          },
        ],
      });
      await page.getByRole("button", { name: "Filter & sort" }).click();
      await page
        .locator(".sidebar-session-sort-menu")
        .getByRole("menuitemradio", { name: "Archived", exact: true })
        .click();
      await gateway.waitForRequest("sessions.list", {
        match: { agentId: "research", archived: true },
      });
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
      await gateway.resolveDeferred("chat.startup");
      await page.locator(".chat-thread").getByText(historyText, { exact: true }).waitFor();
    });
  });

  it.each(["failed startup", "New Session navigation"] as const)(
    "releases background reads after %s retires the pending chat",
    async (outcome) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const gateway = await installStartupGateway(page);
        await openPendingChat(page, gateway);
        await expectBulkReadsHeld(gateway);
        if (outcome === "failed startup") {
          await gateway.rejectDeferred("chat.startup", {
            code: "GATEWAY_UNAVAILABLE",
            message: "Synthetic history unavailable.",
          });
          await page.getByRole("alert").getByText("Synthetic history unavailable.").waitFor();
          for (const method of ["tasks.list", "taskSuggestions.list", "progressCard.get"]) {
            await gateway.waitForRequest(method);
          }
        } else {
          await page.locator("openclaw-app-sidebar .sidebar-brand__new-thread").click();
          await page.waitForURL((url) => url.pathname === "/new");
          await page.locator("openclaw-new-session-page").waitFor();
        }
        await expectBulkReadsReleased(gateway);
        if (outcome === "New Session navigation") {
          await gateway.resolveDeferred("chat.startup");
          expect(new URL(page.url()).pathname).toBe("/new");
          expect(await page.getByText(historyText, { exact: true }).isVisible()).toBe(false);
          for (const method of ["tasks.list", "taskSuggestions.list", "progressCard.get"]) {
            expect(await gateway.getRequests(method), `${method} from retired chat`).toEqual([]);
          }
        }
      });
    },
  );
});
