import type { Page } from "playwright";
import { expect, it } from "vitest";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";

const suite = support.createSessionManagementE2eSuite();

const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
const parentKey = "agent:main:flaky-connection";
const childKey = "agent:main:markdown-tooltip";
const siblingKey = "agent:main:archive-copy";
const nestedKey = (index: number) =>
  index === 0 ? childKey : index === 1 ? siblingKey : `agent:main:archive-child-${index + 1}`;
const otherKey = "agent:main:release-notes";

async function openNestedParent(page: Page, childCount: number, workerCount = 0) {
  const children = Array.from({ length: childCount }, (_, index) =>
    sessionRow(nestedKey(index), `Child ${index + 1}`, baseTime - 1_000, { spawnedBy: parentKey }),
  );
  const other = sessionRow(otherKey, "Release notes draft", baseTime - 5_000);
  const workers = Array.from({ length: workerCount }, (_, index) =>
    sessionRow(`agent:main:subagent:archive-worker-${index}`, `Worker ${index}`, baseTime, {
      spawnedBy: parentKey,
    }),
  );
  const controlled = workerCount
    ? [
        sessionRow("agent:main:dashboard:controlled", "Elsewhere", baseTime, {
          parentSessionKey: otherKey,
          controlOwnerSessionKey: parentKey,
        }),
      ]
    : [];
  const listed = [...children, ...workers, ...controlled];
  const parent = sessionRow(parentKey, "Parent", baseTime, {
    childSessions: listed.map((child) => child.key),
  });
  const gateway = await support.installMockGateway(page, {
    sessions: [parent, ...listed, other],
    methodResponses: {
      "sessions.list": {
        cases: [
          { match: { spawnedBy: parentKey }, response: support.sessionsListResponse(listed) },
          ...listed.map((row) => ({
            match: { spawnedBy: row.key },
            response: support.sessionsListResponse([]),
          })),
          { response: support.sessionsListResponse([parent, other]) },
        ],
      },
    },
    sessionKey: otherKey,
  });
  await page.goto(support.controlUiSessionUrl(suite.server.baseUrl, otherKey));
  const drawerToggle = navigationDrawerToggle(page);
  if (page.viewportSize()!.width <= 640) {
    await drawerToggle.waitFor({ state: "visible" });
    await drawerToggle.click();
    await support.waitForMobileSidebarDrawerOpen(page);
  }
  const parentRow = page.locator(`[data-session-key="${parentKey}"]`);
  await parentRow.waitFor({ state: "visible", timeout: 10_000 });
  const listOffset = (await gateway.getRequests("sessions.list")).length;
  await ui.archiveSession(page, parentRow, "sidebar");
  const modal = await support.waitForConfirmModal(page);
  await modal.getByText("Also archive nested sessions?", { exact: true }).waitFor();
  await modal
    .getByText(
      childCount === 1
        ? "“Parent” has 1 directly nested session. If you archive only this session, that nested session moves to the top level."
        : `“Parent” has ${childCount} directly nested sessions. If you archive only this session, those nested sessions move to the top level.`,
      { exact: true },
    )
    .waitFor();
  return { gateway, modal, listOffset };
}

type Gateway = Awaited<ReturnType<typeof support.installMockGateway>>;
async function archivedKeys(gateway: Gateway, methods = ["sessions.patch", "sessions.patchMany"]) {
  const requests = (await Promise.all(methods.map((method) => gateway.getRequests(method)))).flat();
  return requests.flatMap((request) => {
    const params = support.requireRecord(request.params);
    if (Array.isArray(params.targets)) {
      return params.targets.map((target) => String(support.requireRecord(target).key));
    }
    return params.archived === true ? [String(params.key)] : [];
  });
}

suite.define(() =>
  it.each([
    { action: "Archive only this session", childCount: 1, width: 390, keys: [parentKey] },
    { action: "Archive all (2)", childCount: 1, width: 1280, keys: [childKey, parentKey] },
    {
      action: "Archive all (3)",
      childCount: 2,
      workerCount: 22,
      width: 1280,
      keys: [siblingKey, childKey, parentKey],
    },
    {
      action: "Archive all (12)",
      childCount: 11,
      width: 320,
      keys: [...Array.from({ length: 11 }, (_, index) => nestedKey(10 - index)), parentKey],
    },
  ])(
    "nested archive dialog: $action ($width px)",
    ({ action, childCount, workerCount, width, keys }) =>
      ui.withSessionPage(
        suite,
        async (page) => {
          const { gateway, modal, listOffset } = await openNestedParent(
            page,
            childCount,
            workerCount,
          );
          const childReads = (await gateway.getRequests("sessions.list"))
            .slice(listOffset)
            .filter((request) => support.requireRecord(request.params).spawnedBy);
          expect(
            childReads.map((request) => support.requireRecord(request.params).spawnedBy),
          ).toEqual([parentKey]);
          const geometry = await modal.locator("openclaw-modal-actions").evaluate((footer) => {
            const edge = footer.getBoundingClientRect();
            const inset = getComputedStyle(footer);
            // The footer owns the dialog's padding, so buttons align to its content box.
            const box = {
              left: edge.left + Number.parseFloat(inset.paddingLeft),
              right: edge.right - Number.parseFloat(inset.paddingRight),
              bottom: edge.bottom - Number.parseFloat(inset.paddingBottom),
            };
            const buttons = [...footer.querySelectorAll("button")].map((button) => {
              const rect = button.getBoundingClientRect();
              return {
                label: button.textContent?.trim(),
                top: rect.top,
                bottom: rect.bottom,
                left: rect.left,
                right: rect.right,
                unclipped:
                  button.scrollWidth <= button.clientWidth + 1 &&
                  button.scrollHeight <= button.clientHeight + 1,
                contained:
                  rect.left >= box.left - 1 &&
                  rect.right <= box.right + 1 &&
                  rect.bottom <= innerHeight,
              };
            });
            const rowEnds = new Map<number, number>();
            for (const button of buttons) {
              rowEnds.set(
                Math.round(button.top),
                Math.max(rowEnds.get(Math.round(button.top)) ?? 0, button.right),
              );
            }
            return {
              buttons,
              noOverflow: footer.scrollWidth <= footer.clientWidth + 1,
              rowsAligned: [...rowEnds.values()].every((right) => Math.abs(right - box.right) <= 1),
              bottomAligned:
                Math.abs(Math.max(...buttons.map((button) => button.bottom)) - box.bottom) <= 1,
            };
          });
          expect(geometry.noOverflow).toBe(true);
          expect(geometry.rowsAligned).toBe(true);
          expect(geometry.bottomAligned).toBe(true);
          expect(geometry.buttons.every((button) => button.contained && button.unclipped)).toBe(
            true,
          );
          const parentOnly = action === "Archive only this session";
          await ui.button(modal, action).click();
          if (parentOnly) {
            await page.getByText("Session archived", { exact: true }).waitFor();
          }
          expect(await archivedKeys(gateway)).toEqual([]);
          await ui.closeArchiveUndoToast(page);
          if (parentOnly) {
            await expect.poll(() => archivedKeys(gateway)).toEqual(keys);
          } else {
            await expect.poll(() => ui.requestCount(gateway, "sessions.patchMany")).toBe(1);
            expect(await archivedKeys(gateway, ["sessions.patchMany"])).toEqual(keys);
          }
        },
        { colorScheme: "light", viewport: { height: width === 1280 ? 720 : 844, width } },
      ),
  ),
);
