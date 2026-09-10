import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { dockChatSidePanel } from "./chat-side-panel.test-support.ts";
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
const inventory = {
  environments: [
    {
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
    },
  ],
};
const list = (active: boolean) => ({
  sessions: [active ? row : { ...row, placement: { state: "local" } }, notes],
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
  "browser.request",
];
const pane = (page: Page) => page.locator(".chat-pane-cache__pane--active");
const desktopTab = (page: Page) => pane(page).getByRole("tab", { name: "Desktop", exact: true });
const ready = async (page: Page) => {
  await waitForControlUiGatewayReady(page);
  await pane(page).locator(".agent-chat__composer-combobox textarea").waitFor();
};
async function assertNoProvisioning(gateway: MockGatewayControls) {
  const requests = await gateway.getRequests();
  expect(
    requests.filter((request) =>
      ["environments.create", "desktop.launch", "sessions.dispatch"].includes(request.method),
    ),
  ).toEqual([]);
  expect(
    requests.filter(
      (request) =>
        request.method === "browser.request" &&
        ["/start", "/tabs/open", "/tabs/focus"].includes(
          String(asNullableRecord(request.params)?.path),
        ),
    ),
  ).toEqual([]);
}

suite.define(() => {
  it.each([
    { width: 1280, staleRoster: false, reclaimOnReload: false },
    { width: 390, staleRoster: false, reclaimOnReload: false },
    { width: 1280, staleRoster: true, reclaimOnReload: false },
    { width: 1280, staleRoster: false, reclaimOnReload: true },
  ])(
    "reveals a running desktop on direct entry at width $width (stale roster: $staleRoster, reclaim: $reclaimOnReload) and respects reload",
    async ({ width, staleRoster, reclaimOnReload }) => {
      await suite.withPage(
        { serviceWorkers: "block", viewport: { width, height: 900 } },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            sessionKey: key,
            featureMethods,
            deferredMethods: ["desktop.observe"],
            historyMessages: [{ role: "assistant", content: "Your existing desktop is ready." }],
            methodResponses: {
              "sessions.list": list(!staleRoster),
              ...(staleRoster ? { "sessions.describe": { session: row } } : {}),
              "environments.list": inventory,
              "desktop.observe": {
                transport: "rfb",
                wsPath: "/desktop/observe?proof=1",
                expiresAtMs: 60000,
                control: false,
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}chat/main/resource-demo`);
          await ready(page);
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
          expect(chatBox!.height).toBeGreaterThan(100);
          expect(desktopBox!.width).toBeLessThanOrEqual(width);
          if (width === 390) {
            expect(desktopBox!.y).toBeGreaterThan(chatBox!.y);
          }
          await page.screenshot({
            path: path.join(suite.artifactDir, `direct-desktop-${width}.png`),
            animations: "disabled",
          });
          if (reclaimOnReload) {
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
          }
          await pane(page).locator(".chat-side-panel-toggle").click();
          await desktopTab(page).waitFor({ state: "hidden" });
          await gateway.emitGatewayEvent("node.runnerInventory.changed", {
            nodeId: "worker-desktop",
          });
          expect(await desktopTab(page).isVisible()).toBe(false);
          await page.reload();
          await ready(page);
          expect(await desktopTab(page).isVisible()).toBe(false);
          await assertNoProvisioning(gateway);
        },
      );
    },
  );

  it("discovers a desktop starting while viewed and isolates another session", async () => {
    await suite.withPage(
      { serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          featureMethods,
          historyMessages: [{ role: "assistant", content: "Waiting for the session desktop." }],
          methodResponses: {
            "sessions.list": list(false),
            "environments.list": inventory,
            "desktop.observe": {
              transport: "rfb",
              wsPath: "/desktop/observe?proof=1",
              expiresAtMs: 60000,
              control: false,
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat/main/resource-demo`);
        await ready(page);
        await gateway.waitForRequest("sessions.describe");
        expect(await desktopTab(page).count()).toBe(0);
        await page.screenshot({
          path: path.join(suite.artifactDir, "before-active.png"),
          animations: "disabled",
        });
        await installScriptedRfbServer(page);
        const composer = pane(page).locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Keep my draft and focus");
        await gateway.setSessionsListResponse(list(true));
        await gateway.emitGatewayEvent("sessions.changed", { key, reason: "patch" });
        await desktopTab(page).waitFor();
        await pane(page).locator(".desktop-surface canvas").waitFor();
        expect(await composer.inputValue()).toBe("Keep my draft and focus");
        expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);
        await page.screenshot({
          path: path.join(suite.artifactDir, "newly-active.png"),
          animations: "disabled",
        });
        await page.getByRole("link", { name: "Notes", exact: true }).click();
        await ready(page);
        expect(await desktopTab(page).count()).toBe(0);
        await page.goBack();
        await desktopTab(page).waitFor();
        expect(await desktopTab(page).count()).toBe(1);
        await assertNoProvisioning(gateway);
      },
    );
  });

  it("reveals the exact live browser result on initial load without opening another browser tab", async () => {
    await suite.withPage(
      { serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
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
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          featureMethods,
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
        await page.goto(`${suite.server.baseUrl}chat/main/resource-demo`);
        await ready(page);
        await pane(page).getByRole("tab", { name: "Browser", exact: true }).waitFor();
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
      },
    );
  });
});
