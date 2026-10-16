import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionsListResponse,
  waitForConfirmModal,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
const parentKey = "agent:main:flaky-connection";
const childKey = "agent:main:markdown-tooltip";
const otherKey = "agent:main:release-notes";

async function openNestedParent() {
  const context = await suite.browser.newContext({
    colorScheme: "light",
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 720, width: 1280 },
  });
  const page = await context.newPage();
  const child = sessionRow(childKey, "Fix flaky markdown file tooltip", baseTime - 1_000, {
    spawnedBy: parentKey,
  });
  const parent = sessionRow(parentKey, "Web UI flaky connection resilience", baseTime, {
    childSessions: [childKey],
  });
  const other = sessionRow(otherKey, "Release notes draft", baseTime - 5_000);
  const gateway = await installMockGateway(page, {
    sessions: [parent, child, other],
    methodResponses: {
      "sessions.list": {
        cases: [
          { match: { spawnedBy: parentKey }, response: sessionsListResponse([child]) },
          { response: sessionsListResponse([parent, other]) },
        ],
      },
    },
    sessionKey: otherKey,
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, otherKey));
  const parentRow = page.locator(`[data-session-key="${parentKey}"]`);
  await parentRow.waitFor({ state: "visible", timeout: 10_000 });
  const childRow = page.locator(`[data-session-key="${childKey}"]`);
  if (!(await childRow.isVisible())) {
    await parentRow.locator(".sidebar-child-session-toggle").click();
  }
  await childRow.waitFor({ state: "visible" });
  await parentRow.hover();
  await parentRow.locator("[data-sidebar-session-archive]").click();
  const modal = await waitForConfirmModal(page);
  await modal.getByText("Archive session?", { exact: true }).waitFor();
  await modal
    .getByText(
      '"Web UI flaky connection resilience" has a nested session. Archive only this one and it moves to the top level.',
      { exact: true },
    )
    .waitFor();
  return { context, page, gateway, modal };
}

function archivedKeys(requests: readonly { params?: unknown }[]) {
  return requests.flatMap((request) => {
    const params = requireRecord(request.params);
    if (Array.isArray(params.targets)) {
      return params.targets.map((target) => String(requireRecord(target).key));
    }
    return params.archived === true ? [String(params.key)] : [];
  });
}

suite.define(() => {
  it("asks before archiving a session with nested sessions and archives only the parent", async () => {
    const { context, page, gateway, modal } = await openNestedParent();
    try {
      await captureUiProof(suite, page, "nested-archive-dialog.png");
      await modal.getByRole("button", { name: "Archive this session", exact: true }).click();
      await expect
        .poll(async () =>
          archivedKeys([
            ...(await gateway.getRequests("sessions.patch")),
            ...(await gateway.getRequests("sessions.patchMany")),
          ]),
        )
        .toEqual([parentKey]);
      await page.getByText("Session archived", { exact: true }).waitFor();
      await captureUiProof(suite, page, "nested-archive-this-session.png");
    } finally {
      await context.close();
    }
  });

  it("archives the whole nested tree from the same dialog", async () => {
    const { context, gateway, modal } = await openNestedParent();
    try {
      await modal.getByRole("button", { name: "Archive 2 sessions", exact: true }).click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.patchMany")).length)
        .toBe(1);
      const [request] = await gateway.getRequests("sessions.patchMany");
      expect(archivedKeys([request!])).toEqual([childKey, parentKey]);
    } finally {
      await context.close();
    }
  });

  it("archives nothing when the dialog is cancelled", async () => {
    const { context, gateway, modal } = await openNestedParent();
    try {
      await modal.getByRole("button", { name: "Cancel", exact: true }).click();
      await modal.locator("dialog[open]").waitFor({ state: "detached" });
      expect(
        archivedKeys([
          ...(await gateway.getRequests("sessions.patch")),
          ...(await gateway.getRequests("sessions.patchMany")),
        ]),
      ).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
