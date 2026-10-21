import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";

const suite = support.createSessionManagementE2eSuite();

const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
const parentKey = "agent:main:flaky-connection";
const childKey = "agent:main:markdown-tooltip";
const otherKey = "agent:main:release-notes";

async function openNestedParent(page: Page) {
  const child = sessionRow(childKey, "Child", baseTime - 1_000, { spawnedBy: parentKey });
  const parent = sessionRow(parentKey, "Parent", baseTime, { childSessions: [childKey] });
  const other = sessionRow(otherKey, "Release notes draft", baseTime - 5_000);
  const gateway = await support.installMockGateway(page, {
    sessions: [parent, child, other],
    methodResponses: {
      "sessions.list": {
        cases: [
          { match: { spawnedBy: parentKey }, response: support.sessionsListResponse([child]) },
          { response: support.sessionsListResponse([parent, other]) },
        ],
      },
    },
    sessionKey: otherKey,
  });
  await page.goto(support.controlUiSessionUrl(suite.server.baseUrl, otherKey));
  const parentRow = page.locator(`[data-session-key="${parentKey}"]`);
  await parentRow.waitFor({ state: "visible", timeout: 10_000 });
  const childRow = page.locator(`[data-session-key="${childKey}"]`);
  if (!(await childRow.isVisible())) {
    await parentRow.locator(".sidebar-child-session-toggle").click();
  }
  await childRow.waitFor({ state: "visible" });
  await parentRow.hover();
  await parentRow.locator("[data-sidebar-session-archive]").click();
  const modal = await support.waitForConfirmModal(page);
  await modal.getByText("Archive session?", { exact: true }).waitFor();
  await modal
    .getByText(
      '"Parent" has a nested session. Archive only this one and it moves to the top level.',
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
    { action: "Archive this session", keys: [parentKey] },
    { action: "Archive 2 sessions", keys: [childKey, parentKey] },
    { action: "Cancel", keys: [] },
  ])("nested archive dialog: $action", ({ action, keys }) =>
    ui.withSessionPage(
      suite,
      async (page) => {
        const { gateway, modal } = await openNestedParent(page);
        const parentOnly = action === "Archive this session";
        if (parentOnly) {
          await support.captureUiProof(suite, page, "nested-archive-dialog.png");
        }
        await ui.button(modal, action).click();
        if (action === "Cancel") {
          await modal.locator("dialog[open]").waitFor({ state: "detached" });
          expect(await archivedKeys(gateway)).toEqual(keys);
        } else if (parentOnly) {
          await expect.poll(() => archivedKeys(gateway)).toEqual(keys);
          await page.getByText("Session archived", { exact: true }).waitFor();
          await support.captureUiProof(suite, page, "nested-archive-this-session.png");
        } else {
          await expect.poll(() => ui.requestCount(gateway, "sessions.patchMany")).toBe(1);
          expect(await archivedKeys(gateway, ["sessions.patchMany"])).toEqual(keys);
        }
      },
      { colorScheme: "light", viewport: { height: 720, width: 1280 } },
    ),
  ),
);
