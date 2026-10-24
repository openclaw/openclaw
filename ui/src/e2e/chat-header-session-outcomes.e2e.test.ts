import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import {
  chatSessionListResponse,
  controlUiSessionPath,
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  newChatPage,
} from "./chat-flow.test-support.ts";
import { polledCount, twoFrames } from "./chat-presentation.test-support.ts";
import { chooseSidebarMenuOption, closeSidebarMenu } from "./sidebar-session-menu.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionA = "agent:main:session-a";
const sessionB = "agent:main:session-b";
type HeaderSession = GatewaySessionRow & {
  key: string;
  kind: string;
  label: string;
  updatedAt: number;
};

function readPane(element: Element) {
  const pane = element as HTMLElement & {
    sessionKey?: string;
    state?: { chatError?: string | null };
  };
  return { sessionKey: pane.sessionKey, chatError: pane.state?.chatError };
}

async function navigateAwayAndBack(
  page: Page,
  navigation: "sidebar" | "history" = "sidebar",
): Promise<void> {
  for (const sessionKey of [sessionB, sessionA]) {
    if (navigation === "history") {
      await (sessionKey === sessionB ? page.goBack() : page.goForward());
    } else {
      await page
        .locator(
          `.sidebar-recent-session[data-session-key="${sessionKey}"] a.sidebar-recent-session__link`,
        )
        .click();
    }
    await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionKey));
    const pane = page.locator(".chat-pane-cache__pane--visible");
    await expect.poll(() => pane.evaluate(readPane)).toMatchObject({ sessionKey });
  }
}

function sessionPair(extras: Partial<GatewaySessionRow>[] = []) {
  return [sessionA, sessionB].map((key, index) => {
    const row: HeaderSession = {
      key,
      kind: "direct",
      label: `Session ${index ? "B" : "A"}`,
      updatedAt: 2 - index,
    };
    return Object.assign(row, extras[index]);
  });
}

function installHeader(
  page: Page,
  rows: HeaderSession[],
  methods: string[],
  options: Parameters<typeof installMockGateway>[1] = {},
) {
  return installMockGateway(page, {
    historyMessages: [{ role: "assistant", content: "Session outcome proof." }],
    sessionKey: rows[0]!.key,
    featureMethods: ["chat.startup", ...methods],
    methodResponses: { "sessions.list": chatSessionListResponse(rows) },
    ...options,
  });
}

async function expectRetiredError(page: Page, message: string) {
  await polledCount(page.getByText(message)).toBe(0);
  const pane = page.locator(".chat-pane-cache__pane--visible");
  await expect.poll(() => pane.evaluate(readPane)).not.toMatchObject({ chatError: message });
}

async function installPlacementGateway(page: Page) {
  return installHeader(
    page,
    sessionPair([
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
    ["sessions.reclaim"],
  );
}

async function startPlacementReclaim(
  page: Page,
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
): Promise<void> {
  await gateway.deferNext("sessions.reclaim");
  const details = await openChatDetails(page);
  await details.locator(".chat-environment__machine-trigger").click();
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
      const gateway = await installHeader(
        page,
        [session],
        ["sessions.reclaim", "sessions.dispatch"],
        { sessionInfo: session },
      );

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const details = await openChatDetails(page);
      await details.locator(".chat-environment__machine-trigger").click();
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
      const checkMenu = async () => {
        await sidebarMenu
          .getByRole("menuitem", {
            name: restartable ? "Restore session" : "Archive session",
          })
          .waitFor();
        const stop = sidebarMenu.getByRole("menuitem", { name: "Stop cloud worker…" });
        await polledCount(stop).toBe(restartable ? 0 : 1);
        return stop;
      };
      await checkMenu();

      await page.goto(`${suite.server.baseUrl}sessions?status=all`);
      const sessionsRow = page.locator(".session-data-row").filter({ hasText: session.label });
      await sessionsRow.click({ button: "right" });
      const stopWorker = await checkMenu();
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

  it.each(["reveal", "placement"] as const)(
    "does not resurrect a %s failure after navigating away",
    async (action) => {
      const page = await newChatPage(suite);
      const reveal = action === "reveal";
      const gateway = reveal
        ? await installHeader(
            page,
            sessionPair([
              { spawnedCwd: "/workspace/session-a" },
              { spawnedCwd: "/workspace/session-b" },
            ]),
            ["sessions.files.reveal"],
          )
        : await installPlacementGateway(page);
      if (reveal) {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionA));
        await gateway.deferNext("sessions.files.reveal");
        await page.getByRole("button", { name: "Workspace actions for session-a" }).click();
        await page.getByRole("menuitem", { name: "Open in file manager" }).click();
        await gateway.waitForRequest("sessions.files.reveal");
      } else {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionB));
        await page
          .locator(
            `.sidebar-recent-session[data-session-key="${sessionA}"] a.sidebar-recent-session__link`,
          )
          .click();
        await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionA));
        await startPlacementReclaim(page, gateway);
      }
      await navigateAwayAndBack(page, reveal ? "sidebar" : "history");
      const message = `Stale ${action} failure must stay retired.`;
      if (reveal) {
        await gateway.resolveDeferred("sessions.files.reveal", { ok: false, error: message });
        await twoFrames(page);
      } else {
        expect(await gateway.getRequests("sessions.reclaim")).toHaveLength(1);
        await gateway.rejectDeferred("sessions.reclaim", { code: "INVALID_REQUEST", message });
        await page
          .getByRole("dialog", { name: "Stop worker?", exact: true })
          .waitFor({ state: "hidden" });
      }
      await expectRetiredError(page, message);
    },
  );

  it("keeps a current placement reclaim failure visible and retryable", async () => {
    const page = await newChatPage(suite);
    const gateway = await installPlacementGateway(page);

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionA));
    await startPlacementReclaim(page, gateway);
    const message = "Current placement failure stays actionable.";
    await gateway.rejectDeferred("sessions.reclaim", { code: "INVALID_REQUEST", message });

    const visiblePane = page.locator(".chat-pane-cache__pane--visible");
    await expect.poll(() => visiblePane.evaluate(readPane)).toMatchObject({ sessionKey: sessionA });
    await visiblePane.getByRole("alert").getByText(message, { exact: true }).waitFor();
    const dialog = page.getByRole("dialog", { name: "Stop worker?", exact: true });
    await expect
      .poll(() => dialog.getByRole("button", { name: "Stop worker", exact: true }).isEnabled())
      .toBe(true);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });

    const details = await openChatDetails(page);
    await details.locator(".chat-environment__machine-trigger").click();
    await page.getByText("Stop cloud worker…", { exact: true }).waitFor();
  });

  it("does not resurrect a sharing failure after navigating away", async () => {
    const page = await newChatPage(suite);
    const gateway = await installHeader(
      page,
      sessionPair([
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
      ["session.visibility.set"],
      { allowedSessionVisibilities: ["shared", "draft"] },
    );

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionA));
    await gateway.deferNext("session.visibility.set");
    await page.getByRole("button", { name: "Session sharing" }).click();
    const sharing = page.locator(".chat-pane__sharing-menu").filter({ visible: true });
    await sharing.getByRole("menuitem", { name: "Session access", exact: true }).click();
    await sharing.getByRole("menuitemradio", { name: "Shared", exact: true }).click();
    await gateway.waitForRequest("session.visibility.set");

    await navigateAwayAndBack(page);
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
