import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
import { expect, it, vi } from "vitest";
import browserPlugin from "../../extensions/browser/index.js";
import { SqliteBoardStore } from "../../src/boards/sqlite-board-store.js";
import { replaceSessionEntrySync } from "../../src/config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../src/config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  createPluginGatewayMethodDescriptor,
  type GatewayMethodDescriptor,
} from "../../src/gateway/methods/descriptor.js";
import { createGatewayMethodRegistry } from "../../src/gateway/methods/registry.js";
import { handleGatewayRequest } from "../../src/gateway/server-methods.js";
import { createBoardHandlers } from "../../src/gateway/server-methods/board.js";
import type { GatewayClient } from "../../src/gateway/server-methods/types.js";
import {
  createContext,
  createOperatorClient,
} from "../../src/gateway/server-plugin-in-process-dispatch.test-support.js";
import { bindSessionRowProjection } from "../../src/gateway/session-row-projection-access.js";
import { createSessionRowProjection } from "../../src/gateway/session-row-projection.js";
import { withTempConfig } from "../../src/gateway/test-temp-config.js";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "../../src/plugin-sdk/plugin-state-test-runtime.js";
import { createTestPluginApi } from "../../src/plugin-sdk/plugin-test-api.js";
import { createPluginRuntimeMock } from "../../src/plugin-sdk/test-helpers/plugin-runtime-mock.js";
import type { OpenClawPluginService } from "../../src/plugins/types.js";
import { ensureProfileForEmail } from "../../src/state/user-profiles.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { getFreePort } from "../../src/test-utils/ports.js";
import { createDeferred, withTestTimeout } from "../helpers/promise.js";

it.runIf(process.env.OPENCLAW_BROWSER_SNAPSHOT_E2E === "1")(
  "admits a writer and prevents nonmember or revoked startup from reaching the destination",
  async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
        browser = await chromium.launchPersistentContext(path.join(state.root, "chromium"), {
          headless: true,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: [`--remote-debugging-port=${port}`, "--no-sandbox"],
        });
        const cfg: OpenClawConfig = {
          agents: { entries: { main: {} } },
          gateway: { auth: { mode: "token", token: "browser-authority-fixture-token" } },
          browser: {
            enabled: true,
            headless: true,
            noSandbox: true,
            defaultProfile: "openclaw",
            profiles: { openclaw: { cdpUrl, color: "#FF4500" } },
            ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
          },
          plugins: { entries: { browser: { enabled: true } } },
        };
        await withTempConfig({
          cfg,
          run: async () => {
            const owner = ensureProfileForEmail("browser-owner@example.test");
            const writer = ensureProfileForEmail("browser-writer@example.test");
            const outsider = ensureProfileForEmail("browser-outsider@example.test");
            const sessionKey = "agent:main:dashboard:authority";
            const target = { agentId: "main", sessionKey };
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
            const context = createContext();
            context.getRuntimeConfig = () => cfg;
            context.resolveGatewayContext = () => context;
            const projection = await createSessionRowProjection({ cfg, context, modelCatalog: [] });
            bindSessionRowProjection(context, () => projection);
            const descriptors: GatewayMethodDescriptor[] = [];
            const services: OpenClawPluginService[] = [];
            const ownerClient = createOperatorClient({
              profileId: owner.id,
              scopes: ["operator.admin"],
            });
            const boardHandlers = createBoardHandlers(store);
            const runtime = createPluginRuntimeMock({
              gateway: {
                isAvailable: async () => true,
                request: async <T>(method: string, params?: Record<string, unknown>) => {
                  assert(
                    method === "board.get",
                    "The Browser definition reader must use board.get",
                  );
                  let result: unknown;
                  await boardHandlers[method]!({
                    req: { type: "req", id: "board", method },
                    params: params ?? {},
                    client: ownerClient,
                    context,
                    isWebchatConnect: () => false,
                    respond: (ok, payload, error) => {
                      if (!ok) {
                        throw new Error(error?.message);
                      }
                      result = payload;
                    },
                  });
                  return result as T;
                },
              },
              state: {
                openSyncKeyedStore: (options) =>
                  createPluginStateSyncKeyedStoreForTests("browser", options),
                openKeyedStore: (options) =>
                  createPluginStateKeyedStoreForTests("browser", options),
              },
            });
            const api = createTestPluginApi({
              id: "browser",
              config: cfg,
              runtime,
              registerGatewayMethod: (name, handler, options) =>
                descriptors.push(
                  createPluginGatewayMethodDescriptor({
                    pluginId: "browser",
                    name,
                    handler,
                    ...options,
                  }),
                ),
              registerService: (service) => services.push(service),
            });
            browserPlugin.register(api);
            const methodRegistry = createGatewayMethodRegistry(descriptors);
            const invoke = async (name: string, client: GatewayClient) => {
              const respond = vi.fn();
              await handleGatewayRequest({
                req: {
                  type: "req",
                  id: name,
                  method: "browser.dashboard.request",
                  params: {
                    ...target,
                    method: "POST",
                    path: "/dashboard",
                    dashboard: { name },
                  },
                },
                client,
                context,
                methodRegistry,
                respond,
                isWebchatConnect: () => false,
              });
              expect(respond).toHaveBeenCalledOnce();
              return respond.mock.calls[0]!;
            };
            const writerClient = createOperatorClient({
              profileId: writer.id,
              scopes: ["operator.write"],
            });
            const connect = chromium.connectOverCDP.bind(chromium);
            let release: (() => void) | undefined;
            let pending: ReturnType<typeof invoke> | undefined;
            try {
              await projection.ensureMaterialized();
              const denied = await invoke(
                "denied",
                createOperatorClient({ profileId: outsider.id, scopes: ["operator.write"] }),
              );
              expect(denied[0]).toBe(false);
              expect(requests).toEqual([]);
              const entered = createDeferred();
              const resumed = createDeferred();
              release = () => resumed.resolve();
              let holdAllocation = false;
              // Instrument the real dependency's settlement, not admission or Browser execution.
              vi.spyOn(chromium, "connectOverCDP").mockImplementation(async (...args) => {
                const connected = await connect(...args);
                const allocate = connected.newContext.bind(connected);
                vi.spyOn(connected, "newContext").mockImplementation(async (...contextArgs) => {
                  const allocated = await allocate(...contextArgs);
                  if (holdAllocation) {
                    entered.resolve();
                    await resumed.promise;
                  }
                  return allocated;
                });
                return connected;
              });
              const allowed = await invoke("allowed", writerClient);
              expect(allowed[0], JSON.stringify(allowed[2])).toBe(true);
              expect(requests).toEqual(["/authority/allowed"]);
              holdAllocation = true;
              pending = invoke("revoked", writerClient);
              void pending.catch(() => {});
              await withTestTimeout(
                entered.promise,
                15_000,
                "Browser did not enter context allocation",
              );
              await removeSessionMember(target, writer.id);
              await projection.prepareMembership();
              resumed.resolve();
              const revoked = await pending;
              expect(revoked[0]).toBe(false);
              expect(requests).toEqual(["/authority/allowed"]);
            } finally {
              release?.();
              await pending?.catch(() => {});
              vi.restoreAllMocks();
              for (const service of services) {
                await service.stop?.({ config: cfg, stateDir: state.stateDir, logger: api.logger });
              }
              projection.dispose();
            }
          },
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
    });
  },
  60_000,
);
