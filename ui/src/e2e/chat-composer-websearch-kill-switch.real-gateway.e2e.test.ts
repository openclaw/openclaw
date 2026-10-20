import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
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
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { enterControlUiSession } from "../test-helpers/control-ui-session-entry.ts";
import { createControlUiE2eSuite, tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";

const viewport = { width: 1280, height: 900 };
const siblings: SessionToolOverrides = {
  skills: { "synthetic-notes": false },
  mcpServers: { "synthetic-docs": false },
  mcpToolsDeny: { "synthetic-docs": ["write_note"] },
};
const scenarios = [
  { name: "omitted", overrides: siblings },
  { name: "false", overrides: { ...siblings, webSearch: false } },
  { name: "stale-true", overrides: { ...siblings, webSearch: true } },
];
type Request = {
  type: string;
  id: string;
  method: string;
  params?: { key?: string; agentId?: string; toolOverrides?: SessionToolOverrides | null };
};

async function readOverrides(owner: OpenClawTestInstance, key: string) {
  const result = await owner.cli([
    "--no-color",
    "gateway",
    "call",
    "sessions.describe",
    "--params",
    JSON.stringify({ key, agentId: "main" }),
    "--json",
  ]);
  expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
  const response: { session: { toolOverrides?: SessionToolOverrides } } = JSON.parse(result.stdout);
  return response.session.toolOverrides;
}

function observeRequests(page: Page) {
  const requests: Request[] = [];
  const replies = new Map<string, boolean>();
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const frame: Request = JSON.parse(payload.toString());
      if (frame.type !== "req") {
        return;
      }
      if (frame.method === "connect") {
        return;
      }
      requests.push(frame);
    });
    socket.on("framereceived", ({ payload }) => {
      const frame: { type: string; id: string; ok: boolean } = JSON.parse(payload.toString());
      if (frame.type !== "res") {
        return;
      }
      replies.set(frame.id, frame.ok);
    });
  });
  return {
    requests,
    succeeded: (request: Request) => replies.get(request.id) === true,
    patches: () =>
      requests.filter(
        (row) =>
          row.method === "sessions.patch" && Object.hasOwn(row.params ?? {}, "toolOverrides"),
      ),
  };
}

async function settleSelection(page: Page) {
  // Observe a rendered frame, then a read on this same real Gateway connection.
  await evaluateControlUiContext(page, async (context) => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    await context.gateway.snapshot.client!.request("health", {});
  });
}

async function openMenu(page: Page, selector = ".agent-chat__input") {
  const composer = page.locator(selector);
  await composer.waitFor();
  const menu = composer.locator(".agent-chat__capability-menu");
  if (!(await menu.evaluate((node) => node.hasAttribute("open")))) {
    await composer.getByRole("button", { name: "Add attachment" }).click();
  }
  const webSearch = menu.locator('.oc-menu-item[data-value="toggle-web-search"]');
  await webSearch.waitFor();
  await expect.poll(() => tooltipTitleText(webSearch)).not.toBe("Loading…");
  return { composer, menu, webSearch };
}

function checked(item: Locator) {
  return item.evaluate((node) => node.getAttribute("aria-checked") === "true");
}

async function forceSelection(item: Locator) {
  await item.evaluate((element) => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function verifyServedBundle(page: Page, baseUrl: string) {
  const scripts = await page
    .locator('script[type="module"][src]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src")!));
  expect(scripts.length).toBeGreaterThan(0);
  for (const source of scripts) {
    const url = new URL(source, baseUrl);
    expect(url.origin).toBe(new URL(baseUrl).origin);
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

for (const globallyEnabled of [false, true]) {
  let instance: OpenClawTestInstance;
  const suite = createControlUiE2eSuite({
    name: `Web search global ${globallyEnabled} with matching built Gateway and UI`,
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
        name: `websearch-global-${globallyEnabled}`,
        config: {
          gateway: { controlUi: { enabled: true } },
          agents: {
            defaults: { model: { primary: "fixture/catalog-only" } },
            entries: { main: {} },
          },
          models: { catalogRefresh: { enabled: false } },
          tools: { web: { search: { enabled: globallyEnabled } } },
        },
      });
      instance = owner;
      try {
        expect((await owner.entrypoint())[0]).toMatch(/^dist\/index\.m?js$/u);
        const config = await createConfigIO({
          env: owner.env,
          configPath: owner.state.configPath,
        }).loadConfigAsync();
        setRuntimeConfigSnapshot(config);
        try {
          for (const scenario of scenarios) {
            // A persisted legacy true is read directly; current sessions.patch normalizes it away.
            const entry = await upsertSessionEntryCore(
              {
                agentId: "main",
                sessionKey: `agent:main:websearch-${scenario.name}`,
                env: owner.env,
              },
              {
                sessionId: `websearch-${scenario.name}`,
                updatedAt: Date.now(),
                label: `Synthetic web search ${scenario.name}`,
                toolOverrides: scenario.overrides,
              },
            );
            expect(entry?.toolOverrides).toEqual(scenario.overrides);
          }
        } finally {
          clearRuntimeConfigSnapshot();
        }
        await owner.startGateway();
        return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
      } catch (error) {
        return await runQaGatewayFixture(
          async (): Promise<never> => {
            throw error;
          },
          () => owner.cleanup(),
        );
      }
    },
  });

  suite.define(() => {
    it("honors global policy in Chat and New Session without changing sibling overrides", async () => {
      const visit = async (
        pathname: string,
        run: (page: Page, traffic: ReturnType<typeof observeRequests>) => Promise<void>,
      ) => {
        const dashboard = await instance.cli(["dashboard", "--json"]);
        expect(dashboard.code, dashboard.stderr).toBe(0);
        const handoff: { browserUrl: string } = JSON.parse(dashboard.stdout);
        const fragment = new URL(handoff.browserUrl).hash;
        await suite.withPage(viewportOptions(), async ({ page }) => {
          const traffic = observeRequests(page);
          const url = new URL(pathname, suite.server.baseUrl);
          url.hash = fragment;
          const sessionDocument = url.pathname.startsWith("/chat/");
          expect((await page.goto(url.toString()))?.status()).toBe(sessionDocument ? 404 : 200);
          if (sessionDocument) {
            await enterControlUiSession(page);
          }
          await waitForControlUiGatewayReady(page);
          await verifyServedBundle(page, suite.server.baseUrl);
          await run(page, traffic);
          expect(
            traffic.requests.filter(
              (row) => row.method === "chat.send" || row.method === "sessions.dispatch",
            ),
          ).toEqual([]);
        });
      };

      for (const scenario of scenarios) {
        const key = `agent:main:websearch-${scenario.name}`;
        const before = await readOverrides(instance, key);
        expect(before).toEqual(scenario.overrides);
        await visit(
          controlUiSessionUrl(suite.server.baseUrl, key, "chat"),
          async (page, traffic) => {
            const { webSearch } = await openMenu(page);
            await settleSelection(page);
            const patchStart = traffic.patches().length;
            if (!globallyEnabled) {
              const stale = scenario.name === "stale-true";
              expect.soft(await checked(webSearch)).toBe(false);
              expect.soft(await webSearch.isDisabled()).toBe(!stale);
              expect
                .soft(await tooltipTitleText(webSearch))
                .toContain(stale ? "clear" : "tools.web.search.enabled");
              if (stale) {
                await webSearch.click();
              } else {
                await forceSelection(webSearch);
              }
              await settleSelection(page);
              if (stale) {
                await expect.poll(() => traffic.patches().length).toBe(patchStart + 1);
              }
              const patches = traffic.patches().slice(patchStart);
              expect.soft(patches).toEqual(
                stale
                  ? [
                      expect.objectContaining({
                        params: { key, toolOverrides: siblings },
                      }),
                    ]
                  : [],
              );
              expect
                .soft(patches.some((row) => row.params?.toolOverrides?.webSearch === true))
                .toBe(false);
              for (const patch of patches) {
                await expect.poll(() => traffic.succeeded(patch)).toBe(true);
              }
              const after = await readOverrides(instance, key);
              expect.soft(after).toEqual(stale ? siblings : scenario.overrides);
              await settleSelection(page);
              if (stale) {
                expect.soft(await checked(webSearch)).toBe(false);
                expect.soft(await webSearch.isDisabled()).toBe(true);
              }
            } else {
              const initiallyEnabled = scenario.name !== "false";
              await expect.poll(() => checked(webSearch)).toBe(initiallyEnabled);
              expect(await webSearch.isDisabled()).toBe(false);
              for (const [index, enabled] of [!initiallyEnabled, initiallyEnabled].entries()) {
                await webSearch.click();
                await expect.poll(() => traffic.patches().length).toBe(patchStart + index + 1);
                await expect
                  .poll(() => traffic.succeeded(traffic.patches()[patchStart + index]!))
                  .toBe(true);
                const toolOverrides = enabled ? siblings : { ...siblings, webSearch: false };
                expect(traffic.patches().at(-1)?.params).toEqual({ key, toolOverrides });
                await expect.poll(() => checked(webSearch)).toBe(enabled);
                if (index === 0) {
                  await expect.poll(() => webSearch.isDisabled()).toBe(false);
                }
                expect(await readOverrides(instance, key)).toEqual(toolOverrides);
              }
            }
          },
        );
      }

      await visit("new", async (page, traffic) => {
        const { webSearch } = await openMenu(page, ".new-session-page__composer");
        await settleSelection(page);
        expect.soft(await checked(webSearch)).toBe(globallyEnabled);
        expect.soft(await webSearch.isDisabled()).toBe(!globallyEnabled);
        if (!globallyEnabled) {
          expect.soft(await tooltipTitleText(webSearch)).toContain("tools.web.search.enabled");
        }
        await forceSelection(webSearch);
        await settleSelection(page);
        expect.soft(await checked(webSearch)).toBe(false);
        expect.soft(traffic.patches()).toEqual([]);
        expect.soft(traffic.requests.filter((row) => row.method === "sessions.create")).toEqual([]);
        if (globallyEnabled) {
          await webSearch.click();
          await expect.poll(() => checked(webSearch)).toBe(true);
          const chat = await page.context().newPage();
          const chatTraffic = observeRequests(chat);
          await chat.goto(
            controlUiSessionUrl(suite.server.baseUrl, "agent:main:websearch-omitted", "chat"),
          );
          await waitForControlUiGatewayReady(chat);
          const chatMenu = await openMenu(chat);
          await expect.poll(() => checked(chatMenu.webSearch)).toBe(true);
          await instance.stopGateway();
          await Promise.all([
            waitForControlUiGatewayReconnecting(page),
            waitForControlUiGatewayReconnecting(chat),
          ]);
          await expect.poll(() => webSearch.isDisabled()).toBe(true);
          await expect.poll(() => chatMenu.webSearch.isDisabled()).toBe(true);
          expect(await tooltipTitleText(webSearch)).toContain("Connect to the gateway");
          expect(await tooltipTitleText(chatMenu.webSearch)).toContain("Connect to the gateway");
          await forceSelection(webSearch);
          await forceSelection(chatMenu.webSearch);
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() => resolve());
              }),
          );
          expect(await checked(webSearch)).toBe(true);
          expect(await checked(chatMenu.webSearch)).toBe(true);
          expect(traffic.patches()).toEqual([]);
          expect(chatTraffic.patches()).toEqual([]);
        }
      });
    }, 180_000);
  });
}

function viewportOptions() {
  return {
    viewport,
    locale: "en-US",
    serviceWorkers: "block" as const,
    permissions: ["local-network-access"],
  };
}
