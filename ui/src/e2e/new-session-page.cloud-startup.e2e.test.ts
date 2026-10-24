import type { Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
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

  it("restores an unconfirmed cloud turn after reload and checks delivery without replay", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = "agent:cloud:reload-recovery";
      const message = "resume this cloud task after reload";
      const gateway = await openCloudPage(page, {
        "sessions.create": { key: sessionKey },
        "sessions.dispatch": {
          placement: { state: "active", generation: 1 },
        },
        "sessions.list": {
          count: 1,
          defaults: SESSION_LIST_DEFAULTS,
          path: "",
          sessions: [{ key: sessionKey, kind: "direct", updatedAt: Date.now() }],
          ts: Date.now(),
        },
        "chat.history": {
          messages: [],
          sessionId: "session-reload-recovery",
          sessionInfo: { hasActiveRun: false, key: sessionKey, status: "done" },
        },
      });
      await chooseCloud(page);
      await disableComposerStorage(page);
      await gateway.deferNext("sessions.send");
      await page.locator(".new-session-page__message").fill(message);
      await pastePng(page.locator(".new-session-page__message"));
      await page.getByRole("button", { name: "Start session" }).click();
      const firstSend = await gateway.waitForRequest("sessions.send");
      const messageId = (firstSend.params as { idempotencyKey: string }).idempotencyKey;
      expect(firstSend.params).toMatchObject({
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
      });
      await waitForCommittedChatRoute(page);
      await gateway.rejectDeferred("sessions.send", {
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
        .toMatchObject({ phase: "failed", error: expect.stringContaining("send outcome unknown") });
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
      expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
      recoveryRuntime.release();
      await reload;
      await waitForCommittedChatRoute(page);
      expect(page.url()).toContain(controlUiSessionPath(sessionKey));
      const retainedTurn = page.locator(".chat-group.user", { hasText: message });
      const followUpMessage = "Wait behind the unconfirmed initial turn";
      const checkDelivery = page.getByRole("button", { name: "Check delivery", exact: true });
      await checkDelivery.waitFor({ state: "visible" });
      await expectPastedPngImage(retainedTurn.locator("img.chat-message-image"));
      const followUp = page.locator(".agent-chat__composer-combobox textarea");
      await pollDisabled(followUp).toBe(false);
      await followUp.fill(followUpMessage);
      await followUp.press("Enter");
      await page.locator(".chat-queue__item", { hasText: followUpMessage }).waitFor();
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      const historyCount = (await gateway.getRequests("chat.history")).length;
      await checkDelivery.click();
      await expect
        .poll(async () => (await gateway.getRequests("chat.history")).slice(historyCount))
        .toContainEqual(
          expect.objectContaining({
            params: {
              sessionKey,
              toolResultMaxChars: 2_000,
              limit: 1000,
              inputRunIds: [messageId],
            },
          }),
        );
      await pollLocatorText(page.getByRole("alert")).toContain("No matching user message");
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
      await checkDelivery.click();
      await pollCount(checkDelivery).toBe(0);
      await pollCount(retainedTurn).toBe(1);
      await pollCount(retainedTurn.locator(".chat-send-status")).toBe(0);
      expect(await gateway.waitForRequest("chat.send")).toMatchObject({
        params: { sessionKey, message: followUpMessage },
      });
      await expectNoRequests(gateway, "sessions.create", "sessions.dispatch", "sessions.send");
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
      expect(await gateway.waitForRequest("chat.history")).toMatchObject({
        params: { sessionKey: "agent:cloud:offline-recovery", limit: 1000 },
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
      await expectNoRequests(gateway, "sessions.send", "sessions.dispatch");
      await pollValue(page.locator(".new-session-page__message")).toBe("");
      await chooseCloud(page);
      await page.locator(".new-session-page__message").fill("start another cloud task");
      await pollDisabled(page.getByRole("button", { name: "Start session" })).toBe(false);
      await gateway.setOnline(false);
      await pollDisabled(page.getByRole("button", { name: "Start session" })).toBe(true);
    });
  });
});
