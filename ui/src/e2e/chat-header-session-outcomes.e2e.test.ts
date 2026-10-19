import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  chatSessionListResponse,
  controlUiSessionPath,
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  newChatPage,
} from "./chat-flow.test-support.ts";
import { chooseSidebarMenuOption, closeSidebarMenu } from "./sidebar-session-menu.test-support.ts";

const suite = createChatFlowE2eSuite();

async function navigateAwayAndBack(page: Page, sessionA: string, sessionB: string): Promise<void> {
  for (const sessionKey of [sessionB, sessionA]) {
    await page
      .locator(
        `.sidebar-recent-session[data-session-key="${sessionKey}"] a.sidebar-recent-session__link`,
      )
      .click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionKey));
    await expect
      .poll(() =>
        page
          .locator(".chat-pane-cache__pane--visible")
          .evaluate((pane) => (pane as HTMLElement & { sessionKey?: string }).sessionKey),
      )
      .toBe(sessionKey);
  }
}

function sessionPair(
  sessionA: string,
  sessionB: string,
  extras: Partial<GatewaySessionRow>[] = [],
) {
  return [sessionA, sessionB].map((key, index) =>
    Object.assign(
      {
        key,
        kind: "direct" as const,
        label: `Session ${index ? "B" : "A"}`,
        updatedAt: 2 - index,
      },
      extras[index],
    ),
  );
}

async function expectRetiredError(page: Page, message: string) {
  await expect.poll(() => page.getByText(message).count()).toBe(0);
  await expect
    .poll(() =>
      page
        .locator(".chat-pane-cache__pane--visible")
        .evaluate(
          (pane) =>
            (pane as HTMLElement & { state?: { chatError?: string | null } }).state?.chatError,
        ),
    )
    .not.toBe(message);
}

async function installPlacementGateway(page: Page, sessionA: string, sessionB: string) {
  return installMockGateway(page, {
    featureMethods: ["chat.startup", "sessions.reclaim"],
    historyMessages: [{ role: "assistant", content: "Placement outcome proof." }],
    methodResponses: {
      "sessions.list": chatSessionListResponse(
        sessionPair(sessionA, sessionB, [
          {
            placement: {
              state: "active",
              generation: 1,
              createdAtMs: 1,
              updatedAtMs: 1,
              stateChangedAtMs: 1,
              environmentId: "worker:one",
              activeOwnerEpoch: 1,
              workerBundleHash: "a".repeat(64),
              workspaceBaseManifestRef: "base-manifest",
              remoteWorkspaceDir: "/workspace/session-a",
            },
          },
        ]),
      ),
    },
    sessionKey: sessionA,
  });
}

async function startPlacementReclaim(
  page: Page,
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  sessionA: string,
): Promise<void> {
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionA));
  await gateway.deferNext("sessions.reclaim");
  await page.getByRole("button", { name: "Runs on Cloud" }).click();
  await page.getByText("Stop cloud worker…", { exact: true }).click();
  await page.getByRole("button", { name: "Stop worker" }).click();
  await gateway.waitForRequest("sessions.reclaim");
}

suite.define(() => {
  it.each(["restart", "stop-first"] as const)(
    "offers failed worker actions from %s recovery across session menus",
    async (recoveryAction) => {
      const page = await newChatPage(suite);
      const restartable = recoveryAction === "restart";
      const sessionKey = `agent:main:failed-worker-${recoveryAction}`;
      const session = {
        key: sessionKey,
        kind: "direct",
        label: "Failed worker recovery",
        sessionId: `failed-worker-${recoveryAction}`,
        updatedAt: Date.now(),
        archived: restartable,
        hasActiveRun: false,
        activeRunIds: [],
        placement: {
          state: "failed",
          generation: 2,
          createdAtMs: 1,
          updatedAtMs: 2,
          stateChangedAtMs: 2,
          recoveryAction,
          recoveryError: restartable
            ? "Cloud worker disappeared: worker provider no longer recognizes the lease."
            : "Cloud worker cleanup is still pending.",
        },
      } satisfies GatewaySessionRow;
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.startup", "sessions.reclaim", "sessions.dispatch"],
        historyMessages: [{ role: "assistant", content: "Worker recovery proof." }],
        methodResponses: { "sessions.list": chatSessionListResponse([session]) },
        sessionInfo: session,
        sessionKey,
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await page.getByRole("button", { name: "Runs on worker", exact: true }).click();
      const headerMenu = page.locator(".chat-pane__placement-menu");
      await headerMenu
        .getByText(restartable ? "Restart session…" : "Stop worker…", { exact: true })
        .waitFor();
      await expect
        .poll(() => headerMenu.getByText("Stop worker…", { exact: true }).count())
        .toBe(restartable ? 0 : 1);
      await page.keyboard.press("Escape");

      if (restartable) {
        await page.getByRole("button", { name: "Unarchive", exact: true }).waitFor();
        await page.getByRole("button", { name: "Filter & sort", exact: true }).click();
        await chooseSidebarMenuOption(page, "Status", "All");
        await closeSidebarMenu(page);
      }
      const sidebarRow = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
      await sidebarRow.hover();
      await sidebarRow.click({ button: "right" });
      const sidebarMenu = page.locator("openclaw-session-menu");
      await sidebarMenu
        .getByRole("menuitem", { name: restartable ? "Restore session" : "Archive session" })
        .waitFor();
      await expect
        .poll(() => sidebarMenu.getByRole("menuitem", { name: "Stop cloud worker…" }).count())
        .toBe(restartable ? 0 : 1);

      await page.goto(`${suite.server.baseUrl}sessions?status=all`);
      const sessionsRow = page.locator(".session-data-row").filter({ hasText: session.label });
      await sessionsRow.click({ button: "right" });
      const sessionsMenu = page.locator("openclaw-session-menu");
      await sessionsMenu
        .getByRole("menuitem", { name: restartable ? "Restore session" : "Archive session" })
        .waitFor();
      const stopWorker = sessionsMenu.getByRole("menuitem", { name: "Stop cloud worker…" });
      await expect.poll(() => stopWorker.count()).toBe(restartable ? 0 : 1);
      if (!restartable) {
        await gateway.deferNext("sessions.reclaim");
        await stopWorker.click();
        await page.getByRole("button", { name: "Stop worker", exact: true }).click();
        const reclaim = await gateway.waitForRequest("sessions.reclaim");
        expect(reclaim.params).toEqual({ key: sessionKey, agentId: "main" });
      } else {
        expect(await gateway.getRequests("sessions.reclaim")).toHaveLength(0);
      }
    },
  );

  it("does not resurrect a reveal failure after navigating away", async () => {
    const page = await newChatPage(suite);
    const sessionA = "agent:main:session-a";
    const sessionB = "agent:main:session-b";
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.startup", "sessions.files.reveal"],
      historyMessages: [{ role: "assistant", content: "Session outcome proof." }],
      methodResponses: {
        "sessions.list": chatSessionListResponse(
          sessionPair(sessionA, sessionB, [
            { spawnedCwd: "/workspace/session-a" },
            { spawnedCwd: "/workspace/session-b" },
          ]),
        ),
      },
      sessionKey: sessionA,
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionA));
    await gateway.deferNext("sessions.files.reveal");
    await page.getByRole("button", { name: "Workspace actions for session-a" }).click();
    await page.getByRole("menuitem", { name: "Open in file manager" }).click();
    await gateway.waitForRequest("sessions.files.reveal");

    await navigateAwayAndBack(page, sessionA, sessionB);
    await gateway.resolveDeferred("sessions.files.reveal", {
      ok: false,
      error: "Stale reveal failure must stay retired.",
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await expectRetiredError(page, "Stale reveal failure must stay retired.");
  });

  it("does not resurrect a placement reclaim failure after navigating away", async () => {
    const page = await newChatPage(suite);
    const sessionA = "agent:main:placement-a";
    const sessionB = "agent:main:placement-b";
    const gateway = await installPlacementGateway(page, sessionA, sessionB);

    await startPlacementReclaim(page, gateway, sessionA);

    await navigateAwayAndBack(page, sessionA, sessionB);
    const message = "Stale placement failure must stay retired.";
    await gateway.rejectDeferred("sessions.reclaim", { code: "INVALID_REQUEST", message });
    await expectRetiredError(page, message);
  });

  it("keeps a current placement reclaim failure visible and retryable", async () => {
    const page = await newChatPage(suite);
    const sessionA = "agent:main:placement-current";
    const sessionB = "agent:main:placement-other";
    const gateway = await installPlacementGateway(page, sessionA, sessionB);

    await startPlacementReclaim(page, gateway, sessionA);
    const message = "Current placement failure stays actionable.";
    await gateway.rejectDeferred("sessions.reclaim", { code: "INVALID_REQUEST", message });

    const visiblePane = page.locator(".chat-pane-cache__pane--visible");
    await expect
      .poll(() =>
        visiblePane.evaluate((pane) => (pane as HTMLElement & { sessionKey?: string }).sessionKey),
      )
      .toBe(sessionA);
    await visiblePane.getByRole("alert").getByText(message, { exact: true }).waitFor();

    await page.getByRole("button", { name: "Runs on Cloud" }).click();
    await page.getByText("Stop cloud worker…", { exact: true }).waitFor();
  });

  it("does not resurrect a sharing failure after navigating away", async () => {
    const page = await newChatPage(suite);
    const sessionA = "agent:main:sharing-a";
    const sessionB = "agent:main:sharing-b";
    const gateway = await installMockGateway(page, {
      allowedSessionVisibilities: ["shared", "draft"],
      featureMethods: ["chat.startup", "session.visibility.set"],
      historyMessages: [{ role: "assistant", content: "Sharing outcome proof." }],
      methodResponses: {
        "sessions.list": chatSessionListResponse(
          sessionPair(sessionA, sessionB, [
            {
              sessionId: "sharing-session-a",
              sharingRole: "owner",
              visibility: "draft",
            },
            {
              sessionId: "sharing-session-b",
              sharingRole: "owner",
              visibility: "shared",
            },
          ]),
        ),
      },
      sessionKey: sessionA,
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionA));
    await gateway.deferNext("session.visibility.set");
    await page.getByRole("button", { name: "Session sharing" }).click();
    await page.getByText("Publish draft", { exact: true }).click();
    await gateway.waitForRequest("session.visibility.set");

    await navigateAwayAndBack(page, sessionA, sessionB);
    const message = "Stale sharing failure must stay retired.";
    await gateway.rejectDeferred("session.visibility.set", {
      code: "INVALID_REQUEST",
      message,
    });
    await expect.poll(() => page.getByText(message).count()).toBe(0);
    await page.getByRole("button", { name: "Session sharing" }).click();
    await expect.poll(() => page.locator(".chat-pane__sharing-status--error").count()).toBe(0);
  });
});
