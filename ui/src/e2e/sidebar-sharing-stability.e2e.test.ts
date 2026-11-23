import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  pauseVirtualClock,
  reconnectMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as row } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  waitForSessionRosterHydration,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const pinnedSelector = '[data-session-section="pinned"]';
const rowsSelector = ".sidebar-recent-session[data-session-key]";

suite.define(() => {
  it("keeps the pinned sidebar stable when changing a chat to Draft", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 820 }, locale: "en-US", colorScheme: "dark" },
      async ({ page }) => {
        const target = row("agent:main:chat:proof", "Release planning", 900, {
          sharingRole: "owner",
          visibility: "shared",
        });
        const pins = [
          row("agent:main:chat:reading", "Reading list", 800),
          target,
          row("agent:main:chat:research", "Research notes", 700),
        ];
        const other = Array.from({ length: 44 }, (_, i) =>
          row("agent:main:chat:other-" + i, "Project chat " + (i + 1), 600 - i),
        );
        const rows = [target, ...other];
        const offPageMatch = { key: pins[2]!.key };
        const sidebarMatch = { source: "sidebar" };
        const owner = { type: "human", id: "owner", label: "Owner" };
        await page.addInitScript(
          ({ key, entries }) => {
            localStorage.setItem(
              key,
              JSON.stringify({ sidebarAgentsMode: "chip", railShortcuts: entries }),
            );
          },
          {
            key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
            entries: pins.map(({ key }) => "session:" + key),
          },
        );
        const gateway = await installMockGateway(page, {
          sessionKey: target.key,
          sessions: [...rows, pins[0]!, pins[2]!],
          historyMessages: [
            { role: "assistant", content: "The release checklist is ready for review." },
          ],
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "session.visibility.set",
            "session.members.listEvidence",
            "session.publicShare.set",
          ],
          operatorScopes: ["operator.read", "operator.write"],
          methodResponses: {
            "sessions.list": sessionsListResponse(rows),
            "session.members.listEvidence": {
              sessionKey: target.key,
              owner,
              members: [],
              identities: [owner],
              permissions: [],
              role: "owner",
              allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
            },
            "session.visibility.set": { ok: true, sessionKey: target.key, visibility: "draft" },
          },
        });
        await page.clock.install();
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, target.key));
        await page.getByText("The release checklist is ready for review.").waitFor();
        await waitForSessionRosterHydration(page);
        const pinned = page.locator(pinnedSelector);
        const pinnedRows = pinned.locator(rowsSelector);
        await expect.poll(() => pinnedRows.count()).toBe(3);
        const trigger = page.locator(".chat-pane__sharing-trigger").filter({ visible: true });
        await trigger.click();
        const panel = page.locator(".chat-pane__sharing-panel");
        await panel.waitFor();
        await panel.locator('[data-value="access"]').click();
        const draftOption = panel.locator('[data-value="visibility:draft"]');
        await draftOption.waitFor();
        const sidebar = page.locator("aside.sidebar");
        const scroller = sidebar.locator(".sidebar-shell__body");
        const probe = await sidebar.evaluateHandle(
          (root, selectors) => {
            const section = root.querySelector(selectors.pinned)!;
            const nodes = Array.from(section.querySelectorAll(selectors.rows));
            const removals = new Set<Element>();
            const body = root.querySelector(".sidebar-shell__body")!;
            const observer = new MutationObserver((records) => {
              for (const record of records) {
                for (const removed of record.removedNodes) {
                  for (const node of nodes) {
                    if (removed.contains(node)) {
                      removals.add(node);
                    }
                  }
                }
              }
            });
            observer.observe(root, { subtree: true, childList: true });
            const read = () => ({
              order: Array.from(
                root.querySelector(selectors.pinned)?.querySelectorAll(selectors.rows) ?? [],
                (node) => node.getAttribute("data-session-key"),
              ),
              sameNodes: nodes.every(
                (node) =>
                  node ===
                  root
                    .querySelector(selectors.pinned)
                    ?.querySelector(
                      selectors.rows +
                        '[data-session-key="' +
                        node.getAttribute("data-session-key") +
                        '"]',
                    ),
              ),
              removed: Array.from(removals, (node) => node.getAttribute("data-session-key")),
              scroll: body.scrollTop,
              expanded: root
                .querySelector(selectors.pinned)
                ?.querySelector("[aria-expanded]")
                ?.getAttribute("aria-expanded"),
              startup: Boolean(root.querySelector(".sidebar-session-empty-hint--startup")),
              focus:
                document.activeElement?.getAttribute("data-session-key") ??
                document.activeElement?.getAttribute("aria-label"),
            });
            return { read, observer };
          },
          { pinned: pinnedSelector, rows: rowsSelector },
        );
        const listCount = async () => (await gateway.getRequests("sessions.list")).length;
        const initial = await probe.evaluate(({ read }) => read());
        const initialLists = await listCount();
        await gateway.deferNext("session.visibility.set");
        await gateway.deferNext("sessions.list", sidebarMatch);
        const descriptions = await gateway.deferNext("sessions.describe", offPageMatch);
        await draftOption.click();
        await gateway.waitForRequest("session.visibility.set", {
          match: { sessionKey: target.key, visibility: "draft" },
        });
        const draft = { ...target, visibility: "draft" };
        await gateway.setSessionRow(draft);
        await gateway.setMethodResponse(
          "sessions.list",
          sessionsListResponse([draft, ...rows.slice(1)]),
        );
        await gateway.emitGatewayEvent("session.sharing", {
          action: "visibility",
          sessionKey: target.key,
          agentId: "main",
          visibility: "draft",
          actor: owner,
          ts: Date.now(),
        });
        await gateway.emitGatewayEvent("sessions.changed", {
          session: draft,
          sessionKey: target.key,
          agentId: "main",
          reason: "sharing",
          ancestorSessions: [],
          ts: Date.now(),
        });
        await gateway.emitGatewayEvent("sessions.changed", { reason: "sharing", ts: Date.now() });
        await gateway.resolveDeferred("session.visibility.set");
        await gateway.waitForRequest("sessions.list", { after: initialLists });
        await gateway.waitForRequest("sessions.describe", {
          after: descriptions,
          match: offPageMatch,
        });
        const during = await probe.evaluate(({ read }) => read());
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await page.screenshot({
            path: suite.artifactDir + "/during.png",
            animations: "disabled",
          });
        }
        await gateway.resolveDeferred("sessions.list", undefined, { match: sidebarMatch });
        await gateway.resolveDeferred("sessions.describe", undefined, { match: offPageMatch });
        await expect.poll(() => pinnedRows.count()).toBe(3);
        await pauseVirtualClock(page);
        await page.clock.runFor(16_000);
        await page.clock.resume();
        const after = await probe.evaluate(({ read, observer }) => {
          observer.disconnect();
          return read();
        });
        const requests = (await gateway.getRequests("sessions.list")).slice(initialLists);
        console.info("PINNED SHARING", JSON.stringify({ initial, during, after, requests }));
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await page.screenshot({
            path: suite.artifactDir + "/settled.png",
            animations: "disabled",
          });
        }
        expect(during.order).toEqual(initial.order);
        expect(after.order).toEqual(initial.order);
        expect(after.sameNodes).toBe(true);
        expect(after.removed).toEqual([]);
        expect(after.scroll).toBe(initial.scroll);
        expect(after.expanded).toBe("true");
        expect(during.startup || after.startup).toBe(false);
        expect(after.focus).toBe("Session access");
        expect(
          requests.filter(
            (request) => (request.params as { source?: string }).source === "sidebar",
          ),
        ).toHaveLength(1);

        // Title changes update the held pin; activity may reorder Other but must
        // not override the personal pin order.
        await page.keyboard.press("Escape");
        const keys = () =>
          pinnedRows.evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute("data-session-key")),
          );
        const sidebarLists = () => gateway.getRequests("sessions.list", sidebarMatch);
        const otherLinks = sidebar
          .locator('[data-session-section="ungrouped"]')
          .locator(rowsSelector);
        const moved = { ...other[2]!, updatedAt: 1_500, hasActiveRun: true, status: "running" };
        const renamed = {
          ...pins[2]!,
          displayName: "Research backlog",
          label: "Research backlog",
          updatedAt: 750,
        };
        const emitRow = (reason: string, session: typeof target) =>
          gateway.emitGatewayEvent("sessions.changed", {
            reason,
            session,
            sessionKey: session.key,
            agentId: "main",
            ancestorSessions: [],
            ts: Date.now(),
          });
        await gateway.setSessionRow(renamed);
        await gateway.setSessionRow(moved);
        const beforeLive = (await sidebarLists()).length;
        await emitRow("title", renamed);
        await pinned.getByText("Research backlog", { exact: true }).waitFor();
        await emitRow("run-start", moved);
        await expect
          .poll(() => otherLinks.first().getAttribute("data-session-key"))
          .toBe(moved.key);
        expect(await keys()).toEqual(initial.order);
        expect(await sidebarLists()).toHaveLength(beforeLive);

        // Share back through the same real control. A bystander then receives
        // only the redacted packet when an off-page pin becomes inaccessible.
        await trigger.click();
        await panel.locator('[data-value="access"]').click();
        await gateway.deferNext("session.visibility.set");
        await panel.locator('[data-value="visibility:shared"]').click();
        await gateway.waitForRequest("session.visibility.set", {
          match: { sessionKey: target.key, visibility: "shared" },
        });
        await gateway.setSessionRow(target);
        await gateway.setMethodResponse(
          "sessions.list",
          sessionsListResponse([target, moved, ...other.filter(({ key }) => key !== moved.key)]),
        );
        await gateway.emitGatewayEvent("session.sharing", {
          action: "visibility",
          sessionKey: target.key,
          agentId: "main",
          visibility: "shared",
          actor: owner,
          ts: Date.now(),
        });
        await emitRow("sharing", target);
        await gateway.emitGatewayEvent("sessions.changed", { reason: "sharing", ts: Date.now() });
        await gateway.resolveDeferred("session.visibility.set", {
          ok: true,
          sessionKey: target.key,
          visibility: "shared",
        });
        await panel.locator('[data-value="access"]').waitFor();
        await panel.getByText("Shared", { exact: true }).waitFor();
        await page.keyboard.press("Escape");
        expect(await keys()).toEqual(initial.order);

        await sidebar.getByRole("button", { name: "Show more", exact: true }).click();
        await expect
          .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight))
          .toBeGreaterThanOrEqual(35);
        const focusRow = pinned.getByRole("link", { name: "Reading list", exact: true });
        await focusRow.focus();
        await scroller.evaluate((element) => {
          element.scrollTop = 35;
        });
        await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(35);
        const focus = await focusRow.elementHandle();
        const newDescriptions = await gateway.deferNext("sessions.describe", offPageMatch);
        const revokeLists = (await sidebarLists()).length;
        await gateway.emitGatewayEvent("sessions.changed", { reason: "sharing", ts: Date.now() });
        await gateway.waitForRequest("sessions.describe", {
          after: newDescriptions,
          match: offPageMatch,
        });
        expect(await keys()).toEqual(initial.order);
        expect(await focus!.evaluate((node) => node === document.activeElement)).toBe(true);
        expect(await scroller.evaluate((element) => element.scrollTop)).toBe(35);
        await gateway.resolveDeferred(
          "sessions.describe",
          { session: null },
          { match: offPageMatch },
        );
        await pinned.getByText("Research backlog", { exact: true }).waitFor({ state: "detached" });
        expect(await keys()).toEqual(initial.order.slice(0, 2));
        await gateway.waitForRequest("sessions.list", { after: revokeLists, match: sidebarMatch });
        expect(await focus!.evaluate((node) => node === document.activeElement)).toBe(true);

        await focusRow.hover();
        await pinned
          .locator(rowsSelector)
          .filter({ hasText: "Reading list" })
          .getByRole("button", { name: "Unpin session", exact: true })
          .click();
        await expect.poll(keys).toEqual([target.key]);
        // An on-page chat can be pinned explicitly without changing the saved order of other pins.
        const newest = otherLinks.filter({ hasText: "Project chat 3" });
        await newest.hover();
        await newest.getByRole("button", { name: "Pin session", exact: true }).click();
        await expect.poll(keys).toEqual([target.key, moved.key]);
        const beforeReconnect = (await sidebarLists()).length;
        await gateway.setMethodResponse("sessions.describe", {
          cases: [{ match: offPageMatch, response: { session: null } }],
        });
        await reconnectMockGateway(page, gateway);
        await gateway.waitForRequest("sessions.list", {
          after: beforeReconnect,
          match: sidebarMatch,
        });
        await expect.poll(keys).toEqual([target.key, moved.key]);
      },
    );
  });
});
