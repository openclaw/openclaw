import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext } from "playwright-core";
import { expect, it, vi } from "vitest";
import browserPlugin from "../../extensions/browser/index.js";
import { SqliteBoardStore } from "../../src/boards/sqlite-board-store.js";
import { writeConfigFile } from "../../src/config/config.js";
import { replaceSessionEntrySync } from "../../src/config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../src/config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  openWs,
  rpcReq,
  testState,
  withGatewayServer,
} from "../../src/gateway/server.auth.test-helpers.js";
import { setTestPluginRegistry } from "../../src/gateway/test-helpers.plugin-registry.js";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "../../src/plugin-sdk/plugin-test-contracts.js";
import { createPluginRecord } from "../../src/plugin-sdk/plugin-test-runtime.js";
import { runPluginRegisterSyncInRegistry } from "../../src/plugins/loader-module-runtime.js";
import { ensureProfileForEmail } from "../../src/state/user-profiles.js";
import { getFreePort } from "../../src/test-utils/ports.js";
import { createDeferred, withTestTimeout } from "../helpers/promise.js";

installGatewayTestHooks({ scope: "suite" });

it.runIf(process.env.OPENCLAW_BROWSER_SNAPSHOT_E2E === "1")(
  "authenticates a writer and prevents revoked startup or existing-page navigation from reaching the destination",
  async () => {
    const root = process.env.OPENCLAW_STATE_DIR;
    assert(root, "Gateway test hooks must own an isolated state directory");
    const requests: string[] = [];
    const destination = createServer((request, response) => {
      if (request.url?.startsWith("/authority/")) {
        requests.push(request.url);
      }
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>Authority fixture</title>");
    });
    await new Promise<void>((resolve) => {
      destination.listen(0, "127.0.0.1", resolve);
    });
    let browser: BrowserContext | undefined;
    try {
      const origin = `http://127.0.0.1:${(destination.address() as AddressInfo).port}`;
      const port = await getFreePort();
      const cdpUrl = `http://127.0.0.1:${port}`;
      browser = await chromium.launchPersistentContext(path.join(root, "chromium"), {
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        args: [`--remote-debugging-port=${port}`, "--no-sandbox"],
      });
      const browserOrigin = "https://control.example.test";
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} } },
        gateway: {
          trustedProxies: ["127.0.0.1"],
          controlUi: { allowedOrigins: [browserOrigin] },
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-forwarded-user",
              requiredHeaders: ["x-forwarded-proto"],
              allowLoopback: true,
            },
          },
        },
        browser: {
          enabled: true,
          headless: true,
          noSandbox: true,
          defaultProfile: "openclaw",
          profiles: { openclaw: { cdpUrl } },
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
        },
        plugins: { entries: { browser: { enabled: true } } },
      };
      testState.gatewayAuth = cfg.gateway!.auth;
      testState.gatewayControlUi = cfg.gateway!.controlUi;
      await writeConfigFile(cfg);
      const owner = ensureProfileForEmail("browser-owner@example.test");
      const writerEmail = "browser-writer@example.test";
      const outsiderEmail = "browser-outsider@example.test";
      const writer = ensureProfileForEmail(writerEmail);
      ensureProfileForEmail(outsiderEmail);
      const target = { agentId: "main", sessionKey: "agent:main:dashboard:authority" };
      replaceSessionEntrySync(target, {
        sessionId: "browser-authority",
        lifecycleRevision: "one",
        updatedAt: 1,
        visibility: "read-only",
        createdActor: { type: "human", source: "profile", id: owner.id },
      });
      await addSessionMember(target, { identityId: writer.id, addedBy: owner.id });
      const store = new SqliteBoardStore({
        resolveSession: (boardTarget) => ({ ...boardTarget, agentId: "main" }),
      });
      for (const name of ["allowed", "denied", "revoked"]) {
        await store.putWidget({
          ...target,
          name,
          content: {
            kind: "plugin",
            pluginKind: "browser:dashboard",
            props: { url: `${origin}/authority/${name}` },
          },
        });
      }
      const { registry } = createPluginRegistryFixture(cfg);
      const record = createPluginRecord({
        id: "browser",
        name: "Browser",
        origin: "bundled",
        source: fileURLToPath(new URL("../../extensions/browser/index.ts", import.meta.url)),
      });
      registerTestPlugin({
        registry,
        config: cfg,
        record,
        register: (api) => {
          // Match loader registration ownership so subsequent RPCs share its runtime slots.
          runPluginRegisterSyncInRegistry(
            browserPlugin.register,
            api,
            registry.registry,
            record.id,
          );
        },
      });
      setTestPluginRegistry(registry.registry);
      await withGatewayServer(async ({ port: gatewayPort }) => {
        const sockets: Awaited<ReturnType<typeof openWs>>[] = [];
        const connectWriter = async (email: string) => {
          const socket = await openWs(gatewayPort, {
            origin: browserOrigin,
            "x-forwarded-for": "203.0.113.50",
            "x-forwarded-proto": "https",
            "x-forwarded-user": email,
          });
          sockets.push(socket);
          const connected = await connectReq(socket, {
            skipDefaultAuth: true,
            prePairDevice: true,
            scopes: ["operator.write"],
            client: CONTROL_UI_CLIENT,
            deviceIdentityPath: path.join(root, `${email}.sqlite`),
            browserOrigin,
          });
          expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
          expect(connected.payload).toMatchObject({ auth: { scopes: ["operator.write"] } });
          return socket;
        };
        const invoke = (
          name: string,
          socket: Awaited<ReturnType<typeof openWs>>,
          route = "/dashboard",
          body?: Record<string, unknown>,
        ) =>
          rpcReq(socket, "browser.dashboard.request", {
            ...target,
            method: "POST",
            path: route,
            dashboard: { name },
            body,
            timeoutMs: 120_000,
          });
        let release: (() => void) | undefined;
        let pending: ReturnType<typeof invoke> | undefined;
        try {
          const writerSocket = await connectWriter(writerEmail);
          const outsiderSocket = await connectWriter(outsiderEmail);
          expect((await invoke("denied", outsiderSocket)).ok).toBe(false);
          expect(requests).toEqual([]);
          let entered = createDeferred();
          let resumed = createDeferred();
          release = () => resumed.resolve();
          let holdAllocation = false;
          let holdNavigation = false;
          const connect = chromium.connectOverCDP.bind(chromium);
          // Delay only the real dependency's settlement; authentication and effects remain real.
          vi.spyOn(chromium, "connectOverCDP").mockImplementation(async (...args) => {
            const connected = await connect(...args);
            const allocate = connected.newContext.bind(connected);
            vi.spyOn(connected, "newContext").mockImplementation(async (...contextArgs) => {
              const allocated = await allocate(...contextArgs);
              const newPage = allocated.newPage.bind(allocated);
              vi.spyOn(allocated, "newPage").mockImplementation(async () => {
                const page = await newPage();
                const route = page.route.bind(page);
                vi.spyOn(page, "route").mockImplementation(async (...routeArgs) => {
                  const registration = await route(...routeArgs);
                  if (holdNavigation) {
                    entered.resolve();
                    await resumed.promise;
                  }
                  return registration;
                });
                return page;
              });
              if (holdAllocation) {
                entered.resolve();
                await resumed.promise;
              }
              return allocated;
            });
            return connected;
          });
          const allowed = await invoke("allowed", writerSocket);
          expect(allowed.ok, JSON.stringify(allowed.error)).toBe(true);
          expect(requests).toEqual(["/authority/allowed"]);
          const navigated = await invoke("allowed", writerSocket, "/navigate", {
            url: `${origin}/authority/navigated`,
          });
          expect(navigated.ok, JSON.stringify(navigated.error)).toBe(true);
          expect(requests).toEqual(["/authority/allowed", "/authority/navigated"]);
          holdNavigation = true;
          pending = invoke("allowed", writerSocket, "/navigate", {
            url: `${origin}/authority/revoked-navigation`,
          });
          void pending.catch(() => {});
          await withTestTimeout(
            Promise.race([
              entered.promise,
              pending.then((result) => {
                throw new Error(`Browser settled before navigation: ${JSON.stringify(result)}`);
              }),
            ]),
            15_000,
            "Browser did not enter existing-page navigation preparation",
          );
          await removeSessionMember(target, writer.id);
          resumed.resolve();
          expect((await pending).ok).toBe(false);
          expect(requests).toEqual(["/authority/allowed", "/authority/navigated"]);
          holdNavigation = false;
          await addSessionMember(target, { identityId: writer.id, addedBy: owner.id });
          entered = createDeferred();
          resumed = createDeferred();
          holdAllocation = true;
          pending = invoke("revoked", writerSocket);
          void pending.catch(() => {});
          await withTestTimeout(
            Promise.race([
              entered.promise,
              pending.then((result) => {
                throw new Error(`Browser settled before allocation: ${JSON.stringify(result)}`);
              }),
            ]),
            15_000,
            "Browser did not enter context allocation",
          );
          await removeSessionMember(target, writer.id);
          resumed.resolve();
          expect((await pending).ok).toBe(false);
          expect(requests).toEqual(["/authority/allowed", "/authority/navigated"]);
        } finally {
          release?.();
          await pending?.catch(() => {});
          vi.restoreAllMocks();
          for (const socket of sockets) {
            socket.close();
          }
        }
      });
    } finally {
      destination.closeAllConnections();
      await Promise.all([
        browser?.close(),
        new Promise<void>((resolve) => {
          destination.close(() => resolve());
        }),
      ]);
    }
  },
  60_000,
);
