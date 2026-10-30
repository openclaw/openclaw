import type { Locator } from "playwright";
import { expect, it } from "vitest";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { createPageOpener } from "./new-session-page.scenario.test-support.ts";
import {
  controlUiSessionPath,
  createCloudAgentsListResponse,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  LOCAL_GIT_WORKSPACE_RESPONSES,
  expectPastedPngImage,
  installMockGateway,
  pastePng,
  ONE_PIXEL_PNG_B64,
  pollLocatorText,
  replaceGatewayClient,
  waitForCommittedChatRoute,
  pollCount,
} from "./new-session-page.test-support.ts";
import { holdRecoveryDigest } from "./session-placement-recovery-module-boundaries.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const openPage = createPageOpener(suite);
const startupResponses = (sessionKey: string) => ({
  "agents.list": createCloudAgentsListResponse(),
  "environments.list": { environments: [], profiles: [{ id: "aws", providerId: "crabbox" }] },
  "worktrees.branches": LOCAL_GIT_WORKSPACE_RESPONSES["worktrees.branches"],
  "sessions.create": { key: sessionKey, sessionId: `session:${sessionKey}` },
  "sessions.list": createdSessionListResult(sessionKey),
});
async function sendOrdinaryTurn(pane: Locator) {
  return pane.evaluate(async (element) => {
    const { state } = element as HTMLElement & { state: ChatPageHost };
    state.handleChatDraftChange("later ordinary turn");
    await state.handleSendChat();
    return { draft: state.chatMessage, queued: state.chatQueue.map((item) => item.text) };
  });
}
async function expectFailedGroup(group: Locator) {
  await group.waitFor({ state: "visible" });
  await pollLocatorText(group.locator(".chat-send-status")).toContain("Not sent");
  await expectPastedPngImage(group.locator("img.chat-message-image"));
}
function chatState(pane: Locator) {
  return pane.evaluate((element) => {
    const { state } = element as HTMLElement & { state: ChatPageHost };
    return {
      connected: state.connected,
      scopeReady: Boolean(state.client?.recoveryScopeReady),
      loading: state.chatLoading,
    };
  });
}

suite.define(() => {
  it.each(["cancelled", "failed", "pending"] as const)(
    "keeps a deleted Incognito first prompt readable through %s settlement",
    async (outcome) => {
      const page = await openPage();
      const sessionKey = "agent:cloud:cancelled-incognito-startup";
      const message = "keep my interrupted first prompt";
      const diagnostic = "Worker cleanup could not be confirmed";
      const gateway = await installMockGateway(page, {
        defaultAgentId: "cloud",
        workspaceGit: true,
        deferredMethods: ["sessions.dispatch", ...(outcome === "pending" ? ["chat.send"] : [])],
        methodResponses: {
          ...startupResponses(sessionKey),
          "sessions.create": { key: sessionKey, sessionId: "incognito-startup" },
          "sessions.describe": { session: { sessionId: "incognito-startup" } },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();
      await page
        .locator(".oc-popover.new-session-page__where-popover")
        .getByRole("button", { name: "aws", exact: true })
        .click();
      await page.getByRole("switch", { name: "Incognito" }).click();
      await page.locator(".new-session-page__message").fill(message);
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      await gateway.waitForRequest("sessions.dispatch");
      await waitForCommittedChatRoute(page);
      const route = page.url();
      await pollLocatorText(page.locator(".chat-group.user")).toContain(message);
      if (outcome === "pending") {
        await gateway.resolveDeferred("sessions.dispatch", {
          sessionId: "incognito-startup",
          placement: { state: "active", environmentId: "uncertain-worker" },
        });
        await gateway.waitForRequest("chat.send");
      }
      await gateway.setSessionsListResponse({
        ...createdSessionListResult(sessionKey),
        sessions: [],
        count: 0,
      });
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey,
        sessionId: "incognito-startup",
        agentId: "cloud",
        reason: "delete",
      });
      const retained = page.locator("openclaw-pending-session-create");
      await pollLocatorText(retained).toContain(message);
      const working = retained.locator(".chat-working-indicator");
      await pollLocatorText(working).toContain(
        outcome === "pending" ? "Starting…" : "Provisioning environment",
      );
      expect(await retained.textContent()).not.toContain("temporary session was cleaned up");
      expect(page.url()).toBe(route);
      expect(await retained.locator("textarea").isDisabled()).toBe(true);
      if (outcome === "cancelled") {
        await gateway.setMethodResponse("sessions.describe", { session: null });
        await gateway.resolveDeferred("sessions.dispatch", {});
        await pollLocatorText(retained).toContain("Your prompt is kept here");
        await pollCount(working).toBe(0);
        expect(
          await retained.locator(".agent-chat__composer-shell button:enabled:visible").count(),
        ).toBe(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      } else {
        await gateway.rejectDeferred(outcome === "pending" ? "chat.send" : "sessions.dispatch", {
          code: outcome === "pending" ? "UNAVAILABLE" : "INVALID_REQUEST",
          message: diagnostic,
        });
        expect(await retained.textContent()).not.toContain("temporary session was cleaned up");
        if (outcome === "pending") {
          await pollLocatorText(working).toContain("Reconnecting");
          expect(await retained.getByRole("alert").count()).toBe(0);
          expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        } else {
          await pollLocatorText(retained.getByRole("alert")).toContain(diagnostic);
          await pollCount(working).toBe(0);
          const action = retained.getByRole("button", { name: "Retry", exact: true });
          await action.waitFor({ state: "visible" });
          await gateway.deferNext("sessions.dispatch");
          await action.click();
          await expect
            .poll(async () => (await gateway.getRequests("sessions.dispatch")).length)
            .toBe(2);
          await pollLocatorText(working).toContain("Provisioning environment");
          await gateway.rejectDeferred("sessions.dispatch", {
            code: "INVALID_REQUEST",
            message: diagnostic,
          });
          await pollLocatorText(retained.getByRole("alert")).toContain(diagnostic);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        }
      }
      await pollLocatorText(retained).toContain(message);
      expect(await retained.locator("textarea").isDisabled()).toBe(true);
      expect(await gateway.getRequests("chat.send")).toHaveLength(outcome === "pending" ? 1 : 0);
      expect(page.url()).toBe(route);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
    },
  );

  it.each([
    { historyFails: false, disconnect: false, replaceClient: false, coldScope: false },
    { historyFails: true, disconnect: false, replaceClient: false, coldScope: false },
    { historyFails: false, disconnect: true, replaceClient: false, coldScope: false },
    { historyFails: false, disconnect: true, replaceClient: true, coldScope: false },
    { historyFails: false, disconnect: false, replaceClient: false, coldScope: true },
  ])(
    "keeps cloud startup visible through failure ($historyFails, disconnect: $disconnect, replacement: $replaceClient, cold scope: $coldScope)",
    async ({ historyFails, disconnect, replaceClient, coldScope }) => {
      const page = await openPage({
        locale: "en-US",
        serviceWorkers: "block",
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const sessionKey = "agent:cloud:failed-startup-e2e";
      const message = "surface the failed startup";
      const diagnostic = `cloud profile was removed\n${"Enrollment detail. ".repeat(80)}\nFinal startup diagnostic.`;
      const gateway = await installMockGateway(page, {
        defaultAgentId: "cloud",
        subscriptionInitialHistory: !historyFails,
        deferredMethods: ["sessions.dispatch", ...(historyFails ? ["chat.startup"] : [])],
        featureMethods: ["sessions.create", "sessions.dispatch", "chat.startup"],
        workspaceGit: true,
        methodResponses: {
          ...startupResponses(sessionKey),
          "sessions.describe": { session: {} },
          "chat.history": {
            messages: [],
            sessionInfo: { hasActiveRun: false, status: "done" },
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();
      await page
        .locator(".oc-popover.new-session-page__where-popover")
        .getByRole("button", { name: "aws", exact: true })
        .click();
      const composer = page.locator(".new-session-page__message");
      const chatComposer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill(message);
      await pastePng(composer);
      await page.getByRole("button", { name: "Start session" }).click();
      await gateway.waitForRequest("sessions.dispatch");
      await waitForCommittedChatRoute(page);
      if (historyFails) {
        await gateway.waitForRequest("chat.startup");
        await gateway.rejectDeferred("chat.startup", {
          code: "UNAVAILABLE",
          message: "History is temporarily unavailable",
        });
        await pollLocatorText(page.locator(".chat-history-error--inline")).toContain(
          "History is temporarily unavailable",
        );
      }
      const working = page.locator('.chat-thread .chat-working-indicator[role="status"]');
      await pollLocatorText(working).toContain("Provisioning environment…");
      expect(await working.locator(".chat-reading-indicator").count()).toBe(1);
      expect(
        await page
          .locator('.chat-cloud-startup, .agent-chat__composer-status-band[role="alert"]')
          .count(),
      ).toBe(0);
      expect(await page.locator(".chat-send-btn--stop").count()).toBe(0);
      await gateway.rejectDeferred("sessions.dispatch", {
        code: "INVALID_REQUEST",
        message: diagnostic,
      });

      const alert = page.getByRole("alert").filter({ hasText: "cloud profile was removed" });
      await pollLocatorText(alert).toContain("cloud profile was removed");
      await pollCount(working).toBe(0);
      expect(await alert.locator("summary").count()).toBe(1);
      await alert.locator("summary").click();
      const text = alert.locator("pre");
      await text.waitFor({ state: "visible" });
      expect(await text.textContent()).toContain(diagnostic);
      await alert.getByRole("button", { name: "Copy error", exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(await text.textContent());
      expect(page.url()).toContain(controlUiSessionPath(sessionKey));
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.delete")).toHaveLength(0);
      const failedGroup = page.locator(".chat-group.user", { hasText: message });
      await expectFailedGroup(failedGroup);
      if (disconnect) {
        await gateway.setOnline(false);
        if (replaceClient) {
          await replaceGatewayClient(page);
        }
        const pane = page.locator(".chat-pane-cache__pane--active");
        await expect.poll(() => chatState(pane)).toMatchObject({ connected: false });
        // Use the public page action: non-composer callers must share admission.
        const offline = await sendOrdinaryTurn(pane);
        const composerDisabled = await chatComposer.isDisabled();
        await failedGroup.waitFor({ state: "visible" });
        await pollLocatorText(pane.locator(".chat-working-indicator")).toContain("Reconnecting");
        expect(await pane.locator(".agent-chat__welcome").count()).toBe(0);
        const outbox = pane.locator(".chat-queue__item");
        await outbox.getByText("later ordinary turn", { exact: true }).waitFor();
        await outbox.getByText("Waiting for reconnect", { exact: true }).waitFor();
        expect(await outbox.count()).toBe(1);
        await pollLocatorText(pane.locator(".agent-chat__composer-status-band")).toContain(
          "The initial message is unresolved.",
        );
        await pollLocatorText(failedGroup.locator(".chat-send-status")).toContain(
          "Waiting for reconnect",
        );
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await pane.locator(".chat-topbar-notices .chat-error").count()).toBe(0);

        await gateway.setOnline(true);
        await failedGroup.waitFor({ state: "visible" });
        expect(composerDisabled).toBe(false);
        expect({ offline, sends: await gateway.getRequests("chat.send") }).toMatchObject({
          offline: { draft: "", queued: ["later ordinary turn"] },
          sends: [],
        });
        expect(await chatComposer.inputValue()).toBe("");
        expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(1);
      } else {
        if (coldScope) {
          // Delay the real post-hello digest; do not override the client's readiness getter.
          await page.addInitScript(holdRecoveryDigest);
        }
        await page.reload();
        if (coldScope) {
          const pane = page.locator(".chat-pane-cache__pane--active");
          await expect
            .poll(() => chatState(pane))
            .toEqual({ connected: true, scopeReady: false, loading: false });
          expect(await failedGroup.count()).toBe(0);
          const blocked = await sendOrdinaryTurn(pane);
          const composerDisabled = await chatComposer.isDisabled();
          const heldSend = pane.getByRole("button", {
            name: "Finishing connection recovery. Try sending again when it is ready.",
            exact: true,
          });
          await heldSend.waitFor({ state: "visible" });
          expect(await heldSend.isDisabled()).toBe(true);
          expect(await heldSend.getAttribute("aria-busy")).toBe("true");
          expect(await pane.locator(".agent-chat__composer-combobox textarea").inputValue()).toBe(
            "later ordinary turn",
          );
          await pane.getByRole("status", { name: "Loading chat", exact: true }).waitFor();
          expect(await pane.locator(".agent-chat__welcome").count()).toBe(0);
          expect(await pane.locator(".chat-topbar-notices .chat-error").count()).toBe(0);

          await page.evaluate(() =>
            (window as unknown as { releaseRecoveryDigest: () => void }).releaseRecoveryDigest(),
          );
          await failedGroup.waitFor({ state: "visible" });
          expect({ blocked, sends: await gateway.getRequests("chat.send") }).toEqual({
            blocked: { draft: "later ordinary turn", queued: [] },
            sends: [],
          });
          expect(composerDisabled).toBe(false);
        }
      }
      await expectFailedGroup(failedGroup);
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(disconnect ? 1 : 0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      if (disconnect) {
        await gateway.deferNext("sessions.dispatch");
      }
      await failedGroup.getByRole("button", { name: "Retry queued message" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.dispatch")).length)
        .toBe(disconnect ? 2 : 1);
      const retry = (await gateway.getRequests("sessions.dispatch")).at(-1)!;
      expect(retry.params).toMatchObject({ key: sessionKey, profileId: "aws" });
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await gateway.resolveDeferred("sessions.dispatch", {
        sessionId: `session:${sessionKey}`,
        placement: { state: "active", environmentId: "worker-retry" },
      });
      const initial = await gateway.waitForRequest("chat.send");
      expect(initial).toMatchObject({
        params: {
          sessionKey,
          sessionId: `session:${sessionKey}`,
          expectedLeafEntryId: null,
          message,
          attachments: [{ content: ONE_PIXEL_PNG_B64, fileName: "pixel.png" }],
        },
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(disconnect ? 1 : 0);
      if (disconnect || coldScope) {
        expect(await chatComposer.inputValue()).toBe(disconnect ? "" : "later ordinary turn");
        if (disconnect) {
          expect(await gateway.getRequests("chat.send")).toHaveLength(1);
          await gateway.emitChatFinal({
            sessionKey,
            runId: requireString(requireRecord(initial.params).idempotencyKey, "initial run id"),
            text: "Initial turn finished.",
          });
          const follower = await gateway.waitForRequest("chat.send", { after: 1 });
          expect(follower.params).toMatchObject({ sessionKey, message: "later ordinary turn" });
          expect(await gateway.getRequests("chat.send")).toHaveLength(2);
        } else {
          expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        }
      }
    },
  );
});
