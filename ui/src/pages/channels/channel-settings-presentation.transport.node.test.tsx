import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import type { ControlUiChannelSettingsContext } from "../../../../src/plugin-sdk/control-ui-settings.js";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
  respondJson,
} from "../../../../test/helpers/gateway-integration-fixtures.js";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { bindBrowserHttpFailures } from "../../app/browser-http.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  ChannelSettingsSlot,
  createChannelSettingsPresentation,
} from "./channel-settings-presentation.tsx";
import { createChannelsViewProps } from "./view.test-support.ts";

afterEach(() => vi.unstubAllGlobals());

async function transportFixture(scopes: string[], firstStatus: number, signal: AbortSignal) {
  const arrivals: Array<{
    method: string | undefined;
    path: string | undefined;
    authorization: string | undefined;
    body?: string;
  }> = [];
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    // Count arrivals before reading the body so aborted or partial requests cannot disappear.
    const arrival = {
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body: "",
    };
    arrivals.push(arrival);
    const status = arrivals.length === 1 ? firstStatus : 200;
    void readRequestText(request)
      .then((body) => {
        arrival.body = body;
        respondJson(response, { marker: "server-response" }, status);
      })
      .catch((error: unknown) => {
        errors.push(error);
        response.destroy(
          error instanceof Error ? error : new Error("Request failed", { cause: error }),
        );
      });
  });
  let mounted: ReturnType<typeof mountSolid> | undefined;
  let binding: GatewayPageBinding | undefined;
  const clients: GatewayBrowserClient[] = [];
  const close = async () => {
    mounted?.unmount();
    binding?.dispose();
    for (const client of clients) {
      client.stop();
    }
    await closeHttpServer(server);
  };
  try {
    const origin = await listenLoopback(server);
    const nativeFetch = globalThis.fetch;
    // Node lacks browser-relative URLs; only resolve the URL, retaining real HTTP and its signal.
    const relativeFetch: typeof fetch = (input, init) =>
      nativeFetch(typeof input === "string" ? new URL(input, origin) : input, init);
    vi.stubGlobal("fetch", relativeFetch);
    const createClient = () => {
      const client = new GatewayBrowserClient({ url: origin.replace("http:", "ws:") });
      clients.push(client);
      return client;
    };
    const snapshot: ApplicationGatewaySnapshot = {
      client: createClient(),
      phase: "connected",
      offlineStable: false,
      canvasPluginSurfaceUrl: null,
      hello: {
        type: "hello-ok",
        protocol: 3,
        auth: { role: "operator", scopes, deviceToken: "fixture-device-token" },
      },
      assistantAgentId: null,
      sessionKey: "main",
      lastError: null,
      lastErrorCode: null,
    };
    const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
    const retained = createDeferred<ControlUiChannelSettingsContext>();
    const application = {
      gateway: {
        snapshot,
        connection: { token: "fixture-saved-token", password: "" },
        subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      channels: {},
      runtimeConfig: {},
      plugins: {
        async loadSettingsView(_placement: unknown, mountSignal: AbortSignal) {
          return {
            signal: mountSignal,
            dispose() {},
            view: {
              mount(_container: HTMLElement, context: ControlUiChannelSettingsContext) {
                retained.resolve(context);
                return { update() {}, dispose() {} };
              },
            },
          };
        },
      },
    } as unknown as ApplicationContext;
    mounted = mountSolid(() => {
      const props = createChannelsViewProps(null, null);
      const presentation = createChannelSettingsPresentation({
        getContext: () => application,
        getProps: () => props,
        getConnection: () => binding!,
      });
      binding = new GatewayPageBinding(() => presentation.sync(), {
        getGateway: () => application.gateway,
        onSnapshot: ({ snapshot: next }) => {
          props.canAdmin = hasOperatorAdminAccess(next.hello?.auth ?? null);
        },
      });
      binding.connect();
      return <ChannelSettingsSlot channelId="profile-fixture" presentation={presentation} />;
    });
    flush();
    const context = await withinTest(retained.promise, signal);
    return {
      arrivals,
      errors,
      close,
      request: (accountId = "main/account", path = ["profile"]) =>
        context.request({
          accountId,
          path,
          method: "PUT",
          body: { name: "Example" },
          signal,
        }),
      retire(cause: "admin" | "client" | "presentation") {
        if (cause === "presentation") {
          mounted!.unmount();
          return;
        }
        if (cause === "admin") {
          snapshot.hello = {
            ...snapshot.hello!,
            auth: { role: "operator", scopes: ["operator.read"] },
          };
        } else {
          snapshot.client = createClient();
        }
        for (const notify of listeners) {
          notify(snapshot);
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

it.for([200, 401])(
  "sends admitted HTTP requests with credential fallback after %s",
  async (status, { signal }) => {
    const f = await transportFixture(["operator.admin"], status, signal);
    try {
      await expect(f.request()).resolves.toMatchObject({
        ok: true,
        status: 200,
        data: { marker: "server-response" },
      });
      expect(f.arrivals).toEqual(
        (status === 401
          ? ["fixture-device-token", "fixture-saved-token"]
          : ["fixture-device-token"]
        ).map((token) => ({
          method: "PUT",
          path: "/api/channels/profile-fixture/main%2Faccount/profile",
          authorization: `Bearer ${token}`,
          body: JSON.stringify({ name: "Example" }),
        })),
      );
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

it("encodes opaque account and path segments once in real HTTP requests", async ({ signal }) => {
  const f = await transportFixture(["operator.admin"], 200, signal);
  try {
    await expect(f.request("main/account", ["profile", "a?b#c"])).resolves.toMatchObject({
      ok: true,
    });
    await expect(f.request("%2e%2e", ["%2e%2e"])).resolves.toMatchObject({ ok: true });
    expect(f.arrivals.map((arrival) => arrival.path)).toEqual([
      "/api/channels/profile-fixture/main%2Faccount/profile/a%3Fb%23c",
      "/api/channels/profile-fixture/%252e%252e/%252e%252e",
    ]);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

it("rejects traversal segments and missing operation paths before HTTP dispatch", async ({
  signal,
}) => {
  const f = await transportFixture(["operator.admin"], 200, signal);
  try {
    for (const segment of [".", "..", ""]) {
      await expect(f.request(segment, ["profile"])).rejects.toThrow("account-relative");
      await expect(f.request("default", [segment])).rejects.toThrow("account-relative");
    }
    await expect(f.request("default", [])).rejects.toThrow("account-relative");
    expect(f.arrivals).toHaveLength(0);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

it("rejects a read-only plugin capability before real HTTP dispatch", async ({ signal }) => {
  const f = await transportFixture(["operator.read"], 200, signal);
  try {
    await expect(f.request()).rejects.toThrow("connected administrator");
    expect(f.arrivals).toHaveLength(0);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

it.for(["admin", "client", "presentation"] as const)(
  "rejects credential retry and retained HTTP dispatch after %s retirement",
  async (cause, { signal }) => {
    const f = await transportFixture(["operator.admin"], 401, signal);
    const stop = bindBrowserHttpFailures(() => f.retire(cause));
    try {
      await expect(f.request()).rejects.toThrow();
      await expect(f.request()).rejects.toThrow();
      expect(f.arrivals).toHaveLength(1);
      expect(f.arrivals[0]?.authorization).toBe("Bearer fixture-device-token");
      expect(f.errors).toEqual([]);
    } finally {
      stop();
      await f.close();
    }
  },
);
