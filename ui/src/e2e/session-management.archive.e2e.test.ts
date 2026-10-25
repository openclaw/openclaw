import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { expectRequestCountStable, pauseVirtualClock } from "./chat-flow.test-support.ts";
import {
  activateSelfRemovingControl,
  captureUiProof,
  captureUiProofEnabled,
  controlUiSessionPath,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionsListResponse,
  waitForConfirmModal,
  waitForPatch,
} from "./session-management.test-support.ts";
import { expectCount, expectText, withSessionPage } from "./session-page.test-support.ts";
import { chooseSidebarMenuOption, closeSidebarMenu } from "./sidebar-session-menu.test-support.ts";

const suite = createSessionManagementE2eSuite();
const rosterMatch = { includeGlobal: true };
const mainKey = "agent:main:main";
const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
const mainRow = () => sessionRow(mainKey, "Main", baseTime);
const sidebarRow = (page: Page, key: string) =>
  page.locator(`openclaw-app-sidebar .sidebar-recent-session[data-session-key="${key}"]`);
const chatPane = (page: Page) => page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
const menuItem = (page: Page, name: string) =>
  page.locator("openclaw-session-menu").getByRole("menuitem", { name, exact: true });
const expectRoute = (page: Page, key: string, timeout?: number) =>
  expect.poll(() => new URL(page.url()).pathname, { timeout }).toBe(controlUiSessionPath(key));
function installArchiveGateway(
  page: Page,
  rows: Parameters<typeof sessionsListResponse>[0],
  options: Parameters<typeof installMockGateway>[1] = {},
) {
  return installMockGateway(page, {
    sessionKey: mainKey,
    ...options,
    methodResponses: { "sessions.list": sessionsListResponse(rows), ...options.methodResponses },
  });
}
type ArchiveHistory = {
  title: string[];
  paneTitle: string[];
  documentTitle: string[];
  selectedTitle: (string | undefined)[];
};
type ArchiveWindow = Window & { archiveHistory?: ArchiveHistory };
type Gateway = Awaited<ReturnType<typeof installMockGateway>>;
const waitArchive = (gateway: Gateway, key: string, archived: boolean) =>
  waitForPatch(gateway, (params) => params.key === key && params.archived === archived);
const emitChange = (
  gateway: Gateway,
  row: { key: string },
  changes: Record<string, unknown> = {},
) =>
  gateway.emitGatewayEvent("sessions.changed", {
    ...row,
    reason: "update",
    sessionKey: row.key,
    ...changes,
  });

async function confirmDelete(page: Page, proofName?: string) {
  const dialog = await waitForConfirmModal(page);
  if (proofName) {
    await captureUiProof(suite, page, proofName);
  }
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
}

async function setSidebarStatus(page: Page, status: "Archived" | "Active") {
  await page.getByRole("button", { name: "Filter & sort", exact: true }).click();
  await chooseSidebarMenuOption(page, "Status", status);
  await closeSidebarMenu(page);
}

suite.define(() => {
  it("removes an agent-archived selected session without closing its transcript", async () => {
    await withSessionPage(
      suite,
      async (page) => {
        const main = sessionRow("agent:main:main", "Main", 1);
        const target = sessionRow("agent:main:archive-from-agent", "Archive from agent", 2);
        const gateway = await installArchiveGateway(page, [main, target], {
          historyMessages: [
            { role: "assistant", content: [{ type: "text", text: "Work completed." }] },
          ],
          sessionArchiveFiltering: true,
          sessionKey: main.key,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, target.key));
        const row = sidebarRow(page, target.key);
        const pane = chatPane(page);
        const notice = pane.locator(".agent-chat__disabled-banner");
        await row.waitFor({ state: "visible" });
        await pane.getByText("Work completed.", { exact: true }).waitFor();
        await captureUiProof(suite, page, "agent-archive-before.png");

        // Committed agent patch bypasses the menu's optimistic mutation.
        const archived = { ...target, archived: true, archivedAt: 3, updatedAt: 3 };
        await gateway.setSessionsListResponse(sessionsListResponse([main, archived]));
        await emitChange(gateway, archived, {
          agentId: "main",
          reason: "patch",
        });
        await notice.waitFor({ state: "visible" });
        await captureUiProof(suite, page, "agent-archive-received.png");
        await row.waitFor({ state: "detached", timeout: 10_000 });
        expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(target.key));
        await pane.getByText("Work completed.", { exact: true }).waitFor();
        expect(await gateway.getRequests("sessions.patch")).toEqual([]);
        await captureUiProof(suite, page, "agent-archive-after.png");

        await setSidebarStatus(page, "Archived");
        await row.waitFor({ state: "visible" });
        await setSidebarStatus(page, "Active");
        await row.waitFor({ state: "detached" });

        await gateway.setSessionsListResponse(sessionsListResponse([main, target]));
        await emitChange(gateway, target, {
          agentId: "main",
          reason: "patch",
          archived: false,
          archivedAt: null,
          updatedAt: 4,
        });
        await row.waitFor({ state: "visible" });
        await notice.waitFor({ state: "detached" });
      },
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
        ...(captureUiProofEnabled ? { recordVideo: { dir: suite.artifactDir } } : {}),
      },
    );
  });

  it("refreshes the archived sidebar after restoring a session during a stale roster load", async () => {
    await withSessionPage(suite, async (page) => {
      await page.clock.install();
      const updatedAt = baseTime;
      const main = sessionRow("agent:main:main", "Main", updatedAt);
      const archived = sessionRow("agent:main:restore-pending", "Restore pending", updatedAt - 1, {
        archived: true,
      });
      const gateway = await installArchiveGateway(page, [main, archived], {
        methodResponses: { "sessions.patch": {} },
        sessionArchiveFiltering: true,
        sessionKey: main.key,
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await setSidebarStatus(page, "Archived");

      const sidebar = page.locator("openclaw-app-sidebar");
      const archivedRow = sidebar.locator(`[data-session-key="${archived.key}"]`);
      await archivedRow.waitFor({ state: "visible" });
      await captureUiProof(suite, page, "filtered-roster-forced-refresh-before.png");

      const archivedRequests = async () =>
        (await gateway.getRequests("sessions.list", rosterMatch)).filter(
          (request) => requireRecord(request.params).archived === true,
        );
      const initialRequests = (await archivedRequests()).length;
      await gateway.deferNext("sessions.list", { archived: true });
      await pauseVirtualClock(page);
      await emitChange(gateway, archived);
      await page.clock.fastForward(5_001);
      await page.clock.resume();
      await expect.poll(archivedRequests).toHaveLength(initialRequests + 1);

      await archivedRow.hover();
      const routeBeforeRestore = page.url();
      await activateSelfRemovingControl(archivedRow.locator("[data-sidebar-session-archive]"));
      await waitArchive(gateway, archived.key, false);
      expect(page.url()).toBe(routeBeforeRestore);

      await gateway.resolveDeferred("sessions.list", sessionsListResponse([archived]));

      await expect.poll(archivedRequests).toHaveLength(initialRequests + 2);
      await archivedRow.waitFor({ state: "detached" });
    });
  });

  it("deletes every archived thread exactly once when the paged roster reorders", async () => {
    await withSessionPage(suite, async (page) => {
      const keys = ["agent:main:first", "agent:main:repeated", "agent:main:moved"];
      const archived = keys.map((key, index) =>
        sessionRow(key, key.split(":").at(-1) ?? key, 3 - index, { archived: true }),
      );
      const gateway = await installArchiveGateway(page, [archived[0]], {
        methodResponses: {
          "sessions.delete": { ok: true, deleted: true },
        },
      });

      await page.goto(`${suite.server.baseUrl}sessions?status=archived`);
      await page.getByRole("button", { name: "Filters", exact: true }).click();
      const remove = page
        .locator(".sessions-filter-popover:popover-open")
        .getByRole("button", { name: /Delete all archived/ });
      await remove.waitFor();
      await gateway.setMethodResponse("sessions.list", {
        sequence: [
          sessionsListResponse([archived[0], archived[1]], {
            hasMore: true,
            nextOffset: 2,
            totalCount: 3,
          }),
          sessionsListResponse([archived[1]], {
            offset: 2,
            totalCount: 3,
          }),
          sessionsListResponse(archived, { totalCount: 3 }),
        ],
      });
      await remove.click();
      await confirmDelete(page, "styled-confirm-delete-archived.png");

      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.delete")).map(
            (request) => requireRecord(request.params).key,
          ),
        )
        .toEqual(keys);
      for (const request of await gateway.getRequests("sessions.delete")) {
        expect(requireRecord(request.params)).toMatchObject({
          archivedOnly: true,
          deleteTranscript: true,
        });
      }
    });
  });

  it("never deletes a hidden thread selected before changing the roster search", async () => {
    await withSessionPage(suite, async (page) => {
      const alpha = "agent:main:alpha";
      const bravo = "agent:main:bravo";
      const gateway = await installArchiveGateway(
        page,
        [
          mainRow(),
          sessionRow(alpha, "Alpha", baseTime - 3_600_000),
          sessionRow(bravo, "Bravo", baseTime - 7_200_000),
        ],
        { methodResponses: { "sessions.delete": { ok: true, deleted: true } } },
      );

      await page.goto(`${suite.server.baseUrl}sessions`);
      const rowFor = (label: string) =>
        page.locator(".session-data-row").filter({ hasText: label });

      await rowFor("Alpha").locator('input[type="checkbox"]').check();
      await page.locator(".data-table-bulk-bar").getByText("1 selected").waitFor();
      await page.getByRole("button", { name: "Filters", exact: true }).click();
      await page.locator('.sessions-filter-popover:popover-open input[type="text"]').fill("Bravo");

      await expectCount(rowFor("Alpha"), 0);
      await expectCount(page.locator(".data-table-bulk-bar"), 0);

      await rowFor("Bravo").locator('input[type="checkbox"]').check();
      await page
        .locator(".data-table-bulk-bar")
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      await confirmDelete(page);
      await gateway.waitForRequest("sessions.delete");

      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.delete")).map(
            (request) => requireRecord(request.params).key,
          ),
        )
        .toEqual([bravo]);
      const request = (await gateway.getRequests("sessions.delete"))[0];
      expect(requireRecord(request?.params)).toMatchObject({
        key: bravo,
        deleteTranscript: true,
      });
    });
  });

  it("archives a session from the Sessions page context menu and kebab", async () => {
    await withSessionPage(suite, async (page) => {
      const gateway = await installArchiveGateway(
        page,
        [
          mainRow(),
          sessionRow("agent:main:research", "Research notes", baseTime - 3_600_000, {
            hasActiveRun: true,
            status: "running",
          }),
        ],
        { methodResponses: { "sessions.patch": {} } },
      );

      await page.goto(`${suite.server.baseUrl}sessions`);
      const row = page.locator(".session-data-row").filter({ hasText: "Research notes" });
      await row.waitFor({ state: "visible", timeout: 10_000 });

      await row.click({ button: "right" });
      const menuHost = page.locator("openclaw-session-menu");
      await menuHost
        .getByRole("menuitem", { name: "Archive session" })
        .waitFor({ state: "visible" });
      await page.keyboard.press("Escape");

      await row.getByRole("button", { name: "Open session menu" }).click();
      const archiveItem = menuHost.getByRole("menuitem", { name: "Archive session" });
      expect(await archiveItem.isDisabled()).toBe(false);
      await menuHost.getByRole("menuitem", { name: "Advanced", exact: true }).click();
      expect(await menuHost.getByRole("menuitem", { name: "Delete…" }).isDisabled()).toBe(true);
      await page.keyboard.press("ArrowLeft");
      await activateSelfRemovingControl(archiveItem);
      const dialog = await waitForConfirmModal(page);
      await dialog
        .getByText("Active work in this session will be stopped.", { exact: false })
        .waitFor();
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      await dialog.getByRole("button", { name: "Archive session", exact: true }).click();
      const patch = await waitArchive(gateway, "agent:main:research", true);
      expect(requireRecord(patch.params)).toMatchObject({
        archived: true,
        expectedSessionId: "session:agent:main:research",
        key: "agent:main:research",
      });
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.abort")).toEqual([]);
      expect(await gateway.getRequests("agent.wait")).toEqual([]);
    });
  });

  it("hides an archiving thread immediately and restores it only when the request fails", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      recordVideo: captureUiProofEnabled
        ? { dir: suite.artifactDir, size: { height: 900, width: 1280 } }
        : undefined,
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const proofVideo = page.video();
    const sessionKey = "agent:main:research";
    const gateway = await installArchiveGateway(
      page,
      [mainRow(), sessionRow(sessionKey, "Research notes", baseTime - 3_600_000)],
      {
        deferredMethods: ["sessions.patch"],
        historyMessages: [
          { role: "assistant", content: [{ type: "text", text: "Research thread content" }] },
        ],
        mainSessionKey: "agent:main:main",
        sessionArchiveFiltering: true,
        sessionKey,
      },
    );

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const sidebar = page.locator("openclaw-app-sidebar");
      const row = sidebar.locator(`[data-session-key="${sessionKey}"]`);
      const archiveAction = sidebar
        .locator("openclaw-session-menu")
        .getByRole("menuitem", { name: "Archive session", exact: true });
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await page.getByText("Research thread content").waitFor({ state: "visible" });
      await captureUiProof(suite, page, "archive-current-thread-before.png");
      await row.hover();
      await activateSelfRemovingControl(row.locator("[data-sidebar-session-archive]"));
      await gateway.waitForRequest("sessions.patch");

      await row.waitFor({ state: "detached" });
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionKey));
      await page.getByText("Research thread content").waitFor({ state: "visible" });
      expect(await page.locator(".app-toast").count()).toBe(0);
      await captureUiProof(suite, page, "archive-current-thread-pending.png");

      await page.locator(".chat-header-session-menu__trigger").click();
      const pendingAction = page
        .locator("openclaw-chat-header-session-menu")
        .getByRole("menuitem", { name: "Archiving…", exact: true });
      await pendingAction.waitFor();
      expect(await pendingAction.isDisabled()).toBe(true);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(1);
      await page.keyboard.press("Escape");

      await gateway.rejectDeferred("sessions.patch", {
        code: "UNAVAILABLE",
        message: "Session work did not finish stopping. Retry archive after the run stops.",
      });
      await expectText(
        page.locator("[data-sidebar-session-error]"),
        "Session work did not finish stopping",
      );
      await row.waitFor({ state: "visible" });
      await captureUiProof(suite, page, "archive-current-thread-failed.png");

      await gateway.deferNext("sessions.patch");
      await row.click({ button: "right" });
      await activateSelfRemovingControl(archiveAction);
      await expect.poll(async () => (await gateway.getRequests("sessions.patch")).length).toBe(2);
      await row.waitFor({ state: "detached" });

      await gateway.resolveDeferred("sessions.patch");
      await expectText(page.locator(".app-toast"), "Session archived");
      await expectCount(row, 0);
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionKey));
      await page.getByText("Research thread content").waitFor({ state: "visible" });
      await captureUiProof(suite, page, "archive-current-thread-complete.png");
    } finally {
      await context.close();
      if (proofVideo) {
        await proofVideo.saveAs(path.join(suite.artifactDir, "archive-current-thread.webm"));
      }
    }
  });

  it("keeps the selected session through archive refreshes and restores the composer", async () => {
    await withSessionPage(suite, async (page) => {
      const sessionRows = Array.from({ length: 15 }, (_, index) => {
        const title = `Archive refresh ${index}`;
        return sessionRow(
          `agent:main:archive-refresh-${index}`,
          title,
          baseTime - (index + 1) * 1_000,
          index === 2
            ? {
                displayName: undefined,
                label: undefined,
                derivedTitle: title,
                parentSessionKey: mainKey,
                sessionId: `archive-refresh-${index}`,
              }
            : {},
        );
      });
      const selected = sessionRows[2]!;
      const selectedWithoutDerivedTitle = { ...selected, derivedTitle: undefined };
      const archivedAt = baseTime + 1_000;
      const archivedBy = { type: "human" as const, id: "profile-mira", label: "Mira" };
      const batchRows = [sessionRows[0]!, sessionRows[1]!, sessionRows[3]!];
      const gateway = await installArchiveGateway(page, [mainRow(), ...sessionRows], {
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "progressCard.get",
          "sessions.patch",
          "sessions.patchMany",
        ],
        historyMessages: [
          {
            id: "archived-reply",
            role: "assistant",
            timestamp: baseTime - 2_000,
            content: "Reply retained in the transcript.",
            openclawDelivery: { replyToCurrent: true },
          },
        ],
        methodResponses: {
          "progressCard.get": {
            card: {
              revision: 1,
              sessionKey: selected.key,
              steps: [
                { step: "Inspect archive", status: "completed" },
                { step: "Finish archive", status: "in_progress" },
              ],
              updatedAt: baseTime,
            },
          },
          "sessions.patchMany": {
            outcomes: batchRows.map((row) => ({ ok: true, key: row.key, agentId: "main" })),
          },
          "sessions.patch": {},
        },
        sessionArchiveFiltering: true,
      });

      const assertSelectedRoute = async (expectSidebarRow = true) => {
        await expectRoute(page, selected.key);
        if (!expectSidebarRow) {
          return;
        }
        const row = sidebarRow(page, selected.key);
        await row.waitFor({ state: "visible", timeout: 10_000 });
        await expect
          .poll(() => row.getAttribute("class"))
          .toContain("sidebar-recent-session--active");
      };

      await page.goto(`${suite.server.baseUrl}chat`);
      const activePane = chatPane(page);
      const rowFor = (key: string) => sidebarRow(page, key);
      await rowFor(selected.key).waitFor({ state: "visible", timeout: 10_000 });
      await rowFor(selected.key).locator("a").first().click();
      await assertSelectedRoute();
      await activePane.locator(".agent-chat__input textarea").waitFor({ state: "visible" });
      // An unresolved reply_to_current keeps its answer without a reply strip.
      const retainedReply = activePane
        .locator(".chat-group")
        .filter({ hasText: "Reply retained in the transcript." });
      const progressCard = activePane.locator('[data-progress-card-placement="details"]');
      await openChatDetails(activePane);
      await retainedReply.waitFor({ state: "visible" });
      expect(await retainedReply.locator(".chat-reply-attribution").count()).toBe(0);
      await progressCard.waitFor({ state: "visible" });
      await evaluateControlUiContext(
        page,
        (application, sessionKey) => {
          const history: ArchiveHistory = {
            title: [],
            paneTitle: [],
            documentTitle: [],
            selectedTitle: [],
          };
          const record = (titles: string[], title: string | undefined) => {
            if (title && titles.at(-1) !== title) {
              titles.push(title);
            }
          };
          const text = (selector: string) =>
            document.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim();
          const recordTitle = () => {
            record(
              history.title,
              text(
                `.sidebar-recent-session[data-session-key="${sessionKey}"] .sidebar-recent-session__name`,
              ),
            );
            record(
              history.paneTitle,
              text("openclaw-chat-pane.chat-pane-cache__pane--active .chat-pane__session-title"),
            );
            record(history.documentTitle, document.title);
          };
          new MutationObserver(recordTitle).observe(document.documentElement, {
            childList: true,
            characterData: true,
            subtree: true,
          });
          recordTitle();
          (window as ArchiveWindow).archiveHistory = history;
          application.sessions.subscribe((state) => {
            const selectedRow = state.result?.sessions?.find(
              (session) => session.key === sessionKey,
            );
            history.selectedTitle.push(selectedRow?.derivedTitle);
          });
        },
        selected.key,
      );

      for (const row of batchRows) {
        await rowFor(row.key).click({ modifiers: ["Alt"] });
      }
      await rowFor(batchRows[0]!.key).click({ button: "right" });
      const batchMenu = page.locator("openclaw-session-menu");
      await activateSelfRemovingControl(
        batchMenu.getByRole("menuitem", { name: `Archive ${batchRows.length}` }),
      );
      await gateway.waitForRequest("sessions.patchMany");
      for (const row of batchRows) {
        await emitChange(gateway, row, { archived: true });
        await assertSelectedRoute();
      }

      const selectedRow = rowFor(selected.key);
      await gateway.deferNext("sessions.patch", { key: selected.key, archived: true });
      await selectedRow.hover();
      await selectedRow.click({ button: "right" });
      await activateSelfRemovingControl(menuItem(page, "Archive session"));
      await waitArchive(gateway, selected.key, true);
      await gateway.resolveDeferred("sessions.patch", {});
      const archiveToast = page.locator("openclaw-toast-host .app-toast");
      await expectText(archiveToast, "Session archived");
      const archivedSession = await gateway.getSessionRow(selected.key);
      const archivedState = {
        updatedAt: archivedSession.updatedAt,
        archived: true,
        archivedAt,
        archivedBy,
      };
      await gateway.setMethodResponse("sessions.describe", {
        session: { ...selectedWithoutDerivedTitle, ...archivedState },
      });
      await emitChange(gateway, selected, archivedState);
      await selectedRow.waitFor({ state: "detached", timeout: 10_000 });

      await assertSelectedRoute(false);
      const history = await page.evaluate(() => (window as ArchiveWindow).archiveHistory);
      expect(history).toBeDefined();
      expect([history?.title, history?.paneTitle]).toEqual([
        ["Archive refresh 2"],
        ["Archive refresh 2"],
      ]);
      expect(history?.selectedTitle.filter((title) => title !== "Archive refresh 2")).toEqual([]);
      expect(history?.documentTitle).not.toContain("New session — OpenClaw");
      const archivedNotice = activePane.locator(".agent-chat__disabled-banner");
      await archivedNotice.waitFor({ state: "visible", timeout: 10_000 });
      await expectText(archivedNotice, "This session is archived.");
      await expectCount(activePane.locator(".agent-chat__input"), 0);
      await expectCount(retainedReply.locator(".session-run-spinner"), 0);
      await expectCount(progressCard, 0);
      const archiveEvent = activePane.locator(".chat-notice", { hasText: "Archived by Mira" });
      await archiveEvent.waitFor({ state: "visible", timeout: 10_000 });
      await captureUiProof(suite, page, "archive-attribution-notice-after.png");
      await expectCount(activePane.locator(".chat-bubble", { hasText: "Archived by Mira" }), 0);

      await archiveToast.getByRole("button", { name: "Dismiss" }).click();
      await archiveToast.waitFor({ state: "detached" });
      await gateway.deferNext("sessions.patch", { key: selected.key, archived: false });
      await activateSelfRemovingControl(archivedNotice.getByRole("button", { name: "Unarchive" }));
      await waitArchive(gateway, selected.key, false);
      const restoredState = { archived: false, archivedAt: null, archivedBy: null };
      await gateway.setMethodResponse("sessions.describe", {
        session: { ...selectedWithoutDerivedTitle, ...restoredState },
      });
      await gateway.resolveDeferred("sessions.patch");
      const restoredSession = await gateway.getSessionRow(selected.key);
      await emitChange(gateway, selected, {
        ...restoredState,
        updatedAt: restoredSession.updatedAt,
      });

      await assertSelectedRoute();
      await archivedNotice.waitFor({ state: "detached", timeout: 10_000 });
      await archiveEvent.waitFor({ state: "detached", timeout: 10_000 });
      await selectedRow.waitFor({ state: "visible", timeout: 10_000 });
      await activePane.locator(".agent-chat__input textarea").waitFor({ state: "visible" });
      await openChatDetails(activePane);
      await progressCard.waitFor({ state: "visible" });
      await expect
        .poll(() =>
          activePane.evaluate(
            (element) => (element as HTMLElement & { sessionKey?: string }).sessionKey,
          ),
        )
        .toBe(selected.key);
    });
  });

  it("keeps archive state after navigating away and back", async () => {
    await withSessionPage(suite, async (page) => {
      await page.clock.install();
      const main = mainRow();
      const navigationRow = (suffix: string, title: string, offset: number) =>
        sessionRow(`agent:main:dashboard:navigation-${suffix}`, title, baseTime - offset, {
          parentSessionKey: main.key,
          sessionId: `navigation-${suffix}`,
        });
      const target = navigationRow("target", "Navigation target", 1_000);
      const archived = navigationRow("archive", "Navigation archive", 2_000);
      const gateway = await installArchiveGateway(page, [main, target, archived], {
        methodResponses: { "sessions.patch": {} },
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, archived.key));
      const rowFor = (key: string) => sidebarRow(page, key);
      const archivedRow = rowFor(archived.key);
      await archivedRow.waitFor({ state: "visible", timeout: 10_000 });
      await archivedRow.hover();
      await archivedRow.click({ button: "right" });
      await activateSelfRemovingControl(menuItem(page, "Archive session"));
      await waitArchive(gateway, archived.key, true);
      const archivedNotice = chatPane(page).locator(".agent-chat__disabled-banner");
      await archivedNotice.waitFor({ state: "visible", timeout: 10_000 });

      await rowFor(target.key).click();
      await expectRoute(page, target.key);
      await archivedRow.waitFor({ state: "detached", timeout: 10_000 });

      const refresh = async (
        rows: Parameters<typeof sessionsListResponse>[0],
        updatedAt: number,
      ) => {
        await gateway.setMethodResponse("sessions.list", sessionsListResponse(rows));
        const count = (await gateway.getRequests("sessions.list", rosterMatch)).length;
        await pauseVirtualClock(page);
        await emitChange(gateway, target, { updatedAt });
        await page.clock.fastForward(5_001);
        await page.clock.resume();
        await expect
          .poll(async () => (await gateway.getRequests("sessions.list", rosterMatch)).length)
          .toBeGreaterThan(count);
      };
      await refresh([main, target], baseTime + 1_000);
      await refresh(
        [
          { ...main, updatedAt: baseTime + 2_000 },
          { ...target, updatedAt: baseTime + 3_000 },
          { ...archived, archived: false, updatedAt: baseTime + 3_000 },
        ],
        baseTime + 2_000,
      );

      await page.goBack();
      await expectRoute(page, archived.key);
      await archivedNotice.waitFor({ state: "visible", timeout: 10_000 });
      await expectText(archivedNotice, "This session is archived.");
      await archivedRow.waitFor({ state: "detached", timeout: 10_000 });
    });
  });

  it("recovers a deleted active chat without repeatedly resolving its missing session", async () => {
    await withSessionPage(suite, async (page) => {
      await page.clock.install();
      const routeErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error" && message.text().includes("route")) {
          routeErrors.push(message.text());
        }
      });
      const deletedKey = "agent:main:deleted-thread";
      const updatedAt = baseTime;
      const mainSession = sessionRow(mainKey, "Main", updatedAt);
      const beforeText = "Synthetic conversation before deletion.";
      const afterText = "Synthetic main conversation after deletion.";
      const gateway = await installArchiveGateway(
        page,
        [mainSession, sessionRow(deletedKey, "Deleted thread", updatedAt - 1_000)],
        {
          sessionTranscripts: {
            [deletedKey]: {
              messages: [{ role: "assistant", content: beforeText }],
            },
            [mainKey]: {
              messages: [{ role: "assistant", content: afterText }],
            },
          },
        },
      );

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, deletedKey));
      const activePane = page.locator(
        'openclaw-chat-pane.chat-pane-cache__pane--active[aria-hidden="false"]',
      );
      const composer = activePane.locator(".agent-chat__input textarea");
      const oldTranscript = activePane.getByText(beforeText, { exact: true });
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      await oldTranscript.waitFor();

      const requestsBeforeDeletion = (await gateway.getRequests("sessions.list", rosterMatch))
        .length;
      await gateway.setSessionsListResponse(sessionsListResponse([mainSession]));
      await pauseVirtualClock(page);
      await gateway.emitGatewayEvent("sessions.changed", {
        agentId: "main",
        reason: "delete",
        sessionKey: deletedKey,
        sessionId: `session:${deletedKey}`,
      });
      await page.clock.fastForward(5_001);
      await page.clock.resume();

      await expectRoute(page, mainKey, 15_000);
      await activePane.getByText(afterText, { exact: true }).waitFor();
      expect(await oldTranscript.count()).toBe(0);
      await expect
        .poll(() => page.evaluate(() => window.openclawControlUi?.snapshot().sessionKey))
        .toBe(mainKey);
      await expect
        .poll(() =>
          activePane.evaluate(
            (element) => (element as HTMLElement & { sessionKey?: string }).sessionKey,
          ),
        )
        .toBe(mainKey);
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list", rosterMatch)).length)
        .toBeGreaterThan(requestsBeforeDeletion);
      await expect
        .poll(
          async () => {
            const count = (await gateway.getRequests("sessions.list", rosterMatch)).length;
            await new Promise((resolve) => {
              setTimeout(resolve, 350);
            });
            return (await gateway.getRequests("sessions.list", rosterMatch)).length - count;
          },
          { timeout: 5_000 },
        )
        .toBe(0);

      const settledRequestCount = (await gateway.getRequests("sessions.list", rosterMatch)).length;
      await expectRequestCountStable(
        gateway,
        "sessions.list",
        settledRequestCount,
        500,
        rosterMatch,
      );
      expect(routeErrors).toEqual([]);
      await captureUiProof(suite, page, "deleted-active-session-fallback.png");
    });
  });

  it("archive-gates a row-menu delete and keeps the row when the Gateway reports no deletion", async () => {
    await withSessionPage(suite, async (page) => {
      const key = "agent:main:research";
      const gateway = await installArchiveGateway(
        page,
        [mainRow(), sessionRow(key, "Research notes", baseTime - 3_600_000, { archived: true })],
        { methodResponses: { "sessions.delete": { ok: true, deleted: false } } },
      );

      await page.goto(`${suite.server.baseUrl}sessions?status=archived`);
      const row = page.locator(".session-data-row").filter({ hasText: "Research notes" });
      await row.waitFor({ state: "visible", timeout: 10_000 });

      await row.getByRole("button", { name: "Open session menu" }).click();
      await page.getByRole("menuitem", { name: "Advanced", exact: true }).click();
      await activateSelfRemovingControl(menuItem(page, "Delete…"));
      await confirmDelete(page);

      const request = await gateway.waitForRequest("sessions.delete");
      expect(requireRecord(request.params)).toMatchObject({
        archivedOnly: true,
        deleteTranscript: true,
        expectedSessionId: `session:${key}`,
        key,
      });
      await row.waitFor({ state: "visible" });
    });
  });
});
