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

async function openNestedParent(page: Page, childCount: number) {
  const children = Array.from({ length: childCount }, (_, index) =>
    sessionRow(nestedKey(index), `Child ${index + 1}`, baseTime - 1_000, { spawnedBy: parentKey }),
  );
  const parent = sessionRow(parentKey, "Parent", baseTime, {
    childSessions: children.map((child) => child.key),
  });
  const other = sessionRow(otherKey, "Release notes draft", baseTime - 5_000);
  const gateway = await support.installMockGateway(page, {
    sessions: [parent, ...children, other],
    methodResponses: {
      "sessions.list": {
        cases: [
          { match: { spawnedBy: parentKey }, response: support.sessionsListResponse(children) },
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
  await ui.archiveSession(page, parentRow, "sidebar");
  const modal = await support.waitForConfirmModal(page);
  await modal.getByText("Also archive nested sessions?", { exact: true }).waitFor();
  await modal
    .getByText(
      childCount === 1
        ? '"Parent" has 1 directly nested session. If you archive only this session, that nested session moves to the top level.'
        : `"Parent" has ${childCount} directly nested sessions. If you archive only this session, those nested sessions move to the top level.`,
      { exact: true },
    )
    .waitFor();
  return { gateway, modal };
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
      action: "Archive all (12)",
      childCount: 11,
      width: 320,
      keys: [...Array.from({ length: 11 }, (_, index) => nestedKey(10 - index)), parentKey],
    },
  ])("nested archive dialog: $action ($width px)", ({ action, childCount, width, keys }) =>
    ui.withSessionPage(
      suite,
      async (page) => {
        const { gateway, modal } = await openNestedParent(page, childCount);
        const geometry = await modal.locator(".exec-approval-actions").evaluate((footer) => {
          const box = footer.getBoundingClientRect();
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
        expect(geometry.buttons.every((button) => button.contained && button.unclipped)).toBe(true);
        const parentOnly = action === "Archive only this session";
        await ui.button(modal, action).click();
        if (parentOnly) {
          await expect.poll(() => archivedKeys(gateway)).toEqual(keys);
          await page.getByText("Session archived", { exact: true }).waitFor();
        } else {
          await expect.poll(() => ui.requestCount(gateway, "sessions.patchMany")).toBe(1);
          expect(await archivedKeys(gateway, ["sessions.patchMany"])).toEqual(keys);
        }
      },
      { colorScheme: "light", viewport: { height: width === 1280 ? 720 : 844, width } },
    ),
  ),
);
