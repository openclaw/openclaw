import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { selectChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureUiProof,
  createNewSessionPageE2eSuite,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";
import { requireRecord, sessionsListResponse } from "./session-management.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const timestamp = Date.parse("2026-09-22T10:00:00Z");
const thinkingLevels = [
  { id: "low", label: "Low" },
  { id: "high", label: "High" },
];
const models = ["model-a", "model-b"].map((id) => ({
  id,
  name: id === "model-a" ? "Model A" : "Model B",
  provider: "openai",
  available: true,
  reasoning: true,
  supportsFastMode: true,
  thinkingLevels,
  thinkingDefault: "low",
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
        await captureUiProof(suite, page, `guest-${initialRun}-retained-panes.png`, {
          surface: page.locator("openclaw-chat-page"),
          content: [pendingThread],
        });
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
          thinkingLevel: "low",
          thinkingLevels,
          fastMode: false,
          permissionMode: "workspace",
          contextWindow: "standard",
          contextWindowDefault: "standard",
          contextWindows: [
            { id: "standard", label: "Standard", contextWindow: 100000 },
            { id: "extended", label: "Extended", contextWindow: 200000 },
          ],
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
        const model = pane.locator("[data-chat-model-select]");
        await expect.poll(() => model.getAttribute("aria-disabled")).toBe("false");
        await model.click();
        await gateway.deferNext("sessions.patch", { key, model: "openai/model-b" });
        await selectChatModelOption(pane, "openai/model-b");
        await gateway.waitForRequest("sessions.patch", { match: { key, model: "openai/model-b" } });
        const effort = pane.locator("[data-chat-thinking-select]");
        await expect.poll(() => effort.getAttribute("aria-disabled")).toBe("true");
        await gateway.resolveDeferred("sessions.patch");
        // Request capture precedes settlement; Playwright does not gate native
        // summary clicks on aria-disabled, so wait for the model owner.
        await expect
          .poll(() => model.getAttribute("data-chat-select-value"))
          .toBe("openai/model-b");
        await expect.poll(() => model.getAttribute("aria-disabled")).toBe("false");
        await expect.poll(() => effort.getAttribute("aria-disabled")).toBe("false");
        await effort.click();
        const slider = pane.locator("[data-chat-thinking-slider]");
        await expect.poll(() => slider.isVisible()).toBe(true);
        await expect.poll(() => slider.isEnabled()).toBe(true);
        await slider.press("End");
        await gateway.waitForRequest("sessions.patch", { match: { key, thinkingLevel: "high" } });
        await page.keyboard.press("Escape");
        await model.click();
        const contextWindow = pane.locator("[data-chat-context-window-toggle]");
        await expect.poll(() => contextWindow.isVisible()).toBe(true);
        await expect.poll(() => contextWindow.isDisabled()).toBe(true);
        await page.keyboard.press("Escape");
        const permission = pane.locator("[data-chat-permission-select]");
        await permission.click();
        expect(
          await pane.locator('[data-chat-permission-option="full"]').getAttribute("disabled"),
        ).not.toBeNull();
        await pane.locator('[data-chat-permission-option="guarded"]').click();
        await gateway.waitForRequest("sessions.patch", {
          match: { key, permissionMode: "guarded" },
        });

        await composer.fill("Continue my work.");
        await pane.getByRole("button", { name: "Send message", exact: true }).click();
        const send = requireRecord((await gateway.waitForRequest("chat.send")).params);
        expect(send).toMatchObject({ sessionKey: key, message: "Continue my work." });
        const runId = String(send.idempotencyKey);
        const stop = pane.getByRole("button", { name: "Stop generating", exact: true });
        await stop.waitFor();
        const researchListCount = (
          await gateway.getRequests("sessions.list", { agentId: "research" })
        ).length;
        await gateway.setOnline(false);
        await expect.poll(() => stop.isEnabled()).toBe(true);
        await stop.click();
        expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
        await navigate(otherAgentSession);
        await gateway.setOnline(true);
        await gateway.waitForRequest("sessions.list", {
          after: researchListCount,
          match: { agentId: "research" },
        });
        await expect.poll(() => composer.isDisabled()).toBe(true);
        expect(requireRecord((await gateway.waitForRequest("chat.abort")).params)).toMatchObject({
          sessionKey: key,
          runId,
        });
        expect(await gateway.getRequests("chat.abort")).toHaveLength(1);
        await gateway.emitGatewayEvent("chat", { sessionKey: key, runId, state: "aborted" });
        await navigate(own);
        await expect.poll(() => composer.isEditable()).toBe(true);
        await navigate(foreign);
        await expect.poll(() => composer.isDisabled()).toBe(true);
        expect(await model.getAttribute("aria-disabled")).toBe("true");
        expect(await permission.isDisabled()).toBe(true);
        await navigate(own);
        await expect.poll(() => composer.isEditable()).toBe(true);
        await gateway.setOperatorScopes(["operator.sessions.read"]);
        await gateway.closeLatest(1001, "session permission changed");
        await expect.poll(() => newSession.isDisabled()).toBe(true);
        await expect.poll(() => composer.isDisabled()).toBe(true);
        expect(await model.getAttribute("aria-disabled")).toBe("true");
        expect(await permission.isDisabled()).toBe(true);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
