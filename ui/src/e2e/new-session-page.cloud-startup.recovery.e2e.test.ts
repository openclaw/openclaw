import type { Page } from "playwright";
import { expect, it } from "vitest";
import { sessionPlacementRecoveryExactStorageKey } from "../lib/sessions/session-placement-recovery-storage-key.ts";
import type {
  SessionPlacementPausedRecovery,
  SessionPlacementRecovery,
} from "../lib/sessions/session-placement-recovery.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { openChatModelPicker } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  LOCAL_GIT_WORKSPACE_RESPONSES,
  controlUiSessionPath,
  controlUiSessionUrl,
  createCloudAgentsListResponse,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  expectPastedPngImage,
  installMockGateway,
  ONE_PIXEL_PNG_B64,
  pastePng,
  openEnvironmentPicker,
  pollCount,
  pollEnabled,
  pollDisabled,
  pollLocatorText,
  pollValue,
  pollAttribute,
  replaceGatewayClient,
  waitForCommittedChatRoute,
  waitForGatewayRecoveryScope,
} from "./new-session-page.test-support.ts";
import {
  personalModelScenario,
  environmentProfiles,
  unavailableError,
  expectRequest,
  sessionList,
} from "./new-session-shard.test-support.ts";

const suite = createNewSessionPageE2eSuite();

function activePlacement(id: string, remoteWorkspaceDir: string) {
  return {
    state: "active",
    generation: 1,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    environmentId: `worker-${id}`,
    activeOwnerEpoch: 1,
    workerBundleHash: "a".repeat(64),
    workspaceBaseManifestRef: `manifest-${id}`,
    remoteWorkspaceDir,
  };
}

function cloudWorkspaceResponses() {
  return {
    "agents.list": createCloudAgentsListResponse(),
    "environments.list": environmentProfiles("aws"),
    "worktrees.branches": LOCAL_GIT_WORKSPACE_RESPONSES["worktrees.branches"],
  };
}

async function openCloudDraft(page: Page, gateway: Awaited<ReturnType<typeof installMockGateway>>) {
  await page.goto(`${suite.server.baseUrl}new`);
  await gateway.waitForRequest("environments.list");
  await page.locator("#new-session-where-trigger").click();
  await page
    .locator(".oc-popover.new-session-page__where-popover")
    .getByRole("button", { name: "aws", exact: true })
    .click();
}

function readRecovery(page: Page) {
  return page.evaluate(() => {
    const key = Object.keys(sessionStorage).find((candidate) =>
      candidate.startsWith("openclaw.new-session.session-placement-recovery.v1:"),
    );
    return key
      ? (JSON.parse(sessionStorage.getItem(key) ?? "null") as SessionPlacementRecovery)
      : null;
  });
}

suite.define(() => {
  it("retries a saved unsent cloud turn on its already-active worker", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const sessionKey = "agent:cloud:late-active-retry";
      const sessionId = "session-late-active-retry";
      const messageId = "late-active-first-turn";
      const message = "Continue the saved cloud task";
      const diagnostic =
        "Worker setup is still in progress. Retry to check the existing worker; your message has not been sent.";
      const placement = activePlacement("late-active-retry", "/workspace/cloud-proof");
      const sessions = createdSessionListResult(sessionKey);
      const session = { ...sessions.sessions[0], sessionId, placement };
      const gateway = await installMockGateway(page, {
        defaultAgentId: "cloud",
        workspaceGit: true,
        methodResponses: {
          "agents.list": createCloudAgentsListResponse(),
          "sessions.list": { ...sessions, sessions: [session] },
          "sessions.describe": { session },
          "sessions.dispatch": {
            __mockError: {
              code: "INVALID_REQUEST",
              message: "session cannot dispatch from placement active",
            },
          },
          "sessions.send": { runId: messageId, status: "started" },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await pollDisabled(composer).toBe(false);
      // Pending history permits editing before the authenticated recovery scope is ready.
      await waitForGatewayRecoveryScope(page);
      const owner = await evaluateControlUiContext(page, ({ gateway: appGateway }) => ({
        gatewayUrl: appGateway.connection.gatewayUrl,
        recoveryScope: appGateway.snapshot.client!.recoveryScope,
      }));
      // The unit regression covers timeout expiry; this GUI starts from its persisted result.
      const recovery: SessionPlacementPausedRecovery = {
        ...owner,
        sessionKey,
        messageId,
        message,
        agentId: "cloud",
        target: { kind: "profile", profileId: "aws" },
        phase: "paused",
        reason: "not-sent",
        error: diagnostic,
      };
      const storageKey = sessionPlacementRecoveryExactStorageKey(
        owner.gatewayUrl,
        owner.recoveryScope,
        sessionKey,
      );
      await page.evaluate(
        ({ key, record }) => sessionStorage.setItem(key, JSON.stringify(record)),
        { key: storageKey, record: recovery },
      );
      await page.reload();
      await waitForCommittedChatRoute(page);
      const initialTurn = page.locator(".chat-group.user", { hasText: message });
      const retry = initialTurn.getByRole("button", { name: "Retry queued message" });
      await retry.waitFor({ state: "visible" });
      await pollLocatorText(initialTurn.locator(".chat-send-status")).toContain("Not sent");
      const alert = page.getByRole("alert").filter({ hasText: diagnostic });
      await alert.waitFor({ state: "visible" });
      await pollLocatorText(alert).toContain("startup needs attention");
      expect(await composer.isDisabled()).toBe(false);
      await composer.fill("Follow-up waiting for startup recovery");
      expect(await gateway.getRequests("sessions.send")).toHaveLength(0);

      await retry.click();
      await expectRequest(gateway, "sessions.send", {
        key: sessionKey,
        agentId: "cloud",
        message,
        idempotencyKey: messageId,
      });
      await expect
        .poll(() => page.evaluate((key) => sessionStorage.getItem(key), storageKey))
        .toBeNull();
      await pollCount(alert).toBe(0);
      await pollCount(retry).toBe(0);
      await pollDisabled(composer).toBe(false);
      expect(await composer.inputValue()).toBe("Follow-up waiting for startup recovery");
      await composer.fill("Follow-up after recovery");
      expect(await composer.inputValue()).toBe("Follow-up after recovery");
      expect(await initialTurn.count()).toBe(1);
      expect(await gateway.getRequests("sessions.send")).toHaveLength(1);
      for (const method of [
        "sessions.create",
        "sessions.dispatch",
        "sessions.reclaim",
        "chat.send",
      ]) {
        expect(await gateway.getRequests(method)).toHaveLength(0);
      }
    });
  });

  it("retries an ambiguous cloud create with the same account, session key and machine class", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const draft = page.locator(".new-session-page__message");
    const start = page.getByRole("button", { name: "Start session" });
    const where = page.locator("#new-session-where-trigger");
    const message = "recover the cloud create";
    const account = {
      authProfileId: "personal:person-a:openai:one",
      provider: "openai",
      label: "Test Person · Personal account",
      authType: "api_key",
      selected: false,
    };
    const model = {
      id: "gpt-5.6-luna",
      provider: "openai",
      name: "Luna",
      reasoning: true,
      effectiveFastMode: true,
    };
    const personal = personalModelScenario(model, account, { commands: [] });
    const agents = createCloudAgentsListResponse();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.create"],
      ...personal,
      workspaceGit: true,
      methodResponses: {
        ...personal.methodResponses,
        "agents.list": {
          ...agents,
          agents: [
            {
              ...agents.agents[0],
              model: { primary: "openai/gpt-5.6-luna" },
            },
          ],
        },
        "environments.list": {
          environments: [],
          profiles: [
            {
              id: "aws",
              providerId: "crabbox",
              machines: [
                { id: "standard", label: "Standard", default: true },
                { id: "fast", label: "Fast" },
              ],
            },
          ],
        },
        "worktrees.branches": cloudWorkspaceResponses()["worktrees.branches"],
        "sessions.dispatch": {
          placement: { state: "active", environmentId: "worker-create-recovery" },
        },
        "sessions.send": { runId: "run-create-recovery", status: "started" },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await openEnvironmentPicker(page);
      await page.locator('[data-value="cloud:aws"]').click();
      await page.locator('[data-value="machine:fast"]').click();
      await pollAttribute(where, "data-machine-class").toBe("fast");
      await draft.fill(message);
      await pastePng(draft);
      await expectPastedPngImage(page.getByRole("img", { name: "pixel.png" }));
      await openChatModelPicker(page);
      const picker = page.locator("[data-chat-account-selection]");
      await picker.locator("[data-chat-account-group-toggle]").click();
      await picker.locator(`[data-chat-account-option="account:${account.authProfileId}"]`).click();
      await expect.poll(() => start.getAttribute("aria-disabled")).toBe("false");
      await page.keyboard.press("Escape");
      await page.locator('[data-chat-thinking-select="true"]').click();
      const fastMode = page.locator('[data-chat-speed-option="on"]');
      await pollAttribute(fastMode, "aria-checked").toBe("true");
      await page.locator('[data-chat-speed-option="off"]').click();
      await pollAttribute(fastMode, "aria-checked").toBe("false");
      await page.keyboard.press("Escape");
      await start.click();
      const firstCreate = await gateway.waitForRequest("sessions.create");
      expect(firstCreate.params).toMatchObject({
        fastMode: false,
        model: `openai/gpt-5.6-luna@${account.authProfileId}`,
      });
      const firstKey = (firstCreate.params as { key?: string }).key;
      if (!firstKey) {
        throw new Error("expected the first recovery create to include a session key");
      }
      expect(firstKey).toMatch(/^agent:cloud:dashboard:/);

      await gateway.setMethodResponse("environments.list", environmentProfiles("aws"));
      await page.reload();
      await gateway.waitForRequest("environments.list");
      await pollValue(draft).toBe(message);
      await pollLocatorText(
        page.locator("#new-session-where-trigger .new-session-page__trigger-label"),
      ).toBe("aws");
      expect(await where.getAttribute("data-machine-class")).toBe("fast");
      await gateway.waitForRequest("models.list");

      await expect.poll(() => start.getAttribute("aria-disabled")).toBe("false");
      await start.click();
      const retryCreate = await gateway.waitForRequest("sessions.create");
      expect(retryCreate.params).toMatchObject({
        key: firstKey,
        message: "",
        worktree: true,
        fastMode: false,
        model: `openai/gpt-5.6-luna@${account.authProfileId}`,
      });
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
      await gateway.deferNext("sessions.dispatch");
      await gateway.resolveDeferred("sessions.create", { key: firstKey });

      await expectRequest(gateway, "sessions.dispatch", {
        key: firstKey,
        agentId: "cloud",
        profileId: "aws",
        machineClass: "fast",
      });
      expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
      await gateway.resolveDeferred("sessions.dispatch");
      await expectRequest(gateway, "sessions.send", {
        key: firstKey,
        agentId: "cloud",
        message,
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.send")).toHaveLength(1);
      expect(await gateway.getRequests("users.selectModelAccount")).toHaveLength(0);
      await page.waitForURL((url) => url.pathname === controlUiSessionPath(firstKey), {
        timeout: 30_000,
      });
    } finally {
      await context.close();
    }
  });

  it.each([
    { name: "successful replacement", cleanupError: undefined, replacement: true },
    { name: "failed replacement", cleanupError: "cleanup unavailable", replacement: true },
    { name: "failed original", cleanupError: "cleanup unavailable", replacement: false },
  ])(
    "preserves the current cloud task after $name late cleanup",
    async ({ cleanupError, replacement }) => {
      const viewport = { height: 900, width: 1_280 };
      const context = await suite.browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        ...(replacement ? { viewport } : {}),
      });
      const page = await context.newPage();
      const message = "restart this interrupted cloud task";
      const gateway = await installMockGateway(page, {
        deferredMethods: replacement ? ["sessions.create"] : ["sessions.create", "sessions.delete"],
        workspaceGit: true,
        methodResponses: {
          ...cloudWorkspaceResponses(),
          "sessions.patch": { ok: true },
          ...(replacement
            ? {
                "sessions.delete": { deleted: true },
                "sessions.dispatch": {
                  placement: { state: "active", environmentId: "worker-replacement-create" },
                },
                "sessions.send": { runId: "run-replacement-create", status: "started" },
              }
            : {}),
        },
      });

      try {
        await openCloudDraft(page, gateway);
        const composer = page.locator(".new-session-page__message");
        await composer.fill(message);
        const start = page.getByRole("button", { name: "Start session" });
        await start.click();
        const firstCreate = await gateway.waitForRequest("sessions.create");
        const abandonedKey = String((firstCreate.params as { key?: string }).key);
        const staged = replacement ? null : await readRecovery(page);

        await page.evaluate(() => {
          history.pushState(null, "", "new?agent=cloud");
          dispatchEvent(new PopStateEvent("popstate"));
        });
        if (!replacement) {
          await gateway.resolveDeferred("sessions.create", {
            key: abandonedKey,
            sessionId: "session-late-cloud-create",
          });
          const archive = await gateway.waitForRequest("sessions.patch");
          expect(archive.params).toMatchObject({
            key: abandonedKey,
            agentId: "cloud",
            archived: true,
            expectedSessionId: "session-late-cloud-create",
          });
          await gateway.waitForRequest("sessions.delete");
          await gateway.rejectDeferred("sessions.delete", unavailableError("cleanup unavailable"));
          await expect
            .poll(async () =>
              (await gateway.getRequests("sessions.patch")).some(
                (request) => (request.params as { archived?: unknown }).archived === false,
              ),
            )
            .toBe(true);

          await pollLocatorText(
            page.locator(".new-session-page__error").filter({ hasText: "cleanup unavailable" }),
          ).toContain("cleanup unavailable");
          if (!staged) {
            throw new Error("Expected the original recovery identity");
          }
          expect(await readRecovery(page)).toMatchObject({
            sessionKey: abandonedKey,
            messageId: staged.messageId,
            message,
            target: staged.target,
            agentId: staged.agentId,
            phase: "dispatching",
          });
          return;
        }
        const interrupted = page.getByRole("alert").filter({ hasText: "interrupted" });
        await interrupted.waitFor();
        await pollDisabled(composer).toBe(true);
        await pollDisabled(start).toBe(true);
        const reset = interrupted.getByRole("button", { name: "Reset", exact: true });
        expect(await reset.count()).toBe(1);
        await reset.click();

        await pollCount(interrupted).toBe(0);
        await pollEnabled(composer).toBe(true);
        await pollValue(composer).toBe(message);
        await pollEnabled(start).toBe(true);
        expect(await readRecovery(page)).toBeNull();

        const previousCreateCount = (await gateway.getRequests("sessions.create")).length;
        await gateway.deferNext("sessions.create");
        await start.click();
        const nextCreate = await gateway.waitForRequest("sessions.create", {
          after: previousCreateCount,
        });
        const nextKey = String((nextCreate.params as { key?: string }).key);
        expect(nextKey).not.toBe(abandonedKey);
        const nextRecovery = await readRecovery(page);
        expect(nextRecovery).toMatchObject({
          sessionKey: nextKey,
          message,
          phase: "creating",
          target: { kind: "profile", profileId: "aws" },
        });

        await gateway.deferNext("sessions.delete");
        await gateway.resolveDeferred("sessions.create", {
          key: abandonedKey,
          sessionId: "session-abandoned-create",
        });
        const deleted = await gateway.waitForRequest("sessions.delete");
        expect(deleted.params).toMatchObject({
          key: abandonedKey,
          archivedOnly: true,
          expectedSessionId: "session-abandoned-create",
        });
        if (cleanupError) {
          await gateway.rejectDeferred("sessions.delete", {
            code: "UNAVAILABLE",
            message: cleanupError,
          });
          await page
            .getByRole("alert")
            .filter({ hasText: cleanupError })
            .waitFor({ state: "visible" });
        } else {
          await gateway.resolveDeferred("sessions.delete", { deleted: true });
        }
        const pendingPrompt = page.locator(".new-session-page__starting .chat-group.user");
        await pendingPrompt.waitFor({ state: "visible" });
        await pollLocatorText(pendingPrompt).toContain(message);
        await pollLocatorText(
          page.locator(".new-session-page__starting .chat-working-indicator"),
        ).toContain("Starting");
        expect(await composer.count()).toBe(0);
        await expect
          .poll(() => readRecovery(page))
          .toMatchObject({
            sessionKey: nextKey,
            messageId: nextRecovery?.messageId,
            message,
            phase: "creating",
          });

        await gateway.resolveDeferred("sessions.create", { key: nextKey });
        await expectRequest(gateway, "sessions.dispatch", {
          key: nextKey,
          agentId: "cloud",
          profileId: "aws",
        });
        await expectRequest(gateway, "sessions.send", { key: nextKey, agentId: "cloud", message });
        await page.waitForURL((url) => url.pathname === controlUiSessionPath(nextKey), {
          timeout: 30_000,
        });
      } finally {
        await context.close();
      }
    },
  );

  it("checks an unconfirmed cloud turn without replay when composer storage is unavailable", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const sessionKey = "agent:cloud:storage-recovery";
    const message = "keep this cloud recovery task";
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.send"],
      workspaceGit: true,
      methodResponses: {
        ...cloudWorkspaceResponses(),
        "sessions.create": { key: sessionKey, sessionId: "session-storage-recovery" },
        "sessions.dispatch": {
          ok: true,
          key: sessionKey,
          sessionId: "session-storage-recovery",
          placement: activePlacement("storage-recovery", "/workspace"),
        },
        "sessions.list": sessionList({
          key: sessionKey,
          sessionId: "session-storage-recovery",
          kind: "direct",
          updatedAt: Date.now(),
        }),
        "chat.history": {
          messages: [],
          sessionId: "session-storage-recovery",
          sessionInfo: { hasActiveRun: false, key: sessionKey, status: "done" },
        },
      },
    });

    try {
      await openCloudDraft(page, gateway);
      await page.evaluate(() => {
        const originalSetItem = sessionStorage.setItem.bind(sessionStorage);
        Storage.prototype.setItem = function (key: string, value: string) {
          if (
            key.startsWith("openclaw.new-session.session-placement-recovery.v1:") ||
            key.startsWith("openclaw.control-ui-e2e.")
          ) {
            originalSetItem(key, value);
            return;
          }
          throw new DOMException("composer storage disabled", "SecurityError");
        };
      });
      await page.locator(".new-session-page__message").fill(message);
      await pastePng(page.locator(".new-session-page__message"));
      await page.getByRole("button", { name: "Start session" }).click();
      const firstSend = await gateway.waitForRequest("sessions.send");
      await waitForCommittedChatRoute(page);
      await gateway.rejectDeferred("sessions.send", unavailableError("send outcome unknown"));

      const alert = page.getByRole("alert").filter({ hasText: "send outcome unknown" });
      await pollLocatorText(alert).toContain("send outcome unknown");
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionKey));
      await replaceGatewayClient(page);
      const retainedTurn = page.locator(".chat-group.user", { hasText: message });
      const checkDelivery = retainedTurn.getByRole("button", {
        name: "Check delivery",
        exact: true,
      });
      await checkDelivery.waitFor({ state: "visible" });
      const historyCount = (await gateway.getRequests("chat.history")).length;
      await checkDelivery.click();
      // Background history loads may arrive before this action's request.
      await expect
        .poll(async () => (await gateway.getRequests("chat.history")).slice(historyCount))
        .toContainEqual(
          expect.objectContaining({
            params: {
              sessionKey,
              toolResultMaxChars: 2_000,
              limit: 1000,
              inputRunIds: [(firstSend.params as { idempotencyKey: string }).idempotencyKey],
            },
          }),
        );
      await pollLocatorText(page.getByRole("alert")).toContain("No matching user message");
      await expectPastedPngImage(retainedTurn.locator("img.chat-message-image"));
      const followUp = page.locator(".agent-chat__composer-combobox textarea");
      await pollDisabled(followUp).toBe(false);
      await followUp.fill("Unsent follow-up while checking delivery");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await readRecovery(page)).toMatchObject({
        phase: "paused",
        reason: "unconfirmed",
        messageId: (firstSend.params as { idempotencyKey: string }).idempotencyKey,
        sessionKey,
        message,
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
        target: { kind: "profile", profileId: "aws" },
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.send")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.reclaim")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
