import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { DESKTOP_PANEL_TOGGLE_EVENT } from "../components/panel-toggle-contract.ts";
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
import { dockChatSidePanel, openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installScriptedRfbServer } from "./desktop-rfb-test-support.ts";

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
const desktopTab = (page: Page) => pane(page).getByRole("tab", { name: "Desktop", exact: true });
const desktop = {
  transport: "rfb",
  wsPath: "/desktop/observe?proof=1",
  expiresAtMs: 60000,
  control: false,
};
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
  it.each(["mobile", "reclaim", "swap", "explicit-target", "stale-roster"] as const)(
    "reveals a running desktop on direct entry and respects reload (%s)",
    async (scenario) => {
      const width = scenario === "mobile" ? 390 : 1280;
      const staleRoster = scenario === "stale-roster";
      const explicitTargetOnReload = scenario === "explicit-target";
      await withPage(async ({ page }) => {
        const explicitEnvironmentId = "manual-desktop";
        const gateway = await openResources(page, {
          sessions: [row, notes],
          deferredMethods: ["desktop.observe"],
          historyMessages: [{ role: "assistant", content: "Your existing desktop is ready." }],
          methodResponses: {
            "sessions.list": list(!staleRoster, staleRoster ? 1000 : undefined),
            "environments.status": explicitTargetOnReload
              ? {
                  cases: [
                    {
                      match: { environmentId: explicitEnvironmentId },
                      response: { ...environment, id: explicitEnvironmentId },
                    },
                    {
                      match: { environmentId: "worker-desktop" },
                      response: environment,
                    },
                  ],
                }
              : environment,
            "desktop.observe": desktop,
          },
        });
        await desktopTab(page).waitFor();
        const observe = await gateway.waitForRequest("desktop.observe");
        expect(observe.params).toEqual({
          source: { kind: "environment", environmentId: "worker-desktop" },
          control: false,
        });
        const rfb = await installScriptedRfbServer(page);
        await gateway.resolveDeferred("desktop.observe");
        await pane(page).locator(".desktop-surface canvas").waitFor();
        await expect.poll(rfb.events).toEqual(["authenticated:1"]);
        expect(await desktopTab(page).count()).toBe(1);
        const chatBox = await pane(page).locator(".sidebar-region__primary").boundingBox();
        const desktopBox = await pane(page).locator(".desktop-surface").boundingBox();
        expect(desktopBox!.width).toBeLessThanOrEqual(width);
        if (width === 390) {
          expect(chatBox).toBeNull();
          expect(desktopBox!.width).toBeGreaterThan(width - 32);
          expect(desktopBox!.height).toBeGreaterThan(100);
        } else {
          expect(chatBox!.height).toBeGreaterThan(100);
        }
        if (explicitTargetOnReload) {
          const explicitSource = { kind: "environment", environmentId: explicitEnvironmentId };
          await gateway.deferNext("desktop.observe", { source: explicitSource });
          await page.evaluate(
            ({ eventName, ...detail }) =>
              window.dispatchEvent(new CustomEvent(eventName, { detail })),
            {
              eventName: DESKTOP_PANEL_TOGGLE_EVENT,
              open: true,
              sessionKey: key,
              environmentId: explicitEnvironmentId,
            },
          );
          const explicitObserve = await gateway.waitForRequest("desktop.observe", {
            match: { source: explicitSource },
          });
          expect(explicitObserve.params).toEqual({ source: explicitSource, control: false });
          await gateway.resolveDeferred("desktop.observe");
          await pane(page).locator(".desktop-surface canvas").waitFor();
          await expect.poll(rfb.events).toContain("authenticated:2");
          await assertNoProvisioning(gateway);

          await page.reload();
          await ready(page);
          await desktopTab(page).waitFor();
          const restoredObserve = await gateway.waitForRequest("desktop.observe");
          expect(restoredObserve.params).toEqual({ source: explicitSource, control: false });
          const restoredRfb = await installScriptedRfbServer(page);
          await gateway.resolveDeferred("desktop.observe");
          await pane(page).locator(".desktop-surface canvas").waitFor();
          await expect.poll(restoredRfb.events).toEqual(["authenticated:1"]);
          expect(await desktopTab(page).count()).toBe(1);
        } else if (scenario === "stale-roster") {
          await selectChatLayoutAction(pane(page), /^Swap /);
          await pane(page).locator(".desktop-surface canvas").waitFor();
          await openChatSidePanelType(page, "Browser");
          const reads = (await gateway.getRequests("desktop.observe")).length;
          await pane(page).getByRole("button", { name: "Close Browser", exact: true }).click();
          await expectRequestCountStable(gateway, "desktop.observe", reads);
          expect(await pane(page).locator(".desktop-surface canvas").isVisible()).toBe(true);
          expect(await pane(page).getByRole("tab", { name: "Browser", exact: true }).count()).toBe(
            0,
          );
        } else if (scenario === "swap") {
          await selectChatLayoutAction(pane(page), /^Swap /);
          await page.reload();
          await ready(page);
          await desktopTab(page).waitFor();
          await gateway.waitForRequest("desktop.observe");
          await installScriptedRfbServer(page);
          await gateway.resolveDeferred("desktop.observe");
          await pane(page).locator(".desktop-surface canvas").waitFor();
          expect(await desktopTab(page).count()).toBe(1);
        } else if (scenario === "reclaim") {
          await dockChatSidePanel(page, "bottom");
          await gateway.setSessionsListResponse(list(false));
          await gateway.setMethodResponse("sessions.describe", {
            session: { ...row, placement: { state: "local" } },
          });
          await page.reload();
          await ready(page);
          await gateway.waitForRequest("sessions.describe");
          await page.waitForLoadState("networkidle");
          expect(await desktopTab(page).count()).toBe(0);
          expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
          return;
        } else {
          await selectChatLayoutAction(pane(page), /^(Side panel|Minimize side panel)$/);
          await desktopTab(page).waitFor({ state: "hidden" });
          await gateway.emitGatewayEvent("node.runnerInventory.changed", {
            nodeId: "worker-desktop",
          });
          expect(await desktopTab(page).isVisible()).toBe(false);
          await page.reload();
          await ready(page);
          expect(await desktopTab(page).isVisible()).toBe(false);
        }
        await assertNoProvisioning(gateway);
      }, width);
    },
  );

  it.each([false, true])(
    "discovers a desktop starting while viewed (runner availability: %s) and isolates another session",
    async (runnerAvailability) => {
      await withPage(async ({ page }) => {
        const gateway = await openResources(page, {
          historyMessages: [{ role: "assistant", content: "Waiting for the session desktop." }],
          methodResponses: {
            "sessions.list": list(runnerAvailability),
            "environments.status": runnerAvailability
              ? { ...environment, status: "unavailable" }
              : environment,
            "desktop.observe": desktop,
          },
        });
        await gateway.waitForRequest("sessions.describe");
        if (runnerAvailability) {
          await gateway.waitForRequest("environments.status");
        }
        expect(await desktopTab(page).count()).toBe(0);
        const rfb = await installScriptedRfbServer(page);
        const composer = pane(page).locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Keep my draft and focus");
        const inventoryBeforeActivation = (await gateway.getRequests("environments.status")).length;
        await gateway.deferNext("environments.status");
        await gateway.setSessionsListResponse(list(true));
        await gateway.setMethodResponse("environments.status", environment);
        await gateway.emitGatewayEvent(
          "sessions.changed",
          runnerAvailability ? { reason: "runner-availability" } : { key, reason: "patch" },
        );
        await gateway.waitForRequest("environments.status", { after: inventoryBeforeActivation });
        expect(await desktopTab(page).count()).toBe(0);
        await gateway.resolveDeferred("environments.status", environment);
        await desktopTab(page).waitFor();
        await pane(page).locator(".desktop-surface canvas").waitFor();
        expect(await composer.inputValue()).toBe("Keep my draft and focus");
        expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);
        const observationCount = (await gateway.getRequests("desktop.observe")).length;
        await page.getByRole("link", { name: "Notes", exact: true }).click();
        await expect
          .poll(() =>
            pane(page).evaluate(
              (element) => (element as HTMLElement & { sessionKey: string }).sessionKey,
            ),
          )
          .toBe(otherKey);
        await ready(page);
        expect(await desktopTab(page).count()).toBe(0);
        await gateway.emitGatewayEvent("node.runnerInventory.changed", {
          nodeId: "worker-desktop",
        });
        await expectRequestCountStable(gateway, "desktop.observe", observationCount);
        expect(await rfb.events()).not.toContain("closed:1");
        await page.goBack();
        await desktopTab(page).waitFor();
        await pane(page).locator(".desktop-surface canvas").waitFor();
        await expectRequestCountStable(gateway, "desktop.observe", observationCount);
        expect(await rfb.events()).not.toContain("closed:1");
        expect(await desktopTab(page).count()).toBe(1);
        await assertNoProvisioning(gateway);
      });
    },
  );

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

  it("reveals the exact live browser result on initial load without opening another browser tab", async () => {
    await withPage(async ({ page }) => {
      await page.route("**/__openclaw__/assistant-media**", (route) =>
        route.fulfill({
          contentType: "image/png",
          body: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
            "base64",
          ),
        }),
      );
      const target = {
        target: "node",
        node: "browser-node",
        profile: "session-profile",
        targetId: "existing-target",
        url: "https://example.com",
        title: "Existing session browser",
      };
      const gateway = await openResources(page, {
        historyMessages: [
          { role: "user", content: "Read the page", timestamp: 1000 },
          {
            role: "toolResult",
            toolName: "browser",
            toolCallId: "browser-call",
            timestamp: 2000,
            content: "Opened",
            details: { browserTab: target },
          },
          { role: "assistant", content: "The page is ready.", timestamp: 3000 },
        ],
        methodResponses: {
          "sessions.list": list(false),
          "browser.request": {
            cases: [
              {
                match: {
                  path: "/tabs",
                  target: "node",
                  node: "browser-node",
                  query: { profile: "session-profile" },
                },
                response: { running: true, tabs: [{ ...target, tabId: "t1" }] },
              },
              {
                match: { path: "/screenshot" },
                response: {
                  path: "/proof/page.png",
                  targetId: "existing-target",
                  url: target.url,
                },
              },
              {
                match: { path: "/act" },
                response: {
                  result: { cssWidth: 100, cssHeight: 100, title: target.title, url: target.url },
                },
              },
              {
                match: { path: "/screencast" },
                response: {
                  __mockError: {
                    code: "UNAVAILABLE",
                    message: "Use screenshot proof",
                    details: { code: "SCREENCAST_UNSUPPORTED" },
                  },
                },
              },
            ],
          },
        },
      });
      await pane(page).locator("openclaw-browser-panel[embedded] .bp").waitFor();
      expect(await pane(page).locator("openclaw-browser-panel").count()).toBe(1);
      const reads = await gateway.getRequests("browser.request", { path: "/tabs" });
      expect(reads.length).toBeGreaterThan(0);
      for (const request of reads) {
        expect(request.params).toMatchObject({
          target: "node",
          node: "browser-node",
          query: { profile: "session-profile" },
        });
      }
      await assertNoProvisioning(gateway);
      await pane(page).locator("openclaw-browser-panel .bp-shot").waitFor();
      await selectChatLayoutAction(pane(page), /^Swap /);
      await page.reload();
      await ready(page);
      await pane(page).locator("openclaw-browser-panel[embedded] .bp").waitFor();
      await pane(page).locator("openclaw-browser-panel .bp-shot").waitFor();
      expect(await pane(page).locator("openclaw-browser-panel").count()).toBe(1);
      await assertNoProvisioning(gateway);
    });
  });
});
