import type { Page } from "playwright";
import { expect, it } from "vitest";
import { getControlUiContextHandle } from "../test-helpers/control-ui-e2e-context.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const draft = "変換中";
const finalTitle = "確定した名前";
const original = sessionRow(
  "agent:main:rename-composition",
  "Original session",
  Date.parse("2026-08-27T12:00:00.000Z"),
);

async function openRename(page: Page) {
  const gateway = await installMockGateway(page, {
    methodResponses: { "sessions.list": sessionsListResponse([original]) },
    sessionKey: original.key,
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, original.key));
  const sidebarRow = page.locator(`.sidebar-recent-session[data-session-key="${original.key}"]`);
  await sidebarRow.waitFor({ state: "visible" });
  const title = page.locator(".chat-pane__session-title-button");
  await title.click();
  const input = page.locator(".chat-pane__session-title-input");
  await expect.poll(() => input.inputValue()).toBe(original.label);
  await input.fill(draft);
  return { gateway, title, input, sidebarRow };
}

suite.define(() => {
  it.each([
    { kind: "modern", key: "Enter", isComposing: true, keyCode: 0, invalidateMetadata: false },
    { kind: "legacy", key: "Escape", isComposing: false, keyCode: 229, invalidateMetadata: true },
  ] as const)(
    "keeps the rename draft during $kind composition $key until ordinary Enter",
    async ({ key, isComposing, keyCode, invalidateMetadata }) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const { gateway, title, input, sidebarRow } = await openRename(page);

        // Exercise the browser keyboard contract, not a native OS IME candidate window.
        const prevented = await input.evaluate(
          (element, args) =>
            !element.dispatchEvent(
              new KeyboardEvent("keydown", {
                ...args,
                bubbles: true,
                cancelable: true,
                composed: true,
              }),
            ),
          { key, isComposing, keyCode },
        );

        expect(prevented).toBe(false);
        expect(await input.count()).toBe(1);
        expect(await input.inputValue()).toBe(draft);
        expect(await gateway.getRequests("sessions.patch")).toEqual([]);

        // Keep the browser object: provenance follows its identity across cache invalidation.
        await using application = await getControlUiContextHandle(page);
        await using sampledSession = await application.evaluateHandle(
          async (context, sessionKey) =>
            (await context.sessions.describe({ key: sessionKey, agentId: "main" })).session,
          original.key,
        );
        expect(await sampledSession.evaluate((session) => session?.label)).toBe(original.label);
        const rosterMatch = { includeGlobal: true };
        await gateway.deferNext("sessions.list", rosterMatch);
        const beforeRename = (await gateway.getRequests("sessions.list", rosterMatch)).length;
        await input.fill(finalTitle);
        await input.press("Enter");
        const committed = await waitForPatch(gateway, (params) => params.label === finalTitle);
        expect(committed.params).toMatchObject({
          key: original.key,
          expectedSessionId: original.sessionId,
          label: finalTitle,
        });
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(1);
        await input.waitFor({ state: "detached" });
        await gateway.waitForRequest("sessions.list", {
          after: beforeRename,
          match: rosterMatch,
        });
        // A real metadata event may retire the cache while this older sample is in flight.
        // Its sampling clock must still keep the old title from winning by delivery order.
        if (invalidateMetadata) {
          await gateway.emitGatewayEvent("chat.metadata.changed", {});
        }
        await application.evaluate((context, session) => {
          context.sessions.captureReconcile()(session ?? undefined);
        }, sampledSession);
        await gateway.resolveDeferred("sessions.list");
        await expect.poll(() => title.textContent()).toContain(finalTitle);
        await expect.poll(() => sidebarRow.textContent()).toContain(finalTitle);
      });
    },
  );
});
