import type { Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e-contract.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import { holdModuleResponse } from "./control-ui-e2e-suite.test-support.ts";
import {
  pollDisabled,
  pollAttribute,
  pollCount,
  pollValue,
  ONE_PIXEL_PNG_B64,
  SESSION_LIST_DEFAULTS,
  controlUiSessionPath,
  createCloudAgentsListResponse,
  createNewSessionPageE2eSuite,
  expectPastedPngImage,
  installMockGateway,
  pastePng,
  pollLocatorText,
  replaceGatewayClient,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";
import {
  cloudWorkspaceResponses,
  disableComposerStorage,
  expectNoRequests,
} from "./new-session-startup-family.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const cloudAgents = createCloudAgentsListResponse();

async function chooseCloud(page: Page) {
  await page.locator("#new-session-where-trigger").click();
  await page.locator('[data-value="cloud:aws"]').click();
}

async function openCloudPage(page: Page, overrides: Record<string, unknown>) {
  const gateway = await installMockGateway(page, {
    workspaceGit: true,
    methodResponses: {
      ...cloudWorkspaceResponses(),
      ...overrides,
    },
  });
  await page.goto(`${suite.server.baseUrl}new`);
  await gateway.waitForRequest("environments.list");
  return gateway;
}

suite.define(() => {
  it.each(["optimistic", "persisted"] as const)(
    "keeps the acknowledged cloud first turn working while history and roster replies are held (%s user receipt)",
    async (firstMessage) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const sessionKey = "agent:cloud:acknowledged-first-turn";
        const sessionId = "session-acknowledged-first-turn";
        const message = "Show first-turn progress from the delivery receipt";
        const gateway = await openCloudPage(page, {
          "sessions.create": { key: sessionKey, sessionId },
          "sessions.dispatch": { sessionId, placement: { state: "active", generation: 1 } },
          "chat.history": { messages: [], sessionId },
        });
        await chooseCloud(page);
        await gateway.deferNext("chat.send");
        await page.locator(".new-session-page__message").fill(message);
        await page.getByRole("button", { name: "Start session" }).click();
        const send = await gateway.waitForRequest("chat.send");
        const runId = (send.params as { idempotencyKey: string }).idempotencyKey;
        await waitForCommittedChatRoute(page);
        await page.evaluate(() => {
          const mock = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
          for (const method of [
            "chat.history",
            "chat.startup",
            "sessions.list",
            "sessions.describe",
          ]) {
            mock.setRequestHandler(method, () => {});
          }
        });
        if (firstMessage === "persisted") {
          await gateway.emitGatewayEvent("session.message", {
            sessionKey,
            sessionId,
            messageId: "published-first-message",
            messageSeq: 1,
            message: chatMessage("user", message, {
              __openclaw: {
                id: "published-first-message",
                idempotencyKey: `${runId}:user`,
              },
            }),
          });
        }
        await gateway.resolveDeferred("chat.send", { runId, status: "started" });
        await expect
          .poll(() =>
            evaluateControlUiContext(
              page,
              (application, key) => application.placementStartup.get(key),
              sessionKey,
            ),
          )
          .toBeNull();
        const working = page.locator(".chat-working-indicator");
        await expect.poll(() => working.textContent()).toContain("Working");
        await expect
          .poll(() =>
            evaluateControlUiContext(
              page,
              (application, scope) =>
                application.chatSubmissions.readInitial(
                  scope.sessionKey,
                  application.gateway.snapshot.client ?? null,
                  scope.sessionId,
                )?.pending,
              { sessionKey, sessionId },
            ),
          )
          .toBe(firstMessage === "optimistic");
        await gateway.emitGatewayEvent("chat", {
          sessionKey,
          runId,
          state: "status",
          phase: "preparing_context",
          seq: 1,
        });
        await expect.poll(() => working.textContent()).toContain("Preparing this turn");
        await gateway.emitGatewayEvent("chat", {
          sessionKey,
          runId,
          state: "delta",
          seq: 2,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "First assistant token" }],
          },
        });
        await page.locator(".chat-group.assistant", { hasText: "First assistant token" }).waitFor();
        expect(await page.locator(".chat-group.user", { hasText: message }).count()).toBe(1);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      });
    },
  );

  it("clears cloud placement when the selected agent changes", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await openCloudPage(page, {
        "agents.list": {
          ...cloudAgents,
          agents: [
            ...cloudAgents.agents,
            {
              id: "local",
              identity: { name: "Local" },
              name: "Local",
              workspace: "/home/peter/local",
              workspaceGit: false,
            },
          ],
        },
      });
      await chooseCloud(page);
      const trigger = page.locator("#new-session-where-trigger");
      await pollAttribute(trigger, "data-cloud-profile").toBe("aws");
      await gateway.setMethodResponse("environments.list", { environments: [], profiles: [] });
      const profileRequests = (await gateway.getRequests("environments.list")).length;
      await replaceGatewayClient(page);
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBeGreaterThan(profileRequests);
      await pollAttribute(trigger, "data-cloud-profile").toBe("aws");
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("aws");
      await pollDisabled(page.getByRole("button", { name: "Start session" })).toBe(true);
      await trigger.click();
      await pollDisabled(
        page
          .locator(".oc-popover.new-session-page__where-popover")
          .locator('[data-value="cloud:aws"]'),
      ).toBe(true);
      await page.keyboard.press("Escape");
      const agentPicker = page.locator(".new-session-page__select--agent openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").click();
      await agentPicker
        .locator(".agent-select__option[data-agent-option]")
        .filter({ hasText: "Local" })
        .click();
      await page.getByRole("heading", { name: "Local" }).waitFor();
      await pollAttribute(trigger, "data-cloud-profile").toBeNull();
      await pollCount(page.locator("#new-session-checkout-trigger")).toBe(0);
    });
  });

  it("restores a pending cloud turn after reload and resends its original key", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = "agent:cloud:reload-recovery";
      const sessionId = "session-reload-recovery";
      const message = "resume this cloud task after reload";
      const gateway = await openCloudPage(page, {
        "sessions.create": { key: sessionKey, sessionId },
        "sessions.dispatch": {
          sessionId,
          placement: { state: "active", generation: 1 },
        },
        "sessions.list": {
          count: 1,
          defaults: SESSION_LIST_DEFAULTS,
          path: "",
          sessions: [{ key: sessionKey, sessionId, kind: "direct", updatedAt: Date.now() }],
          ts: Date.now(),
        },
        "chat.history": {
          messages: [],
          sessionId,
          sessionInfo: { hasActiveRun: false, key: sessionKey, sessionId, status: "done" },
        },
      });
      await chooseCloud(page);
      await disableComposerStorage(page);
      await gateway.deferNext("chat.send");
      await page.locator(".new-session-page__message").fill(message);
      await pastePng(page.locator(".new-session-page__message"));
      await page.getByRole("button", { name: "Start session" }).click();
      const firstSend = await gateway.waitForRequest("chat.send");
      const messageId = (firstSend.params as { idempotencyKey: string }).idempotencyKey;
      expect(firstSend.params).toMatchObject({
        sessionKey,
        sessionId,
        expectedLeafEntryId: null,
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
      });
      await waitForCommittedChatRoute(page);
      // Keep automatic retries unacknowledged until the pending turn survives reload.
      await gateway.deferNext("chat.send");
      await gateway.rejectDeferred("chat.send", {
        code: "UNAVAILABLE",
        message: "send outcome unknown",
      });
      await expect
        .poll(() =>
          evaluateControlUiContext(
            page,
            (application, key) => application.placementStartup.get(key),
            sessionKey,
          ),
        )
        .toMatchObject({ phase: "reconnecting", initialTurn: { sendState: "waiting-reconnect" } });
      const recoveryRuntime = await holdModuleResponse(
        page,
        controlUiE2eBuiltModuleRequest("ui/src/app/session-placement-startup.runtime.ts"),
      );
      const reload = page.reload();
      await recoveryRuntime.request;
      await expect
        .poll(() =>
          evaluateControlUiContext(page, (application) => application.gateway.snapshot.phase),
        )
        .toBe("connected");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await gateway.deferNext("chat.send");
      recoveryRuntime.release();
      await reload;
      await waitForCommittedChatRoute(page);
      expect(page.url()).toContain(controlUiSessionPath(sessionKey));
      const retainedTurn = page.locator(".chat-group.user", { hasText: message });
      const followUpMessage = "Wait behind the pending initial turn";
      const replay = await gateway.waitForRequest("chat.send");
      expect(replay.params).toEqual(firstSend.params);
      await expectPastedPngImage(retainedTurn.locator("img.chat-message-image"));
      const followUp = page.locator(".agent-chat__composer-combobox textarea");
      await pollDisabled(followUp).toBe(false);
      await followUp.fill(followUpMessage);
      await followUp.press("Enter");
      await page.locator(".chat-queue__item", { hasText: followUpMessage }).waitFor();
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      await expectPastedPngImage(retainedTurn.locator("img.chat-message-image"));
      await gateway.setHistoryMessages([
        {
          role: "user",
          content: [
            { type: "text", text: message },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: ONE_PIXEL_PNG_B64 },
            },
          ],
          __openclaw: { idempotencyKey: `${messageId}:user` },
        },
      ]);
      await gateway.resolveDeferred("chat.send", { runId: messageId, status: "ok" });
      await pollCount(retainedTurn).toBe(1);
      await pollCount(retainedTurn.locator(".chat-send-status")).toBe(0);
      expect(await gateway.waitForRequest("chat.send", { after: 1 })).toMatchObject({
        params: { sessionKey, message: followUpMessage },
      });
      expect(await gateway.getRequests("chat.send")).toHaveLength(2);
      await expectNoRequests(gateway, "sessions.create", "sessions.dispatch");
    });
  });

  it("reconciles an accepted turn added while disconnected without locking the new-session page", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await openCloudPage(page, {
        "chat.history": {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "restore after reconnect" }],
              __openclaw: { idempotencyKey: "message-offline-recovery:user" },
            },
          ],
          sessionId: "session-offline-recovery",
        },
      });
      const recoveryIdentity = await evaluateControlUiContext(page, async (application) => {
        const gatewayUrl = application.gateway.connection.gatewayUrl;
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode("e2e-device-token"),
        );
        const legacyScope = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        const sessionKey = "agent:cloud:offline-recovery";
        const frame = (value: string) => `${value.length}:${value}`;
        const storageKey =
          `openclaw.new-session.session-placement-recovery.v1:${frame(gatewayUrl)}:` +
          `${frame(legacyScope)}:${frame(sessionKey)}`;
        return { gatewayUrl, legacyScope, storageKey };
      });
      await gateway.setOnline(false);
      await expect
        .poll(() =>
          evaluateControlUiContext(
            page,
            (application) => application.gateway.snapshot.phase === "connected",
          ),
        )
        .toBe(false);
      await page.evaluate(({ gatewayUrl, legacyScope, storageKey }) => {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({
            sessionKey: "agent:cloud:offline-recovery",
            sessionId: "session-offline-recovery",
            messageId: "message-offline-recovery",
            message: "restore after reconnect",
            target: { kind: "profile", profileId: "aws" },
            agentId: "cloud",
            gatewayUrl,
            recoveryScope: legacyScope,
            phase: "sending",
          }),
        );
      }, recoveryIdentity);
      await gateway.setOnline(true);
      expect(await gateway.waitForRequest("chat.send")).toMatchObject({
        params: {
          sessionKey: "agent:cloud:offline-recovery",
          sessionId: "session-offline-recovery",
          expectedLeafEntryId: null,
          message: "restore after reconnect",
          idempotencyKey: "message-offline-recovery",
        },
      });
      await expect
        .poll(() =>
          page.evaluate(() =>
            Object.keys(sessionStorage).filter((key) =>
              key.startsWith("openclaw.new-session.session-placement-recovery.v1:"),
            ),
          ),
        )
        .toHaveLength(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      await expectNoRequests(gateway, "sessions.dispatch");
      await pollValue(page.locator(".new-session-page__message")).toBe("");
      await chooseCloud(page);
      await page.locator(".new-session-page__message").fill("start another cloud task");
      await pollDisabled(page.getByRole("button", { name: "Start session" })).toBe(false);
      await gateway.setOnline(false);
      await pollDisabled(page.getByRole("button", { name: "Start session" })).toBe(true);
    });
  });
});
