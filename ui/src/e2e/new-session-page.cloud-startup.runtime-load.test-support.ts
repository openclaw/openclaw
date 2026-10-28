import type { Locator, Page } from "playwright";
import { describe, expect, it } from "vitest";
import { sessionPlacementRecoveryExactStorageKey } from "../lib/sessions/session-placement-recovery-storage-key.ts";
import type { SessionPlacementPendingRecovery } from "../lib/sessions/session-placement-recovery.ts";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { navigateToControlUiSession } from "../test-helpers/control-ui-e2e.ts";
import { failControlUiModuleForDocuments } from "./control-ui-built-module.test-support.ts";
import type { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  controlUiSessionUrl,
  createdSessionListResult,
  installMockGateway,
  LOCAL_GIT_WORKSPACE_RESPONSES,
  navigateInApp,
  waitForCommittedChatRoute,
  waitForGatewayRecoveryScope,
} from "./new-session-page.test-support.ts";

const button = (scope: Page | Locator, name: string) =>
  scope.getByRole("button", { name, exact: true });
const discardStarts = "Discard unsaved starts and reload";

async function recoverStartup(
  page: Page,
  escape: "saved" | "chat" | "toast",
  suite: ReturnType<typeof createControlUiE2eSuite>,
  moduleRequest: (sourcePath: string) => RegExp,
  buildId: string,
) {
  const incognito = escape !== "saved";
  const sessionKey = "agent:main:startup-load-recovery";
  const sessionId = `session:${sessionKey}`;
  const messageId = "startup-load-first-turn";
  const message = "Continue the saved cloud task";
  const privateKey = "agent:main:private-startup";
  const privateMessage = "Keep this unsent private task in memory";
  const separateDraft = "Keep this separate private draft — café 雪 🦞";
  const gateway = await installMockGateway(page, {
    serverBuildId: buildId,
    workspaceGit: true,
    methodResponses: {
      ...LOCAL_GIT_WORKSPACE_RESPONSES,
      "environments.list": {
        environments: [],
        profiles: [{ id: "test-cloud", providerId: "crabbox" }],
      },
      "sessions.create": { key: privateKey, sessionId: `session:${privateKey}` },
      "sessions.list": createdSessionListResult(sessionKey),
      "sessions.describe": {
        session: { sessionId, placement: { state: "active", environmentId: "cloud-recovery" } },
      },
      "chat.send": {
        cases: [
          {
            match: { idempotencyKey: messageId },
            response: { runId: messageId, status: "started" },
          },
        ],
      },
    },
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  const pane = page.locator(".chat-pane-cache__pane--active");
  const composer = page.locator(".agent-chat__composer-combobox textarea");
  await expect.poll(() => composer.isDisabled()).toBe(false);
  await waitForGatewayRecoveryScope(page);
  const owner = await evaluateControlUiContext(page, (application) => {
    const { gateway: connection } = application;
    return {
      gatewayUrl: connection.connection.gatewayUrl,
      recoveryScope: connection.snapshot.client!.recoveryScope,
    };
  });
  const recovery: SessionPlacementPendingRecovery = {
    ...owner,
    sessionKey,
    sessionId,
    messageId,
    message,
    agentId: "main",
    target: { kind: "profile", profileId: "test-cloud" },
    phase: "dispatching",
  };
  const storageKey = sessionPlacementRecoveryExactStorageKey(
    owner.gatewayUrl,
    owner.recoveryScope,
    sessionKey,
  );
  await page.evaluate(({ key, record }) => sessionStorage.setItem(key, JSON.stringify(record)), {
    key: storageKey,
    record: recovery,
  });
  let documentProbes = 0;
  // Automatic recovery outlives the first failed probe. Keep the outage
  // until the scenario has established the owner that must block reloads.
  let documentReachable = false;
  await page.route("**/*", async (route) => {
    if (route.request().method() === "HEAD") {
      documentProbes += 1;
      if (!documentReachable) {
        await route.fulfill({ status: 503 });
        return;
      }
    }
    await route.fallback();
  });
  const failure = await failControlUiModuleForDocuments(
    page,
    moduleRequest("ui/src/app/session-placement-startup.runtime.ts"),
  );
  await page.reload();
  await expect.poll(failure.documentCount).toBe(1);
  await expect.poll(() => documentProbes).toBeGreaterThan(0);
  const alert = pane.getByRole("alert").filter({ hasText: "startup needs attention" });
  await button(alert, "Retry").waitFor();
  const readStartup = () =>
    evaluateControlUiContext(
      page,
      (application, key) => application.placementStartup.get(key),
      sessionKey,
    );
  const failed = await readStartup();
  await expect.poll(() => page.evaluate(() => Date.now())).toBeGreaterThan(failed!.startedAt);
  for (const selectedKey of ["agent:main:another-task", sessionKey]) {
    await evaluateControlUiContext(
      page,
      (application, key) => {
        application.gateway.setSessionKey(key);
      },
      selectedKey,
    );
    expect(await readStartup()).toEqual(failed);
  }
  await button(alert, "Retry").waitFor();
  const held = await pane.evaluate(async (element) => {
    const { state } = element as HTMLElement & { state: ChatPageHost };
    state.handleChatDraftChange("later ordinary turn");
    await state.handleSendChat();
    return { draft: state.chatMessage, queued: state.chatQueue.map((item) => item.text) };
  });
  expect(held).toEqual({ draft: "", queued: ["later ordinary turn"] });
  await composer.fill("unfinished later draft");
  expect(await gateway.getRequests("chat.send")).toHaveLength(0);
  if (incognito) {
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    await page.locator(".sidebar-rail .sidebar-new-session").click();
    await page.locator("#new-session-where-trigger").click();
    await button(page.locator(".oc-popover.new-session-page__where-popover"), "test-cloud").click();
    await page.getByRole("switch", { name: "Incognito" }).click();
    await page.locator(".new-session-page__message").fill(privateMessage);
    await page.getByRole("button", { name: "Start session" }).click();
    await waitForCommittedChatRoute(page);
    expect(await gateway.waitForRequest("sessions.create")).toMatchObject({
      params: { incognito: true, message: "" },
    });
    const warning = "Recovery needs a reload. Unsaved starts will be lost.";
    for (const selectedKey of [privateKey, sessionKey]) {
      await navigateToControlUiSession(page, selectedKey);
      await expect.poll(() => alert.locator("strong").textContent()).toContain(warning);
      expect(await button(alert, "Retry").count()).toBe(0);
      expect(await alert.locator("details").count()).toBe(0);
    }
    // Restored connectivity must not bypass the live unsaved-start owner.
    const blockedDocumentProbes = documentProbes;
    documentReachable = true;
    await page.setViewportSize({ width: 390, height: 844 });
    // The resize event schedules the shell's mobile layout after the viewport RPC.
    await expect
      .poll(() =>
        alert.evaluate((element) => {
          const text = element.querySelector(".chat-error__content")!.getBoundingClientRect();
          const action = element.querySelector(".chat-error__discard")!.getBoundingClientRect();
          return action.top >= text.bottom && action.right <= innerWidth && action.left >= 0;
        }),
      )
      .toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => {
      navigator.serviceWorker.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "sw-updated", version: "replacement-build" },
        }),
      );
      return new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    });
    expect(
      await page.evaluate(
        ({ text, key }) => ({
          timeOrigin: performance.timeOrigin,
          privateStored: [...Object.values(sessionStorage), ...Object.values(localStorage)].some(
            (value) => value.includes(text),
          ),
          recovery: sessionStorage.getItem(key),
        }),
        { text: privateMessage, key: storageKey },
      ),
    ).toEqual({
      timeOrigin,
      privateStored: false,
      recovery: JSON.stringify(recovery),
    });
    expect(documentProbes).toBe(blockedDocumentProbes);
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    if (escape === "toast") {
      await page.locator(".sidebar-rail .sidebar-new-session").click();
      const privacy = page.getByRole("switch", { name: "Incognito" });
      await privacy.waitFor();
      if (!(await privacy.isChecked())) {
        await privacy.click();
      }
      await page.locator(".new-session-page__message").fill(separateDraft);
    }
    const configRuntime = moduleRequest("ui/src/pages/config/config-page-state.ts");
    await page.route(configRuntime, (route) => route.abort("failed"));
    await navigateInApp(page, "appearance");
    const reload = button(page.locator(".lazy-view-error"), "Reload");
    await reload.waitFor();
    // Route imports may probe to retry in place even when private work
    // blocks document replacement. Manual reload must still stop at the guard.
    const probesBeforeManualReload = documentProbes;
    await reload.click();
    const toast = page.locator(".app-toast__message");
    await expect.poll(() => toast.textContent()).toContain(warning);

    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    expect(documentProbes).toBe(probesBeforeManualReload);
    await page.unroute(configRuntime);
    // Only these explicit actions authorize discarding the unsaved Incognito start.
    if (escape === "toast") {
      const automaticReload = page.waitForEvent("domcontentloaded");
      await button(page.locator("openclaw-toast-host"), discardStarts).click();
      const review = button(page, "Review private draft");
      const outcome = await Promise.race([
        automaticReload.then(() => "reloaded" as const),
        review.waitFor().then(() => "held" as const),
      ]);
      expect(outcome, "discarding a pending start must preserve a separate private draft").toBe(
        "held",
      );
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
      await review.click();
      const dialog = page.locator('openclaw-modal-dialog[label="Unsent Incognito draft"]');
      expect(
        await dialog.getByRole("textbox", { name: "Draft text", exact: true }).inputValue(),
      ).toBe(separateDraft);
      await button(dialog, "Discard this draft and refresh").click();
    } else {
      await navigateToControlUiSession(page, sessionKey);
      await button(alert, discardStarts).click();
    }
  } else {
    // Keep automatic recovery from replacing the document before Retry receives the click.
    await button(alert, "Retry").click();
    documentReachable = true;
  }
  const initialSend = await gateway.waitForRequest("chat.send").catch(async (cause: unknown) => {
    const requestCount = (await gateway.getRequests("chat.send")).length;
    const recoveryPresent = await page.evaluate(
      (key) => sessionStorage.getItem(key) !== null,
      storageKey,
    );
    throw new Error(
      `Initial saved replay did not send (requests=${requestCount}, recoveryPresent=${recoveryPresent})`,
      { cause },
    );
  });
  expect(initialSend).toMatchObject({
    params: {
      sessionKey,
      sessionId,
      expectedLeafEntryId: null,
      message,
      idempotencyKey: messageId,
    },
  });
  if (escape === "toast") {
    // Retained requests do not establish readiness in the reloaded document.
    await waitForControlUiGatewayReady(page);
    await navigateToControlUiSession(page, sessionKey);
  }
  await expect
    .poll(() => page.evaluate((key) => sessionStorage.getItem(key), storageKey))
    .toBeNull();
  await page.locator(".chat-group.user", { hasText: message }).waitFor();
  expect(await composer.inputValue()).toBe("unfinished later draft");
  await gateway.emitChatFinal({
    sessionKey,
    runId: messageId,
    text: "Initial turn finished.",
  });
  const queuedSend = await gateway
    .waitForRequest("chat.send", { after: 1 })
    .catch(async (cause: unknown) => {
      const requestCount = (await gateway.getRequests("chat.send")).length;
      const recoveryPresent = await page.evaluate(
        (key) => sessionStorage.getItem(key) !== null,
        storageKey,
      );
      throw new Error(
        `Queued follow-up did not send (requests=${requestCount}, recoveryPresent=${recoveryPresent})`,
        { cause },
      );
    });
  expect(queuedSend).toMatchObject({
    params: { sessionKey, message: "later ordinary turn" },
  });
  expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
  expect(await gateway.getRequests("chat.send")).toHaveLength(2);
  expect(await gateway.getSocketCount()).toBe(1);
  expect(failure.documentCount()).toBe(2);
  if (incognito) {
    expect(
      await evaluateControlUiContext(
        page,
        (application, key) => application.placementStartup.hasPendingTurn(key),
        privateKey,
      ),
    ).toBe(false);
  }
}

export function defineStartupRecoveryModuleBoundaryTests(
  suite: ReturnType<typeof createControlUiE2eSuite>,
  moduleRequest: (sourcePath: string) => RegExp,
  buildId: string,
) {
  describe("Control UI startup recovery production E2E", () => {
    it.each(["saved", "chat", "toast"] as const)(
      "recovers a saved startup through %s recovery",
      (escape) =>
        suite.withPage(
          { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
          ({ page }) => recoverStartup(page, escape, suite, moduleRequest, buildId),
        ),
    );
  });
}
