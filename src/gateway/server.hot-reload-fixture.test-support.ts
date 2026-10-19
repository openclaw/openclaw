import { afterEach, beforeEach } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/index.js";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { resetLogger } from "../logging/logger.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";

/** Real config/WS fixture with credential fallback disabled and ordered owner cleanup. */
export function installHotReloadFixture(
  label: string,
  options: {
    env?: NodeJS.ProcessEnv;
    beforeClose?: Array<() => unknown>;
    afterClose?: Array<() => unknown>;
  } = {},
) {
  let state: OpenClawTestState;
  let port: number;
  let server: { close(): Promise<void> } | undefined;
  const clients: GatewayClient[] = [];
  beforeEach(async () => {
    state = await createOpenClawTestState({
      label,
      env: {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        ...options.env,
      },
    });
    port = await getFreePort();
  });
  afterEach(() =>
    runQaGatewayFixture(
      async () => {},
      ...(options.beforeClose ?? []),
      ...clients.splice(0).map((client) => () => client.stopAndWait()),
      async () => {
        await server?.close();
        server = undefined;
      },
      ...(options.afterClose ?? []),
      () => state.cleanup(),
      () => resetLogger(),
      () => clearPluginMetadataLifecycleCaches(),
    ),
  );
  return {
    get state() {
      return state;
    },
    get port() {
      return port;
    },
    ownServer<T extends { close(): Promise<void> }>(started: T): T {
      server = started;
      return started;
    },
    async connect(
      credentials: Pick<
        GatewayClientOptions,
        "token" | "deviceToken" | "deviceIdentity" | "clientName" | "mode" | "origin"
      >,
    ) {
      const connected = createDeferredCore<HelloOk>();
      const closed = createDeferredCore<{ code: number; reason: string }>();
      const hellos: HelloOk[] = [];
      const closeEvents: Array<{ code: number; reason: string }> = [];
      const client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        clientName: "gateway-client",
        clientVersion: "1.0.0",
        platform: "test",
        mode: "backend",
        deviceIdentity: null,
        scopes: ["operator.admin"],
        ...credentials,
        hostDeps: {
          loadDeviceAuthToken: () => null,
          storeDeviceAuthToken: () => {},
          clearDeviceAuthToken: () => {},
        },
        onHelloOk: (hello) => {
          hellos.push(hello);
          connected.resolve(hello);
        },
        onConnectError: (error) => connected.reject(error),
        onClose: (code, reason) => {
          closeEvents.push({ code, reason });
          connected.reject(new Error(`closed ${code}: ${reason}`));
          closed.resolve({ code, reason });
        },
      });
      clients.push(client);
      client.start();
      const hello = await withTestTimeout(connected.promise, 10_000, "gateway connect timeout");
      return { client, hello, hellos, closed: closed.promise, closeEvents };
    },
  };
}
