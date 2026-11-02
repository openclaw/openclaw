import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  createSessionManagementE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const key = "agent:main:reliability";

suite.define(() => {
  it.for([
    { scope: "operator.admin", offPage: false },
    { scope: "operator.sessions.read", offPage: false },
    { scope: "operator.sessions.read", offPage: true },
  ])(
    "reorders personal pins without changing rail shortcuts or shared groups ($scope; off-page: $offPage)",
    async ({ scope, offPage }) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const keys = [key, "agent:main:release", "agent:main:research"];
        const pins = keys.map((sessionKey, index) =>
          createControlUiSessionRow(
            sessionKey,
            ["Reliability Tracker", "Release checklist", "Research notes"][index]!,
            Date.now() - index * 1000,
          ),
        );
        const selected = offPage
          ? createControlUiSessionRow("agent:main:selected", "Selected chat", Date.now())
          : pins[0]!;
        const gateway = await installMockGateway(page, {
          sessionKey: selected.key,
          operatorScopes: [scope],
          sessions: offPage ? [selected, ...pins] : pins,
          methodResponses: {
            "sessions.list": sessionsListResponse(offPage ? [selected] : pins),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected.key));
        if (offPage) {
          // Seed saved references through their owner; their rows are absent from sessions.list.
          await evaluateControlUiContext(
            page,
            ({ navigation }, entries) => navigation.update({ sidebarEntries: entries }),
            keys.map((sessionKey) => `session:${sessionKey}`),
          );
        }
        const sidebar = page.locator("openclaw-app-sidebar");
        const row = (sessionKey: string) =>
          sidebar.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
        if (!offPage) {
          for (const sessionKey of keys) {
            await row(sessionKey).hover();
            await row(sessionKey).getByRole("button", { name: "Pin session", exact: true }).click();
            await row(sessionKey)
              .getByRole("button", { name: "Unpin session", exact: true })
              .waitFor();
          }
        }
        const pinned = sidebar.locator('[data-session-section="pinned"]');
        const pinOrder = () =>
          pinned
            .locator(".sidebar-recent-session")
            .evaluateAll((rows) => rows.map((element) => element.getAttribute("data-session-key")));
        await expect.poll(pinOrder).toEqual(keys);
        const rail = sidebar.locator(".sidebar-rail__pins");
        await row(key).dragTo(rail);
        const shortcut = rail.locator(`[data-sidebar-entry="session-rail:${key}"]`);
        await shortcut.waitFor();
        await row(keys[2]!).dragTo(row(key), { targetPosition: { x: 80, y: 4 } });
        await expect.poll(pinOrder).toEqual([keys[2], key, keys[1]]);
        const target = row(keys[1]!);
        const height = await target.evaluate((element) => element.getBoundingClientRect().height);
        await row(key).dragTo(target, { targetPosition: { x: 80, y: height - 4 } });
        const expected = [keys[2], keys[1], key];
        await expect.poll(pinOrder).toEqual(expected);
        // Dropping on itself must not bubble to a container and append the pin.
        await row(keys[2]!).dragTo(row(keys[2]!), { targetPosition: { x: 80, y: 4 } });
        expect(await pinOrder()).toEqual(expected);
        await page.reload();
        await expect.poll(pinOrder).toEqual(expected);
        expect(await shortcut.count()).toBe(1);
        expect(await gateway.getRequests("sessions.patch")).toEqual([]);
        expect(await gateway.getRequests("sessions.groups.put")).toEqual([]);
      });
    },
  );
});
