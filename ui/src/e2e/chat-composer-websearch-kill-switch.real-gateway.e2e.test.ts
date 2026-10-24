import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../../scripts/lib/local-build-metadata-paths.mts";
import { createConfigIO } from "../../../src/config/config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../src/config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../../src/config/sessions/session-accessor.ts";
import type { SessionToolOverrides } from "../../../src/config/sessions/session-tool-overrides.ts";
import type { GatewayClient } from "../../../src/gateway/client.ts";
import { acquireGatewayTestClient } from "../../../test/helpers/gateway-client.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { enterControlUiSession } from "../test-helpers/control-ui-session-entry.ts";
import { createControlUiE2eSuite, tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";

const key = "agent:main:websearch-stale-true";
const siblings: SessionToolOverrides = {
  skills: { "synthetic-notes": false },
  mcpServers: { "synthetic-docs": false },
  mcpToolsDeny: { "synthetic-docs": ["write_note"] },
};
let instance: OpenClawTestInstance;
let readback: GatewayClient;
const suite = createControlUiE2eSuite({
  name: "Web search kill switch with matching built Gateway and UI",
  startServerBeforeBrowser: true,
  async startServer() {
    await Promise.all(
      [
        "dist/control-ui/index.html",
        "dist/index.js",
        `dist/${BUILD_STAMP_FILE}`,
        `dist/${RUNTIME_POSTBUILD_STAMP_FILE}`,
      ].map((file) => access(path.join(process.cwd(), file))),
    );
    const owner = await createOpenClawTestInstance({
      name: "websearch-global-disabled",
      config: {
        gateway: { controlUi: { enabled: true } },
        agents: { defaults: { model: { primary: "fixture/catalog-only" } }, entries: { main: {} } },
        models: { catalogRefresh: { enabled: false } },
        tools: { web: { search: { enabled: false } } },
      },
    });
    instance = owner;
    const close = () =>
      runQaGatewayFixture(
        () => readback?.stopAndWait(),
        () => owner.cleanup(),
      );
    try {
      expect((await owner.entrypoint())[0]).toMatch(/^dist\/index\.m?js$/u);
      const config = await createConfigIO({
        env: owner.env,
        configPath: owner.state.configPath,
      }).loadConfigAsync();
      setRuntimeConfigSnapshot(config);
      try {
        // Bypass sessions.patch only to seed the legacy true value it now normalizes away.
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: key, env: owner.env },
          {
            sessionId: "websearch-stale-true",
            updatedAt: Date.now(),
            toolOverrides: { ...siblings, webSearch: true },
          },
        );
      } finally {
        clearRuntimeConfigSnapshot();
      }
      await owner.startGateway();
      readback = await acquireGatewayTestClient(
        {
          url: owner.url,
          token: owner.gatewayToken,
          env: owner.env,
          clientName: "cli",
          mode: "cli",
          scopes: ["operator.read"],
          deviceIdentity: null,
          deviceAuthScope: owner.url,
          sharedStateMode: "read-only",
          requestTimeoutMs: 10_000,
        },
        {
          timeoutMs: 10_000,
          timeoutMessage: "Web search readback client did not connect",
          closeMessage: "Web search readback client closed during connect",
        },
      );
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close };
    } catch (error) {
      return await runQaGatewayFixture(async (): Promise<never> => {
        throw error;
      }, close);
    }
  },
});

async function readOverrides() {
  const result = await readback.request<{ session: { toolOverrides?: SessionToolOverrides } }>(
    "sessions.describe",
    { key, agentId: "main" },
  );
  return result.session.toolOverrides;
}
async function settleSelection(page: Page) {
  await evaluateControlUiContext(page, async (context) => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    await context.gateway.snapshot.client!.request("health", {});
  });
}
async function openMenu(page: Page, selector: string) {
  const composer = page.locator(selector);
  await composer.getByRole("button", { name: "Add attachment" }).click();
  const item = composer.locator('.oc-menu-item[data-value="toggle-web-search"]');
  await item.waitFor();
  await expect.poll(() => tooltipTitleText(item)).not.toBe("Loading…");
  return item;
}
async function verifyServedBundle(page: Page) {
  const scripts = await page
    .locator('script[type="module"][src]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src")!));
  expect(scripts.length).toBeGreaterThan(0);
  for (const source of scripts) {
    const url = new URL(source, suite.server.baseUrl);
    expect(url.origin).toBe(new URL(suite.server.baseUrl).origin);
    expect(url.pathname).toMatch(/^\/assets\//u);
    const served = await page.request.get(url.toString());
    expect(served.status()).toBe(200);
    const built = await readFile(
      path.join(process.cwd(), "dist/control-ui", url.pathname.slice(1)),
    );
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    expect(digest(await served.body())).toBe(digest(built));
  }
}

suite.define(() => {
  it("clears a legacy true override without enabling globally disabled search or changing siblings", async () => {
    const dashboard = await instance.cli(["dashboard", "--json"]);
    expect(dashboard.code, dashboard.stderr).toBe(0);
    const handoff: { browserUrl: string } = JSON.parse(dashboard.stdout);
    const fragment = new URL(handoff.browserUrl).hash;
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        locale: "en-US",
        serviceWorkers: "block",
        permissions: ["local-network-access"],
      },
      async ({ page }) => {
        const requests: Array<{
          type: string;
          method: string;
          params?: { key?: string; toolOverrides?: SessionToolOverrides };
        }> = [];
        page.on("websocket", (socket) =>
          socket.on("framesent", ({ payload }) => {
            const frame: (typeof requests)[number] = JSON.parse(payload.toString());
            if (frame.type === "req") {
              requests.push(frame);
            }
          }),
        );
        const url = new URL(controlUiSessionUrl(suite.server.baseUrl, key, "chat"));
        url.hash = fragment;
        expect((await page.goto(url.toString()))?.status()).toBe(404);
        await enterControlUiSession(page);
        await waitForControlUiGatewayReady(page);
        await verifyServedBundle(page);
        expect(await readOverrides()).toEqual({ ...siblings, webSearch: true });
        const item = await openMenu(page, ".agent-chat__input");
        await expect.poll(() => item.getAttribute("aria-checked")).toBe("false");
        expect(await item.isDisabled()).toBe(false);
        expect(await tooltipTitleText(item)).toContain("clear");
        await item.click();
        await expect.poll(readOverrides).toEqual(siblings);
        await expect.poll(() => item.isDisabled()).toBe(true);
        expect(await item.getAttribute("aria-checked")).toBe("false");
        expect(await tooltipTitleText(item)).toContain("tools.web.search.enabled");
        await item.evaluate((node) =>
          node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
        );
        await settleSelection(page);
        expect(await readOverrides()).toEqual(siblings);
        expect(requests.filter((request) => request.method === "sessions.patch")).toEqual([
          expect.objectContaining({ params: { key, toolOverrides: siblings } }),
        ]);

        const newUrl = new URL("new", suite.server.baseUrl);
        newUrl.hash = fragment;
        expect((await page.goto(newUrl.toString()))?.status()).toBe(200);
        await waitForControlUiGatewayReady(page);
        const draftItem = await openMenu(page, ".new-session-page__composer");
        expect(await draftItem.getAttribute("aria-checked")).toBe("false");
        expect(await draftItem.isDisabled()).toBe(true);
        expect(await tooltipTitleText(draftItem)).toContain("tools.web.search.enabled");
        await draftItem.evaluate((node) =>
          node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
        );
        await settleSelection(page);
        expect(await draftItem.getAttribute("aria-checked")).toBe("false");
        expect(
          requests.filter((request) =>
            ["chat.send", "sessions.dispatch", "sessions.create"].includes(request.method),
          ),
        ).toEqual([]);
        expect(requests.filter((request) => request.method === "sessions.patch")).toHaveLength(1);
      },
    );
  }, 180_000);
});
