import path from "node:path";
import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createGatewayProxy, gatewayProxyRoute } from "./gateway-proxy.test-support.ts";

let gateway: OpenClawTestInstance;
let selectPlugin: (enabled: boolean) => Promise<void>;
const suite = createControlUiE2eSuite({
  name: "Packaged Lobsterdex for a sessions-only reader",
  startServerBeforeBrowser: true,
  async startServer() {
    gateway = await createOpenClawTestInstance({
      name: "lobsterdex-limited",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("dist/extensions"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
      entrypoint: ["dist/index.js"],
    });
    const email = "lobster-reader@example.test";
    const route = gatewayProxyRoute(gateway.port, email);
    const proxy = await createGatewayProxy(gateway.state.workspaceDir, {
      "/": {
        ...route,
        headers: { ...route.headers, "x-openclaw-scopes": "operator.sessions.read" },
      },
    });
    const close = () =>
      runQaGatewayFixture(
        () => proxy.close(),
        () => gateway.cleanup(),
      );
    try {
      await proxy.listen();
      const baseUrl = proxy.resolvedUrls!.local[0]!;
      const trustedProxy = {
        userHeader: "x-forwarded-user",
        allowLoopback: true,
        requiredHeaders: ["x-forwarded-proto"],
        allowUsers: [email],
        deviceAutoApprove: { enabled: true, scopes: ["operator.sessions.read"] },
      };
      selectPlugin = async (enabled) => {
        await gateway.state.writeConfig({
          // An unconfigured Gateway intentionally replaces the whole editor with
          // model setup. Keep a configured draft surface; this test sends no turns.
          agents: { defaults: { model: "fixture/echo" }, entries: { main: {} } },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              fixture: {
                api: "openai-responses",
                apiKey: "synthetic-unused",
                baseUrl: new URL("v1", baseUrl).href,
                models: [{ id: "echo", name: "Fixture" }],
              },
            },
          },
          plugins: { allow: ["lobsterdex"], entries: { lobsterdex: { enabled } } },
          gateway: {
            port: gateway.port,
            auth: { mode: "trusted-proxy", trustedProxy },
            trustedProxies: ["127.0.0.1", "::1"],
            controlUi: {
              enabled: true,
              root: path.resolve("dist/control-ui"),
              allowedOrigins: [new URL(baseUrl).origin],
            },
            roles: {
              default: "reader",
              definitions: {
                reader: {
                  agents: ["main"],
                  sessions: { others: "view" },
                  scopes: ["operator.sessions.read"],
                },
              },
            },
          },
        });
      };
      await selectPlugin(true);
      await gateway.startGateway();
      return { baseUrl, close };
    } catch (error) {
      await close();
      throw error;
    }
  },
});

suite.define(() => {
  it("loads local art without catalog access, retains the editor on changes, and reopens offline using only the last decision", async () => {
    const context = await suite.newBrowserContext({
      reducedMotion: "reduce",
      locale: "en-US",
      serviceWorkers: "allow",
      viewport: { width: 390, height: 844 },
    });
    try {
      let page = await context.newPage();
      const calls: string[] = [];
      page.on("websocket", (ws) =>
        ws.on("framesent", (frame) => {
          const method = JSON.parse(frame.payload.toString()).method;
          if (typeof method === "string") {
            calls.push(method);
          }
        }),
      );
      // Reduced motion shortens the highlight to 0.01ms. Observe its real start
      // rather than hoping a locator poll lands inside that single frame.
      await page.addInitScript(() => {
        document.addEventListener("animationstart", (event) => {
          if (
            event.animationName === "lobsterdex-card-highlight" &&
            event.target instanceof HTMLElement &&
            event.target.id === "lobsterdex-taylorpinch"
          ) {
            performance.mark("lobsterdex-saved-card-highlight");
          }
        });
      });
      const url = new URL("settings/lobsterdex#lobsterdex-taylorpinch", suite.server.baseUrl).href;
      await page.goto(url, { waitUntil: "commit" });
      await waitForControlUiGatewayReady(page);
      const scopes = await evaluateControlUiContext(
        page,
        (app) => app.gateway.snapshot.hello?.auth?.scopes,
      );
      expect(scopes).toEqual(["operator.sessions.read"]);
      const readBootstrap = async () =>
        (
          await context.request.get(new URL("control-ui-config.json", suite.server.baseUrl).href)
        ).json();
      await expect
        .poll(async () => (await readBootstrap()).enabledLocalPresentations, { timeout: 20_000 })
        .toEqual(["lobsterdex"]);
      const bootstrap = await readBootstrap();
      expect(bootstrap).toMatchObject({
        enabledLocalPresentations: ["lobsterdex"],
        pluginControlUiModules: [],
        pluginFrameGrants: [],
      });
      expect(bootstrap.preferences?.config).toBeUndefined();
      expect(
        (await context.cookies()).some((cookie) => cookie.path.includes("/__openclaw__/plugins/")),
      ).toBe(false);
      await expect
        .poll(() => page.locator(".lobsterdex-page__card").count(), { timeout: 15_000 })
        .toBe(52);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const bounds = document
              .getElementById("lobsterdex-taylorpinch")
              ?.getBoundingClientRect();
            return {
              target: location.hash,
              highlighted:
                performance.getEntriesByName("lobsterdex-saved-card-highlight").length > 0,
              visible: Boolean(bounds && bounds.top >= 0 && bounds.bottom <= innerHeight),
            };
          }),
        )
        .toEqual({ target: "#lobsterdex-taylorpinch", highlighted: true, visible: true });
      expect(await page.locator(".lobsterdex-page__card button").count()).toBe(0);
      expect(calls).not.toContain("plugins.controlUi.list");
      expect(calls).not.toContain("config.get");
      const gatewayUrl = await evaluateControlUiContext(
        page,
        (app) => app.gateway.connection.gatewayUrl,
      );
      const decisionKey =
        "openclaw.control.localPresentations.v1:" + gatewayOriginScope(gatewayUrl);
      const openOffline = async (enabled: boolean) => {
        await page.close();
        // Leave no reachable Gateway and no live tab. Do not emulate offline via CDP:
        // Chromium may bypass a worker when creating a new emulated-offline target.
        await gateway.stopGateway();
        page = await context.newPage();
        // Observe the production cache read without supplying a decision. An empty registry
        // before startup (or a missing cached decision) is not proof of a confirmed disable.
        await page.addInitScript(
          ({ key, expected }) => {
            class ObservedLocalStorage extends Storage {
              override getItem(name: string) {
                const value = super.getItem(name);
                if (name === key && value === expected) {
                  performance.mark("lobsterdex-offline-decision-read");
                }
                return value;
              }
            }
            Object.setPrototypeOf(localStorage, ObservedLocalStorage.prototype);
          },
          { key: decisionKey, expected: JSON.stringify(enabled ? ["lobsterdex"] : []) },
        );
        const response = await page.goto(url);
        expect(response?.fromServiceWorker()).toBe(true);
        await page.locator("openclaw-app-shell").waitFor({ state: "attached" });
        expect(
          await page.evaluate(() =>
            document.documentElement.hasAttribute("data-openclaw-bootstrap-config"),
          ),
        ).toBe(false);
        await expect
          .poll(
            () =>
              evaluateControlUiContext(page, (app) => ({
                read: performance.getEntriesByName("lobsterdex-offline-decision-read").length > 0,
                loading: app.plugins.isLoading("lobsterdex"),
              })),
            { timeout: 20_000 },
          )
          .toEqual({ read: true, loading: false });
        expect(
          await evaluateControlUiContext(page, (app) =>
            app.plugins.errors.filter((e) => e.pluginId === "lobsterdex"),
          ),
        ).toEqual([]);
      };
      // Wait for the product worker to finish its own cache, not a cached live HTML document.
      await expect
        .poll(
          () =>
            page.evaluate(async () => {
              const registration = await navigator.serviceWorker.getRegistration();
              return Boolean(
                navigator.serviceWorker.controller &&
                registration &&
                (await caches.match(new URL("__offline_shell__", registration.scope))),
              );
            }),
          { timeout: 90_000 },
        )
        .toBe(true);
      await page.reload();
      await page.locator(".lobsterdex-page__card").first().waitFor();
      await openOffline(true);
      await expect
        .poll(() => page.locator(".lobsterdex-page__card").count(), { timeout: 20_000 })
        .toBe(52);
      console.info("Fresh tab rendered 52 cards from the worker with its Gateway stopped.");
      await gateway.startGateway();
      await page.goto(new URL("new", suite.server.baseUrl).href);
      await waitForControlUiGatewayReady(page);
      const pet = page.locator("openclaw-lobster-pet"),
        editor = page.locator(".new-session-page__composer textarea").first();
      await pet.waitFor({ state: "attached" });
      await editor.fill("Keep my draft while the plugin changes.");
      const original = await editor.elementHandle();
      const setEnabled = async (enabled: boolean) => {
        await selectPlugin(enabled);
        await expect
          .poll(
            async () => ({
              decision: (await readBootstrap()).enabledLocalPresentations,
              client: await evaluateControlUiContext(
                page,
                (app) => app.config.current.enabledLocalPresentations,
              ),
            }),
            {
              timeout: 30_000,
              message: "Gateway and live reader must observe the same enablement decision",
            },
          )
          .toEqual({
            decision: enabled ? ["lobsterdex"] : [],
            client: enabled ? ["lobsterdex"] : [],
          });
      };
      await setEnabled(false);
      await expect.poll(() => pet.count(), { timeout: 30_000 }).toBe(0);
      expect(await editor.evaluate((node, other) => node === other, original)).toBe(true);
      await setEnabled(true);
      await pet.waitFor({ state: "attached", timeout: 30_000 });
      expect(await editor.inputValue()).toBe("Keep my draft while the plugin changes.");
      expect(await editor.evaluate((node, other) => node === other, original)).toBe(true);
      await setEnabled(false);
      await expect.poll(() => pet.count(), { timeout: 30_000 }).toBe(0);
      await openOffline(false);
      expect(
        await evaluateControlUiContext(page, (app) =>
          app.plugins.registrations("pages").some((p) => p.pluginId === "lobsterdex"),
        ),
      ).toBe(false);
      expect(await page.locator(".lobsterdex-page__card").count()).toBe(0);
    } catch (error) {
      // Only lifecycle facts from this isolated fixture; no request bodies or configuration.
      const facts =
        gateway
          .logs()
          .match(
            /Plugin replacement applied|config reload disabled|config reload failed|requires gateway restart|reloading plugins|config change detected/giu,
          ) ?? [];
      console.warn("Plugin lifecycle outcome:", facts.slice(-8));
      throw error;
    } finally {
      await suite.closeBrowserContext(context);
    }
  }, 180_000);
});
