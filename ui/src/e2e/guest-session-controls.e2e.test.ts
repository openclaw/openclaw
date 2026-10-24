import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  createNewSessionPageE2eSuite,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";
import { requireRecord, sessionsListResponse } from "./session-management.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const timestamp = Date.parse("2026-09-22T10:00:00Z");
const models = ["model-a", "model-b"].map((id) => ({
  id,
  name: id,
  provider: "openai",
  available: true,
}));
const sharedSession = (key: string, label: string) =>
  createControlUiSessionRow(key, label, timestamp, {
    sharingRole: "viewer",
    visibility: "read-only",
    model: "model-a",
  });

suite.define(() => {
  it.each(["started", "rejected"] as const)(
    "a session writer preserves a %s first turn until its owned row arrives",
    async (initialRun) => {
      const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      const foreign = sharedSession("agent:main:shared-notes", "Shared notes");
      const otherAgentSession = sharedSession("agent:research:other-work", "Research notes");
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.sessions.write"],
        agentModel: "openai/model-a",
        models,
        sessions: [foreign, otherAgentSession],
        sessionKey: foreign.key,
        presenceUsers: [{ self: true, id: "guest", name: "Guest" }],
        historyMessages: [],
        methodResponses: {
          "agents.list": {
            agents: [
              { id: "main", name: "Main", model: { primary: "openai/model-a" } },
              { id: "research", name: "Research", model: { primary: "openai/model-a" } },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "models.list": {
            models,
            modelSelectionPolicy: { restricted: true, defaultModel: "openai/model-a" },
          },
        },
      });
      const navigate = async (row: Pick<GatewaySessionRow, "displayName" | "key">) => {
        const target = sessionNavigationTarget({
          face: "chat",
          sessionKey: row.key,
          fallbackAgentId: "main",
          row,
        });
        const expectedPathname = await page.evaluate((options) => {
          const app = window.openclawControlUi;
          if (!app) {
            throw new Error("Control UI readiness hook is unavailable");
          }
          const pathname = `${app.snapshot().basePath}${options.pathname}`;
          app.navigate("chat", { ...options, pathname });
          return pathname;
        }, target.options);
        await page.waitForURL((url) => url.pathname === expectedPathname);
        await page.waitForFunction((key) => {
          // SAFETY: Registered chat panes expose their selected session key.
          const pane = document.querySelector(
            "openclaw-chat-pane.chat-pane-cache__pane--active",
          ) as (HTMLElement & { sessionKey?: string }) | null;
          return pane?.sessionKey === key;
        }, row.key);
      };
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, foreign.key));
        const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        const composer = pane.locator(".agent-chat__composer-combobox > textarea");
        await expect.poll(() => composer.isDisabled()).toBe(true);
        if (initialRun === "started") {
          await navigate(otherAgentSession);
          await expect.poll(() => composer.isDisabled()).toBe(true);
          await navigate(foreign);
          await expect.poll(() => composer.isDisabled()).toBe(true);
        }
        const newSession = page.locator(".sidebar-rail .sidebar-new-session");
        await expect.poll(() => newSession.isEnabled()).toBe(true);
        await newSession.click();
        const draft = page.locator(".new-session-page__message");
        await draft.fill("Help me plan my own work.");
        await gateway.deferNext("sessions.create");
        await page.getByRole("button", { name: "Start session", exact: true }).click();
        const request = requireRecord((await gateway.waitForRequest("sessions.create")).params);
        expect(request).toMatchObject({ agentId: "main", message: "Help me plan my own work." });
        expect(request.key).toEqual(expect.any(String));
        const key = String(request.key);
        const sessionId = "guest-created-session";
        const pendingThread = page.locator(
          'openclaw-pending-session-create[aria-hidden="false"] .chat-thread',
        );
        await expect
          .poll(() =>
            page.locator('.chat-pane-cache__pane[aria-hidden="false"] .chat-thread').count(),
          )
          .toBe(1);
        // Parked panes retain geometry; aria-hidden, inert, and opacity own their presentation.
        await expect
          .poll(() =>
            page.locator('openclaw-chat-pane[aria-hidden="true"]').evaluateAll((panes) =>
              panes.map((parkedPane) => ({
                inert: parkedPane.hasAttribute("inert"),
                opacity: getComputedStyle(parkedPane).opacity,
              })),
            ),
          )
          .toEqual(
            Array.from({ length: initialRun === "started" ? 2 : 1 }, () => ({
              inert: true,
              opacity: "0",
            })),
          );
        await expect.poll(() => pendingThread.textContent()).toContain("Help me plan my own work.");
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        const listCount = (await gateway.getRequests("sessions.list")).length;
        await gateway.deferNext("sessions.list");
        // Creation must preserve its first turn while an earlier roster read is still pending.
        await evaluateControlUiContext(page, (application) => {
          void application.sessions.refreshList({ force: true });
        });
        await gateway.waitForRequest("sessions.list", { after: listCount });
        await gateway.deferNext("chat.startup", { sessionKey: key });
        await gateway.deferNext("sessions.describe", { key });
        await gateway.resolveDeferred("sessions.create", {
          key,
          entry: { sessionId },
          ...(initialRun === "started"
            ? { runStarted: true, runId: "guest-initial-run" }
            : { runStarted: false, runError: { message: "Initial turn refused" } }),
        });
        await waitForCommittedChatRoute(page);
        const initialMessage = pane.locator(".chat-group.user", {
          hasText: "Help me plan my own work.",
        });
        await initialMessage.waitFor();
        expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);

        const own = createControlUiSessionRow(key, "My Guest session", timestamp + 1, {
          sessionId,
          sharingRole: "owner",
          model: "model-a",
          hasActiveRun: initialRun === "started",
          status: initialRun === "started" ? "running" : "done",
          activeRunIds: initialRun === "started" ? ["guest-initial-run"] : [],
        });
        const roster = sessionsListResponse([foreign, otherAgentSession, own]);
        await gateway.setSessionsListResponse(roster);
        await gateway.setMethodResponse("sessions.list", {
          cases: [
            {
              match: { agentId: "research" },
              response: sessionsListResponse([otherAgentSession]),
            },
            { response: roster },
          ],
        });
        await gateway.resolveDeferred("sessions.list", roster);
        await gateway.resolveDeferred("chat.startup");
        await gateway.resolveDeferred("sessions.describe");
        await expect.poll(() => composer.isEditable()).toBe(true);
        if (initialRun === "rejected") {
          await expect
            .poll(() => initialMessage.locator(".chat-send-status").textContent())
            .toContain("Not sent");
          await pane.getByRole("button", { name: "Retry queued message" }).click();
          expect(requireRecord((await gateway.waitForRequest("chat.send")).params)).toMatchObject({
            sessionKey: key,
            message: "Help me plan my own work.",
          });
          expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
          return;
        }

        await gateway.emitChatFinal({
          runId: "guest-initial-run",
          sessionKey: key,
          text: "Ready.",
        });
        await navigate(foreign);
        await expect.poll(() => composer.isDisabled()).toBe(true);
        expect(await pane.locator("[data-chat-model-select]").getAttribute("aria-disabled")).toBe(
          "true",
        );
        expect(await pane.locator("[data-chat-permission-select]").isDisabled()).toBe(true);
        await navigate(own);
        await expect.poll(() => composer.isEditable()).toBe(true);
        await gateway.setOperatorScopes(["operator.sessions.read"]);
        await gateway.closeLatest(1001, "session permission changed");
        await expect.poll(() => newSession.isDisabled()).toBe(true);
        await expect.poll(() => composer.isDisabled()).toBe(true);
        expect(await pane.locator("[data-chat-model-select]").getAttribute("aria-disabled")).toBe(
          "true",
        );
        expect(await pane.locator("[data-chat-permission-select]").isDisabled()).toBe(true);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
