import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiRoute,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { expectRequestCountStable } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "session active resources" });
const key = "agent:main:resource-demo";
const otherKey = "agent:main:notes";
const row = {
  key,
  sessionId: "desktop-session",
  kind: "direct",
  label: "Desktop work",
  updatedAt: 1000,
  placement: { state: "active", environmentId: "worker-desktop" },
};
const notes = {
  key: otherKey,
  sessionId: "notes-session",
  kind: "direct",
  label: "Notes",
  updatedAt: 900,
};
const environment = {
  id: "worker-desktop",
  type: "worker",
  status: "available",
  desktop: true,
  worker: {
    providerId: "test",
    state: "attached",
    ageMs: 1000,
    attachedSessionIds: ["desktop-session"],
    tunnelStatus: "connected",
  },
};
const list = (active: boolean, snapshotAt?: number) => ({
  sessions: [active ? row : { ...row, placement: { state: "local" }, snapshotAt }, notes],
  count: 2,
  totalCount: 2,
  hasMore: false,
  ts: 1000,
  defaults: {},
  path: "",
});
const featureMethods = [
  ...defaultControlUiFeatureMethods,
  "desktop.observe",
  "environments.list",
  "environments.status",
  "browser.request",
];
const pane = (page: Page) => page.locator(".chat-pane-cache__pane--active");
const withPage = (run: (fixture: { page: Page }) => Promise<void>, width = 1280) =>
  suite.withPage({ serviceWorkers: "block", viewport: { width, height: 900 } }, run);
async function openResources(page: Page, options: Parameters<typeof installMockGateway>[1]) {
  const gateway = await installMockGateway(page, {
    sessionKey: key,
    featureMethods,
    ...options,
  });
  await page.goto(`${suite.server.baseUrl}chat/main/resource-demo`);
  await ready(page);
  return gateway;
}
const ready = async (page: Page) => {
  await waitForControlUiGatewayReady(page);
  await waitForControlUiRoute(page, { routeId: "chat" });
  await pane(page).locator(".sidebar-region").waitFor();
};
async function assertNoProvisioning(gateway: MockGatewayControls) {
  const requests = await gateway.getRequests();
  expect(
    requests.filter(
      (request) =>
        [
          "environments.list",
          "environments.create",
          "desktop.launch",
          "sessions.dispatch",
        ].includes(request.method) ||
        (request.method === "browser.request" &&
          ["/start", "/tabs/open", "/tabs/focus"].includes(
            String(asNullableRecord(request.params)?.path),
          )),
    ),
  ).toEqual([]);
}

suite.define(() => {
  it.each([
    { filtered: false, unfocused: false },
    { filtered: true, unfocused: false },
    { filtered: false, unfocused: true },
    { filtered: true, unfocused: true },
  ])(
    "does not accept old desktop discovery while a newer snapshot is pending (filtered: $filtered, unfocused: $unfocused)",
    async ({ filtered, unfocused }) => {
      await withPage(async ({ page }) => {
        const gateway = await openResources(page, {
          heldMethods: ["environments.status"],
          historyMessages: [{ role: "assistant", content: "Resource ownership proof." }],
          methodResponses: {
            "sessions.list": list(false),
            "environments.status": environment,
          },
        });
        await gateway.waitForRequest("sessions.describe");
        if (unfocused) {
          await page.setViewportSize({ width: 2200, height: 1000 });
          await selectChatLayoutAction(page, "Open split view");
          const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
          await expect.poll(() => panes.count()).toBe(2);
          await panes.last().locator(".agent-chat__composer-combobox textarea").click();
          await expect
            .poll(() =>
              panes
                .first()
                .evaluate((element) => (element as HTMLElement & { active: boolean }).active),
            )
            .toBe(false);
        }
        const ownerPane = unfocused
          ? page.locator("openclaw-chat-pane.chat-split-view__pane").first()
          : pane(page);
        await gateway.setSessionsListResponse(list(true));
        await gateway.emitGatewayEvent("sessions.changed", { key, reason: "patch" });
        await gateway.waitForRequest("environments.status");
        const descriptorReads = (await gateway.getRequests("sessions.describe")).length;
        await gateway.deferNext("sessions.describe");
        await gateway.setSessionsListResponse(
          filtered ? { ...list(false), sessions: [notes] } : list(false),
        );
        await gateway.emitGatewayEvent("sessions.changed", { key, reason: "patch" });
        await gateway.resolveDeferred("environments.status", environment);
        await expectRequestCountStable(gateway, "desktop.observe", 0);
        expect(await ownerPane.getByRole("tab", { name: "Desktop", exact: true }).count()).toBe(0);
        await gateway.waitForRequest("sessions.describe", { after: descriptorReads });
        await gateway.resolveDeferred("sessions.describe");
        await expect
          .poll(() =>
            ownerPane.evaluate((element, sessionKey) => {
              const state = (element as HTMLElement & { state: ChatPageHost }).state;
              return state.sessionsResult?.sessions.find((session) => session.key === sessionKey)
                ?.placement?.state;
            }, key),
          )
          .toBe(filtered ? undefined : "local");
        await expectRequestCountStable(gateway, "desktop.observe", 0);
        expect(await ownerPane.getByRole("tab", { name: "Desktop", exact: true }).count()).toBe(0);
        await assertNoProvisioning(gateway);
      });
    },
  );
});
