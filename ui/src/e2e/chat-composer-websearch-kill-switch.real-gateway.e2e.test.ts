import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../../scripts/lib/local-build-metadata-paths.mts";
import { upsertSessionEntryCore } from "../../../src/config/sessions/session-accessor.ts";
import type { SessionToolOverrides } from "../../../src/config/sessions/session-tool-overrides.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { COMMUNITY_INVITE_KEY } from "../components/community-invite-state.ts";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite, tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";

const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
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

async function rpc<T>(
  owner: OpenClawTestInstance,
  method: string,
  params: object,
  evidence: object[],
  stage: string,
): Promise<T> {
  const result = await owner.cli([
    "--no-color",
    "gateway",
    "call",
    method,
    "--params",
    JSON.stringify(params),
    "--json",
  ]);
  evidence.push({ kind: "session-readback", stage, method, params, ...result });
  expect(result.code, `${method}: ${result.stderr}`).toBe(0);
  expect(result.signal).toBeNull();
  return JSON.parse(result.stdout);
}

function observeRequests(page: Page) {
  const requests: Request[] = [];
  const replies = new Map<string, boolean>();
  const frames: object[] = [];
  let connectionCount = 0;
  page.on("websocket", (socket) => {
    const connection = ++connectionCount;
    const methods = new Map<string, string>();
    socket.on("framesent", ({ payload }) => {
      const frame: Request = JSON.parse(payload.toString());
      if (frame.type !== "req") {
        return;
      }
      methods.set(frame.id, frame.method);
      if (frame.method === "connect") {
        return;
      }
      requests.push(frame);
      frames.push({
        connection,
        direction: "sent",
        requestId: frame.id,
        method: frame.method,
        frame,
        raw: payload.toString(),
      });
    });
    socket.on("framereceived", ({ payload }) => {
      const frame: { type: string; id: string; ok: boolean; payload?: unknown; error?: unknown } =
        JSON.parse(payload.toString());
      if (frame.type !== "res") {
        return;
      }
      const method = methods.get(frame.id);
      if (!method || method === "connect") {
        return;
      }
      replies.set(frame.id, frame.ok);
      frames.push({
        connection,
        direction: "received",
        requestId: frame.id,
        method,
        frame,
        raw: payload.toString(),
      });
    });
  });
  return {
    requests,
    frames,
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
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    const app = document.querySelector("openclaw-app") as HTMLElement & {
      runtime: { context: { gateway: { snapshot: { client: GatewayBrowserClient } } } };
    };
    await app.runtime.context.gateway.snapshot.client.request("health", {});
  });
}

async function openMenu(page: Page, selector = ".agent-chat__input") {
  const composer = page.locator(selector);
  await composer.waitFor();
  const menu = composer.locator("wa-dropdown.agent-chat__capability-menu");
  if (!(await menu.evaluate((node) => (node as HTMLElement & { open: boolean }).open))) {
    await composer.getByRole("button", { name: "Add attachment" }).click();
  }
  const webSearch = menu.locator('wa-dropdown-item[value="toggle-web-search"]');
  await webSearch.waitFor();
  await expect.poll(() => tooltipTitleText(webSearch)).not.toBe("Loading…");
  return { composer, menu, webSearch };
}

function checked(item: Locator) {
  return item.evaluate((node) => (node as HTMLElement & { checked: boolean }).checked);
}

async function presentation(item: Locator) {
  return {
    checked: await checked(item),
    disabled: await item.isDisabled(),
    explanation: await tooltipTitleText(item),
  };
}

async function forceSelection(item: Locator) {
  await item.evaluate((element) => {
    const menu = element.closest("wa-dropdown");
    if (!menu) {
      throw new Error("Capability row has no dropdown owner");
    }
    menu.dispatchEvent(new CustomEvent("wa-select", { bubbles: true, detail: { item: element } }));
  });
}

async function verifyServedBundle(page: Page, baseUrl: string) {
  const scripts = await page
    .locator('script[type="module"][src]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src")!));
  expect(scripts.length).toBeGreaterThan(0);
  const hashes: Array<{ asset: string; sha256: string }> = [];
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
    hashes.push({ asset: url.pathname, sha256: digest(built) });
  }
  return hashes;
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
            entries: { main: { default: true } },
          },
          models: { catalogRefresh: { enabled: false } },
          tools: { web: { search: { enabled: globallyEnabled } } },
        },
      });
      instance = owner;
      try {
        expect((await owner.entrypoint())[0]).toMatch(/^dist\/index\.m?js$/u);
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
      const evidence: object[] = [];
      const visit = async (
        pathname: string,
        stage: string,
        run: (page: Page, traffic: ReturnType<typeof observeRequests>) => Promise<void>,
      ) => {
        const dashboard = await instance.cli(["dashboard", "--json"]);
        expect(dashboard.code, dashboard.stderr).toBe(0);
        const handoff: { browserUrl: string } = JSON.parse(dashboard.stdout);
        const fragment = new URL(handoff.browserUrl).hash;
        await suite.withPage(
          {
            ...viewportOptions(),
            ...(capture ? { recordVideo: { dir: suite.artifactDir, size: viewport } } : {}),
          },
          async ({ page }) => {
            await page.context().addInitScript((key) => {
              localStorage.setItem(key, JSON.stringify({ dismissedAtMs: Date.now() }));
            }, COMMUNITY_INVITE_KEY);
            const traffic = observeRequests(page);
            const observed = {
              stage,
              frames: traffic.frames,
              assets: [] as Array<{ asset: string; sha256: string }>,
            };
            evidence.push(observed);
            const url = new URL(pathname, suite.server.baseUrl);
            url.hash = fragment;
            await runQaGatewayFixture(
              async () => {
                expect((await page.goto(url.toString()))?.status()).toBe(200);
                await waitForControlUiGatewayReady(page);
                observed.assets = await verifyServedBundle(page, suite.server.baseUrl);
                await run(page, traffic);
                expect(
                  traffic.requests.filter(
                    (row) => row.method === "chat.send" || row.method === "sessions.dispatch",
                  ),
                ).toEqual([]);
              },
              async () => {
                if (capture) {
                  for (const [index, capturedPage] of page.context().pages().entries()) {
                    await capturedPage.screenshot({
                      path: path.join(suite.artifactDir, `${stage}-final-${index + 1}.png`),
                    });
                  }
                }
              },
            );
          },
        );
      };

      try {
        for (const scenario of scenarios) {
          const key = `agent:main:websearch-${scenario.name}`;
          const before = await rpc<{ session: { toolOverrides?: SessionToolOverrides } }>(
            instance,
            "sessions.describe",
            { key, agentId: "main" },
            evidence,
            `chat-${scenario.name}-before`,
          );
          expect(before.session.toolOverrides).toEqual(scenario.overrides);
          await visit(
            controlUiSessionUrl(suite.server.baseUrl, key, "chat"),
            `chat-${scenario.name}`,
            async (page, traffic) => {
              const { webSearch } = await openMenu(page);
              await settleSelection(page);
              evidence.push({
                stage: `chat-${scenario.name}-initial`,
                ...(await presentation(webSearch)),
              });
              const patchStart = traffic.patches().length;
              if (!globallyEnabled) {
                const stale = scenario.name === "stale-true";
                expect.soft(await checked(webSearch)).toBe(false);
                expect.soft(await webSearch.isDisabled()).toBe(!stale);
                expect
                  .soft(await tooltipTitleText(webSearch))
                  .toContain(stale ? "clear" : "tools.web.search.enabled");
                if (capture) {
                  await page.screenshot({
                    path: path.join(suite.artifactDir, `chat-${scenario.name}.png`),
                  });
                }
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
                const after = await rpc<{ session: { toolOverrides?: SessionToolOverrides } }>(
                  instance,
                  "sessions.describe",
                  { key, agentId: "main" },
                  evidence,
                  `chat-${scenario.name}-after`,
                );
                expect
                  .soft(after.session.toolOverrides)
                  .toEqual(stale ? siblings : scenario.overrides);
                await settleSelection(page);
                evidence.push({
                  stage: `chat-${scenario.name}-after`,
                  ...(await presentation(webSearch)),
                });
                if (stale) {
                  expect.soft(await checked(webSearch)).toBe(false);
                  expect.soft(await webSearch.isDisabled()).toBe(true);
                }
              } else {
                const initiallyEnabled = scenario.name !== "false";
                await expect.poll(() => checked(webSearch)).toBe(initiallyEnabled);
                expect(await webSearch.isDisabled()).toBe(false);
                await webSearch.click();
                await expect.poll(() => traffic.patches().length).toBe(patchStart + 1);
                await expect
                  .poll(() => traffic.succeeded(traffic.patches()[patchStart]!))
                  .toBe(true);
                const firstOverrides = initiallyEnabled
                  ? { ...siblings, webSearch: false }
                  : siblings;
                expect(traffic.patches().at(-1)?.params).toEqual({
                  key,
                  toolOverrides: firstOverrides,
                });
                await expect.poll(() => checked(webSearch)).toBe(!initiallyEnabled);
                await expect.poll(() => webSearch.isDisabled()).toBe(false);
                const toggled = await rpc<{ session: { toolOverrides?: SessionToolOverrides } }>(
                  instance,
                  "sessions.describe",
                  { key, agentId: "main" },
                  evidence,
                  `chat-${scenario.name}-first-toggle`,
                );
                expect(toggled.session.toolOverrides).toEqual(firstOverrides);
                await webSearch.click();
                await expect.poll(() => traffic.patches().length).toBe(patchStart + 2);
                await expect
                  .poll(() => traffic.succeeded(traffic.patches()[patchStart + 1]!))
                  .toBe(true);
                expect(traffic.patches().at(-1)?.params).toEqual({
                  key,
                  toolOverrides: initiallyEnabled ? siblings : { ...siblings, webSearch: false },
                });
                await expect.poll(() => checked(webSearch)).toBe(initiallyEnabled);
                const restored = await rpc<{ session: { toolOverrides?: SessionToolOverrides } }>(
                  instance,
                  "sessions.describe",
                  { key, agentId: "main" },
                  evidence,
                  `chat-${scenario.name}-second-toggle`,
                );
                expect(restored.session.toolOverrides).toEqual(
                  initiallyEnabled ? siblings : { ...siblings, webSearch: false },
                );
                evidence.push({
                  stage: `chat-${scenario.name}-after`,
                  ...(await presentation(webSearch)),
                });
              }
            },
          );
        }

        await visit("new", "new-session", async (page, traffic) => {
          const { webSearch } = await openMenu(page, ".new-session-page__composer");
          await settleSelection(page);
          evidence.push({ stage: "new-session-initial", ...(await presentation(webSearch)) });
          expect.soft(await checked(webSearch)).toBe(globallyEnabled);
          expect.soft(await webSearch.isDisabled()).toBe(!globallyEnabled);
          if (!globallyEnabled) {
            expect.soft(await tooltipTitleText(webSearch)).toContain("tools.web.search.enabled");
          }
          if (capture) {
            await page.screenshot({ path: path.join(suite.artifactDir, "new-session.png") });
          }
          await forceSelection(webSearch);
          await settleSelection(page);
          evidence.push({ stage: "new-session-after-select", ...(await presentation(webSearch)) });
          expect.soft(await checked(webSearch)).toBe(false);
          expect.soft(traffic.patches()).toEqual([]);
          expect
            .soft(traffic.requests.filter((row) => row.method === "sessions.create"))
            .toEqual([]);
          if (globallyEnabled) {
            await webSearch.click();
            await expect.poll(() => checked(webSearch)).toBe(true);
            const chat = await page.context().newPage();
            const chatTraffic = observeRequests(chat);
            evidence.push({ stage: "offline-chat", frames: chatTraffic.frames });
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
            evidence.push(
              { stage: "offline-new-session", ...(await presentation(webSearch)) },
              { stage: "offline-chat", ...(await presentation(chatMenu.webSearch)) },
            );
          }
        });
      } finally {
        if (capture) {
          await writeFile(
            path.join(suite.artifactDir, "websearch-policy-evidence.json"),
            JSON.stringify({ globallyEnabled, evidence }, null, 2),
            { flag: "wx" },
          );
        }
      }
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
