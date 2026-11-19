import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";

const suite = support.createSessionManagementE2eSuite();
const group = "Website refresh";
const outsideGroup = "Release work";
const now = Date.parse("2026-11-19T12:00:00Z");
const home = sessionRow("agent:main:main", "Home", now);
const parentKey = "agent:main:dashboard:site-map";
const child = sessionRow("agent:main:dashboard:verify-links", "Verify links", now - 3, {
  parentSessionKey: parentKey,
});
const outside = sessionRow("agent:main:dashboard:release", "Write release notes", now - 4, {
  category: outsideGroup,
  parentSessionKey: parentKey,
  sidebarRoot: true,
});
const roots = [
  sessionRow(parentKey, "Website sitemap", now - 1, {
    category: group,
    childSessions: [child.key, outside.key],
  }),
  sessionRow("agent:main:dashboard:migration", "Migrate pages", now - 2, { category: group }),
  ...Array.from({ length: 99 }, (_, index) =>
    sessionRow(
      `agent:main:dashboard:site-${index}`,
      `Website task ${index + 1}`,
      now - 10 - index,
      { category: group },
    ),
  ),
];

suite.define(() => {
  it("confirms and archives every page of a group and its nested sessions, without archiving another group", () =>
    ui.withSessionPage(suite, async (page) => {
      const gateway = await support.installMockGateway(page, {
        sessionKey: home.key,
        sessionGroups: [group, outsideGroup],
        sessionArchiveFiltering: true,
        sessions: [home, ...roots, child, outside],
        methodResponses: {
          "sessions.list": {
            cases: [
              {
                match: { group, offset: 0 },
                response: support.sessionsListResponse(roots.slice(0, 100), {
                  totalCount: 101,
                  hasMore: true,
                  nextOffset: 100,
                }),
              },
              {
                match: { group, offset: 100 },
                response: support.sessionsListResponse(roots.slice(100), {
                  totalCount: 101,
                  offset: 100,
                }),
              },
              {
                match: { group: outsideGroup, offset: 0 },
                response: support.sessionsListResponse([outside]),
              },
              {
                match: { spawnedBy: parentKey },
                response: support.sessionsListResponse([child, outside]),
              },
              { response: support.sessionsListResponse([home, ...roots.slice(0, 2), outside]) },
            ],
          },
        },
      });
      await page.goto(support.controlUiSessionUrl(suite.server.baseUrl, home.key));
      const menuFor = async (name: string) => {
        const options = page.getByRole("button", { name: `Group options for ${name}` });
        await options.locator("..").hover();
        await options.click();
        const menu = page.getByRole("menu", { name: `Group options for ${name}` });
        await menu.waitFor({ state: "visible" });
        return menu;
      };
      const menu = await menuFor(group);
      const archiveItem = menu.getByRole("menuitem", { name: "Archive all", exact: true });
      const deleteItem = menu.getByRole("menuitem", { name: "Delete group", exact: true });
      const separator = await menu.getByRole("separator").elementHandle();
      expect(
        await archiveItem.evaluate(
          (item, divider) =>
            Boolean(item.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_PRECEDING),
          separator,
        ),
      ).toBe(true);
      await separator.dispose();
      const color = (item: typeof archiveItem) =>
        item.evaluate((element) => getComputedStyle(element).color);
      expect(await color(archiveItem)).toBe(await color(deleteItem));
      expect(await color(archiveItem)).not.toBe(
        await color(menu.getByRole("menuitem", { name: "New group", exact: true })),
      );
      await archiveItem.click({ timeout: 5_000 });
      const modal = await support.waitForConfirmModal(page);
      await modal.getByText("Are you sure you want to archive?", { exact: true }).waitFor();
      await modal.getByText("102 sessions", { exact: true }).waitFor();
      await modal.getByRole("button", { name: "Cancel" }).click();
      expect(await gateway.getRequests("sessions.patchMany")).toEqual([]);

      await (await menuFor(outsideGroup)).getByRole("menuitem", { name: "Archive all" }).click();
      const single = await support.waitForConfirmModal(page);
      await single.getByText("1 session", { exact: true }).waitFor();
      await single.getByRole("button", { name: "Cancel" }).click();

      await (await menuFor(group)).getByRole("menuitem", { name: "Archive all" }).click();
      const confirm = await support.waitForConfirmModal(page);
      await confirm.getByRole("button", { name: "Archive all (102)" }).click();
      await page.getByText("Archived 102 sessions", { exact: true }).waitFor();
      expect(await gateway.getRequests("sessions.patchMany")).toEqual([]);
      await ui.closeArchiveUndoToast(page);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.patchMany")).length)
        .toBe(2);
      const targets = (await gateway.getRequests("sessions.patchMany")).flatMap((request) => {
        const params = support.requireRecord(request.params);
        expect(params.patch).toEqual({ archived: true });
        return (params.targets as unknown[]).map(support.requireRecord);
      });
      expect(new Set(targets.map((target) => target.key))).toEqual(
        new Set([...roots.map((row) => row.key), child.key]),
      );
      expect(targets).toHaveLength(102);
      expect(targets[0]).toMatchObject({
        key: child.key,
        expectedSessionId: child.sessionId,
        expectedSidebarAncestors: [{ key: parentKey, expectedCategory: group }],
      });
      await page.getByText(outside.label, { exact: true }).waitFor();
    }));
});
