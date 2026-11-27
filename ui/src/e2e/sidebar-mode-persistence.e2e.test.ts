import path from "node:path";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sidebarSession } from "./sidebar-contract.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Sidebar mode persistence" });
const agentsList = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name: "Harbor" },
    { id: "research", name: "Research" },
  ],
};
const sessionKey = "agent:main:thread:review";
const scenario = {
  sessionKey,
  authMethod: "token" as const,
  authMode: "token" as const,
  heldMethods: ["connect"],
  presenceUsers: [{ id: "profile-a", self: true }],
  sessions: [sidebarSession(sessionKey, "Review the change", { agentId: "main", updatedAt: 1 })],
  methodResponses: {
    "agents.list": agentsList,
    "chat.startup": {
      agentsList,
      messages: [],
      metadata: { models: [] },
      sessionId: "review-session",
      thinkingLevel: null,
    },
  },
};

suite.define(() => {
  it("keeps the selected agent when a new tab reads an older roster snapshot", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page, context }) => {
        const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
        await page.route("**/seed", (route) =>
          route.fulfill({ body: "", contentType: "text/html" }),
        );
        await page.goto(suite.server.baseUrl + "seed");
        await page.evaluate(
          (key) => localStorage.setItem(key, JSON.stringify({ sidebarAgentsMode: "roster" })),
          storageKey,
        );
        const gateway = await installMockGateway(page, scenario);
        const url = controlUiSessionUrl(suite.server.baseUrl, sessionKey) + "#token=test-token";
        await page.goto(url);
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        await page.locator('aside.sidebar[data-snapshot-saved="true"]').waitFor();
        // Retain the real settled roster snapshot without an active writer replacing it.
        await page.goto(suite.server.baseUrl + "seed");
        await page.evaluate((key) => {
          const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
          localStorage.setItem(key, JSON.stringify({ ...settings, sidebarAgentsMode: "chip" }));
        }, storageKey);
        const next = await context.newPage();
        const nextGateway = await installMockGateway(next, scenario);
        await next.addInitScript(() => {
          // oxlint-disable-next-line typescript/unbound-method -- apply below preserves the native store receiver.
          const getAll = IDBObjectStore.prototype.getAll;
          IDBObjectStore.prototype.getAll = function (...args) {
            const request = getAll.apply(this, args);
            if (this.name === "sidebarSnapshots") {
              request.addEventListener("success", () => {
                if (request.result.length > 0) {
                  this.transaction.addEventListener(
                    "complete",
                    () => Reflect.set(window, "sidebarCacheReadDone", true),
                    { once: true },
                  );
                }
              });
            }
            return request;
          };
        });
        await next.goto(url);
        await next.bringToFront();
        await nextGateway.waitForRequest("connect");
        await next.waitForFunction(() => Reflect.get(window, "sidebarCacheReadDone") === true);
        await next.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        await next.locator("aside.sidebar").waitFor();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await next.screenshot({
            path: path.join(suite.artifactDir, "new-tab-sidebar.png"),
            animations: "disabled",
          });
        }
        expect(
          await next.evaluate(
            (key) => JSON.parse(localStorage.getItem(key) ?? "{}").sidebarAgentsMode,
            storageKey,
          ),
        ).toBe("chip");
        expect(await next.locator(".sidebar-agent-card__main").count()).toBe(1);
        expect(await next.locator(".sidebar-agent-roster").count()).toBe(0);
        await nextGateway.resolveDeferred("connect");
        await next.locator('aside.sidebar[data-snapshot-state="live"]').waitFor();
        expect(await next.locator(".sidebar-agent-card__main").count()).toBe(1);
      },
    );
  });
});
