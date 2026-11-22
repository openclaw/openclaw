import type { Page } from "playwright";
import type { ViteDevServer } from "vite";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import {
  setDisplayName,
  setUserProfileRole,
} from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { deviceGatewayEnv } from "./device-gateway-env.test-support.ts";
import { createGatewayProxy, gatewayProxyRoute } from "./gateway-proxy.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Guest sidebar pins real Gateway",
  startServerBeforeBrowser: true,
});
const scopes = ["operator.sessions.read", "operator.sessions.write"];
const parentKey = "agent:main:dashboard:groups-parent";
const childKey = "agent:main:dashboard:groups-child";
const people = ["groups-owner@example.test", "groups-other@example.test"];

function rpc<T>(page: Page, method: string, params: Record<string, unknown>): Promise<T> {
  return evaluateControlUiContext(
    page,
    async (app, request) => {
      const client = app.gateway.snapshot.client;
      if (!client) {
        throw new Error("Guest Gateway client unavailable");
      }
      return client.request<T>(request.method, request.params);
    },
    { method, params },
  );
}

suite.define(() => {
  it("preserves child conversations and browser-local pins with only session permissions", async (test) => {
    let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
    let gateway: GatewayServer | undefined;
    const proxies: ViteDevServer[] = [];
    await suite.runScenario(test, {
      async run() {
        const port = await getFreePort();
        state = await createOpenClawTestState({
          label: "guest-sidebar-pins",
          layout: "home",
          env: {
            ...deviceGatewayEnv,
            OPENCLAW_GATEWAY_PASSWORD: undefined,
            OPENCLAW_GATEWAY_TOKEN: undefined,
          },
        });
        const profiles = people.map((email, index) => {
          const profile = ensureProfileForEmail(email);
          setUserProfileRole(profile.id, "guest");
          setDisplayName(profile.id, index ? "Guest Two" : "Guest One");
          return profile.id;
        });
        const trustedProxy = {
          allowLoopback: true,
          allowUsers: people,
          deviceAutoApprove: { enabled: true, scopes },
          requiredHeaders: ["x-forwarded-proto"],
          userHeader: "x-forwarded-user",
        };
        await state.writeConfig({
          agents: {
            ownership: "explicit",
            defaults: {
              workspace: state.workspaceDir,
              model: "fixture/echo",
              modelPolicy: { allow: ["fixture/echo"] },
            },
            entries: { main: {} },
          },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              fixture: {
                api: "openai-responses",
                baseUrl: "http://127.0.0.1:9/v1",
                apiKey: "synthetic-fixture-key",
                models: [{ id: "echo", name: "Fixture model" }],
              },
            },
          },
          gateway: {
            port,
            auth: { mode: "trusted-proxy", trustedProxy },
            trustedProxies: ["127.0.0.1", "::1"],
            controlUi: { enabled: false, allowedOrigins: [new URL(suite.server.baseUrl).origin] },
            roles: {
              default: "guest",
              definitions: { guest: { agents: ["main"], sessions: { others: "none" }, scopes } },
            },
          },
        });
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        gateway = await startGatewayServer(port, {
          auth: { mode: "trusted-proxy", trustedProxy },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        const urls: string[] = [];
        for (const [index, email] of people.entries()) {
          const route = gatewayProxyRoute(port, email, `192.0.2.${10 + index}`);
          const proxy = await createGatewayProxy(state.workspaceDir, {
            "/": { ...route, headers: { ...route.headers, "x-openclaw-scopes": scopes.join(",") } },
          });
          proxies.push(proxy);
          await proxy.listen();
          const url = new URL(proxy.resolvedUrls!.local[0]!);
          url.protocol = "ws:";
          urls.push(url.href);
        }
        const connect = async (page: Page, index: number) => {
          const url = new URL("new", suite.server.baseUrl);
          url.hash = new URLSearchParams({ gatewayUrl: urls[index]! }).toString();
          await page.goto(url.href);
          await page
            .locator("openclaw-gateway-url-confirmation")
            .getByRole("button", { name: `Switch to ${new URL(urls[index]!).host}`, exact: true })
            .click();
          await waitForControlUiGatewayReady(page);
          expect(
            await evaluateControlUiContext(page, (app) =>
              app.gateway.snapshot.hello?.auth?.scopes?.toSorted(),
            ),
          ).toEqual(scopes.toSorted());
          expect(await rpc(page, "users.self", {})).toMatchObject({
            profile: { id: profiles[index], role: "guest" },
          });
        };
        const setupContext = await suite.newBrowserContext({
          reducedMotion: "reduce",
          viewport: { width: 1280, height: 900 },
        });
        const editor = await setupContext.newPage();
        await connect(editor, 0);
        await rpc(editor, "sessions.create", {
          key: parentKey,
          label: "Reliability Tracker",
          category: "Engineering",
        });
        await rpc(editor, "sessions.create", {
          key: childKey,
          label: "Verification notes",
          parentSessionKey: parentKey,
        });
        const initialStorage = await setupContext.storageState();
        await suite.withPage(
          {
            reducedMotion: "reduce",
            viewport: { width: 1280, height: 900 },
            storageState: initialStorage,
          },
          async ({ page }) => {
            const methods: string[] = [];
            page.on("websocket", (socket) =>
              socket.on("framesent", (frame) => {
                const request = JSON.parse(frame.payload.toString());
                if (request.type === "req" && request.method !== "connect") {
                  methods.push(request.method);
                }
              }),
            );
            await page.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
            await waitForControlUiGatewayReady(page);
            const sidebar = page.locator("openclaw-app-sidebar");
            const toggle = sidebar.locator(`[data-child-session-toggle="${parentKey}"]`);
            await toggle.waitFor();
            if ((await toggle.getAttribute("aria-expanded")) === "false") {
              await toggle.click();
            }
            await sidebar.getByRole("link", { name: /Verification notes/ }).waitFor();
            methods.length = 0;
            await rpc(editor, "sessions.patch", {
              key: childKey,
              label: "Updated verification notes",
            });
            await expect
              .poll(() => sidebar.getByRole("link", { name: /Updated verification notes/ }).count())
              .toBe(1);
            const parent = sidebar.locator(`[data-session-key="${parentKey}"]`);
            await parent.click({ button: "right" });
            expect(
              await page.getByRole("menuitem", { name: "Add to section", exact: true }).count(),
            ).toBe(0);
            await page.getByRole("menuitem", { name: /Pin session/ }).click();
            const pinned = sidebar.locator(
              `[data-session-section="pinned"] [data-session-key="${parentKey}"]`,
            );
            await pinned.waitFor();
            await page.reload();
            await waitForControlUiGatewayReady(page);
            await pinned.waitFor();
            const forbidden = new Set([
              "users.prefs.set",
              "sessions.patch",
              "sessions.patchMany",
              "sessions.delete",
              "sessions.deleteMany",
              "sessions.groups.put",
              "sessions.groups.rename",
              "sessions.groups.update",
              "sessions.groups.defaults",
              "sessions.groups.delete",
              "config.patch",
              "config.set",
            ]);
            expect(methods.filter((method) => forbidden.has(method))).toEqual([]);
          },
        );
        const otherContext = await suite.newBrowserContext({ reducedMotion: "reduce" });
        const other = await otherContext.newPage();
        await connect(other, 1);
        await expect(rpc(other, "sessions.describe", { key: parentKey })).rejects.toThrow(
          `Session "${parentKey}" was not found.`,
        );
        await suite.closeBrowserContext(otherContext);
        await suite.closeBrowserContext(setupContext);
      },
      close: async () =>
        runQaGatewayFixture(
          async () => {},
          ...proxies.map((proxy) => () => proxy.close()),
          () => gateway?.close({ reason: "guest sidebar pins proof cleanup" }),
        ),
      release: async () => state?.cleanup(),
      retainedState: () => state?.root,
    });
  });
});
