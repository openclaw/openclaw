/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"https://gateway.example/"} */

import { webcrypto } from "node:crypto";
import type { ConnectParams } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { MockWebSocket, wsInstances } from "../api/gateway-socket.test-support.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import { fetchControlUiResource } from "./browser-http.ts";
import {
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
} from "./gateway-store.test-support.ts";
import * as gatewayStore from "./gateway-store.ts";
import { loadSettings, loadUiPreferences, patchSettings, persistSessionToken } from "./settings.ts";
import * as staleChunkReload from "./stale-chunk-reload.ts";

const NATIVE_AUTH_KEY = "__OPENCLAW_NATIVE_CONTROL_AUTH__";
const originalUrl = window.location.href;
let runtime: ApplicationRuntime | undefined;

function setNativeAuth(auth: { gatewayUrl: string; token?: string; password?: string }) {
  window[NATIVE_AUTH_KEY] = auth;
}
function useGateway(settings?: Parameters<typeof createGatewayStoreTestStore>[0]) {
  const store = createGatewayStoreTestStore(settings);
  vi.spyOn(gatewayStore, "createApplicationGateway").mockReturnValue(store.gateway);
  return store;
}
async function startDocument() {
  runtime = bootstrapApplication();
  vi.spyOn(runtime.router, "start").mockResolvedValue(undefined);
  await runtime.start();
}
function mockBrowserHandoff() {
  const fetchMock = vi.fn<typeof fetch>(async () =>
    Response.json({ bootstrapToken: "owner-bootstrap", bootstrapProfile: "owner" }),
  );
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    input === "/control-ui-config.json"
      ? Promise.resolve(new Response(null, { status: 401 }))
      : fetchMock(input, init),
  );
  return fetchMock;
}
function rejectAuth(store: ReturnType<typeof useGateway>, code: string) {
  store.current().testOptions.onClose?.({
    code: 4008,
    reason: "connect failed",
    willRetry: false,
    error: { code: "INVALID_REQUEST", message: "authentication missing", details: { code } },
  });
}

beforeEach(() => {
  wsInstances.length = 0;
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  runtime?.stop();
  wsInstances.length = 0;
  runtime = undefined;
  delete window[NATIVE_AUTH_KEY];
  window.history.replaceState({}, "", originalUrl);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(["start", "connect", "plugins"])(
  "retires the %s config response when the application stops",
  async (entry) => {
    window.history.replaceState({}, "", "/focus/terminal");
    const store = useGateway();
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ basePath: "" }));
    vi.stubGlobal("fetch", fetchMock);
    runtime = bootstrapApplication();
    if (entry !== "start") {
      await runtime.start();
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000);
    }
    const previous = runtime.context.config.current;
    const response = createDeferred<Response>();
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => (await response.promise).clone());
    const refresh = vi.spyOn(runtime.context.config, "refresh");
    if (entry === "start") {
      await runtime.start();
    } else {
      store.current().testOptions.onHello?.({
        ...GATEWAY_STORE_TEST_HELLO,
        ...(entry === "plugins" ? { features: { methods: ["plugins.controlUi.list"] } } : {}),
      });
    }
    expect(refresh).toHaveBeenCalledTimes(entry === "plugins" ? 2 : 1);
    const requests = refresh.mock.results.map((request) => {
      if (request.type !== "return") {
        throw new Error("expected a pending config refresh");
      }
      return request.value;
    });
    const signal = fetchMock.mock.calls.at(-1)?.[1]?.signal;

    runtime.stop();
    response.resolve(Response.json({ basePath: "", serverVersion: "retired-runtime" }));
    await Promise.all(requests);

    expect(runtime.context.config.current).toBe(previous);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
  },
);

describe("pending Gateway credentials", () => {
  it.each([
    ["wss://gateway.example", "Bearer document-gateway-token"],
    ["wss://gateway.example/other", null],
    ["wss://gateway.example?tenant=other", null],
    ["wss://other-gateway.example", null],
  ])(
    "scopes browser recovery credentials to the document Gateway (%s)",
    async (gatewayUrl, authorization) => {
      useGateway({
        settings: { ...loadSettings(), gatewayUrl, token: "document-gateway-token" },
      });
      const fetchMock = vi.fn<typeof fetch>(
        async (_url, init) =>
          new Response(null, {
            status: init?.method === "HEAD" ? 200 : 401,
            headers: { "content-type": "application/json" },
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      runtime = bootstrapApplication();
      await fetchControlUiResource("/__openclaw__/assistant-media");
      await expect
        .poll(() => fetchMock.mock.calls.filter(([, init]) => init?.method === "HEAD").length)
        .toBe(1);
      const [url, probeInit] = fetchMock.mock.calls.find(([, init]) => init?.method === "HEAD")!;
      expect(url).toBe("https://gateway.example/control-ui-config.json");
      expect(probeInit?.redirect).toBe("manual");
      expect(new Headers(probeInit?.headers).get("Authorization")).toBe(authorization);
    },
  );

  it.each([
    { decision: "confirm", queryGatewayUrl: "" },
    { decision: "cancel", queryGatewayUrl: "" },
    { decision: "confirm", queryGatewayUrl: "wss://query-gateway.example" },
  ] as const)(
    "binds a reloaded bootstrap after another tab selects a remote ($decision, query: $queryGatewayUrl)",
    async ({ decision, queryGatewayUrl }) => {
      const sockets: RecordingWebSocket[] = [];
      class RecordingWebSocket extends MockWebSocket {
        constructor(readonly url: string) {
          super(url);
          sockets.push(this);
        }
        override close(code = 1000, reason = "") {
          this.emitClose(code, reason);
        }
        async connectFrame() {
          this.emitOpen();
          this.emitMessage({
            type: "event",
            event: "connect.challenge",
            payload: { nonce: "synthetic-challenge", ts: Date.now() },
          });
          await vi.waitFor(() => expect(this.sent).toHaveLength(1));
          const frame: { id: string; method: string; params: ConnectParams } = JSON.parse(
            this.sent[0]!,
          );
          expect(frame.method).toBe("connect");
          return frame;
        }
      }
      vi.stubGlobal("WebSocket", RecordingWebSocket);
      vi.stubGlobal("crypto", webcrypto);
      const bootstrapToken = "synthetic-bound-bootstrap";
      const originalGatewayUrl = "wss://gateway.example";
      const remoteGatewayUrl = "wss://other-gateway.example/openclaw";
      window.history.replaceState(
        {},
        "",
        `/settings/appearance#bootstrapToken=${bootstrapToken}&bootstrapProfile=owner`,
      );
      const probe = createDeferred<Response>();
      const fetchMock = vi.fn<typeof fetch>(() => probe.promise);
      vi.stubGlobal("fetch", fetchMock);
      const reload = vi
        .spyOn(staleChunkReload, "reloadControlUiDocument")
        .mockImplementation(() => {});
      const startSocket = async () => {
        await startDocument();
        return sockets.at(-1)!;
      };
      const originalSocket = await startSocket();
      const firstConnect = await originalSocket.connectFrame();
      expect(originalSocket.url).toBe(originalGatewayUrl);
      expect(firstConnect.params.auth?.bootstrapToken).toBe(bootstrapToken);
      if (queryGatewayUrl) {
        window.history.replaceState(
          {},
          "",
          `/settings/appearance?gatewayUrl=${encodeURIComponent(queryGatewayUrl)}`,
        );
      }
      originalSocket.emitMessage({
        type: "res",
        id: firstConnect.id,
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "protocol mismatch: Control UI updated; reload this page to continue",
          details: {
            code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
            gatewayBuildId: "replacement-build",
            reloadRequired: true,
          },
        },
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

      // Another tab's selection persists without retargeting this mounted connection.
      patchSettings({ gatewayUrl: remoteGatewayUrl });
      expect(loadUiPreferences().gatewayUrl).toBe(remoteGatewayUrl);
      expect(runtime!.context.gateway.connection.gatewayUrl).toBe(originalGatewayUrl);
      probe.resolve(new Response(null, { status: 200 }));
      await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
      const destination = reload.mock.calls[0]![0]!;
      runtime!.stop();
      window.history.replaceState({}, "", destination);

      const remoteSocket = await startSocket();
      const remoteConnect = await remoteSocket.connectFrame();
      expect(remoteSocket.url).toBe(remoteGatewayUrl);
      expect(remoteConnect.params.auth?.bootstrapToken).toBeUndefined();
      expect(runtime!.pendingGatewayConnection?.gatewayUrl).toBe(originalGatewayUrl);
      expect(loadUiPreferences().gatewayUrl).toBe(remoteGatewayUrl);
      expect(window.location.hash).toBe("");

      if (decision === "confirm") {
        runtime!.confirmPendingGatewayConnection();
        const confirmedSocket = sockets.at(-1)!;
        const confirmedConnect = await confirmedSocket.connectFrame();
        expect(confirmedSocket.url).toBe(originalGatewayUrl);
        expect(confirmedConnect.params.auth?.bootstrapToken).toBe(bootstrapToken);
        expect(confirmedConnect.params.scopes).toContain("operator.admin");
        expect(loadUiPreferences().gatewayUrl).toBe(originalGatewayUrl);
      } else {
        runtime!.cancelPendingGatewayConnection();
        runtime!.confirmPendingGatewayConnection();
        expect(sockets).toHaveLength(2);
        expect(remoteSocket.sent).toEqual([JSON.stringify(remoteConnect)]);
        expect(runtime!.context.gateway.connection.gatewayUrl).toBe(remoteGatewayUrl);
        expect(loadUiPreferences().gatewayUrl).toBe(remoteGatewayUrl);
      }
      expect(runtime!.pendingGatewayConnection).toBeNull();
      for (const storage of [localStorage, sessionStorage]) {
        for (let index = 0; index < storage.length; index++) {
          expect(storage.getItem(storage.key(index)!)).not.toContain(bootstrapToken);
        }
      }
    },
  );

  it.each([
    [ConnectErrorDetailCodes.AUTH_TOKEN_MISSING, false],
    [ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING, true],
  ] as const)(
    "recovers %s through its same-origin handoff (retry unavailable: %s) without changing the route",
    async (authCode, retryUnavailable) => {
      window.history.replaceState({}, "", "/settings/appearance?keep=yes#section");
      const initialUrl = window.location.href;
      const store = useGateway();
      const fetchMock = mockBrowserHandoff();
      await startDocument();
      expect(fetchMock).not.toHaveBeenCalled();

      if (retryUnavailable) {
        const revision = store.gateway.connectionRevision;
        store.current().testOptions.onClose?.({
          code: 4008,
          reason: "connect failed",
          error: { code: "UNAVAILABLE", message: "Gateway temporarily unavailable" },
          willRetry: false,
        });
        expect(store.gateway.snapshot).toMatchObject({
          phase: "stopped",
          lastErrorCode: "UNAVAILABLE",
        });
        expect(fetchMock).not.toHaveBeenCalled();

        store.gateway.connect();
        expect(store.gateway.connectionRevision).toBe(revision);
      }

      rejectAuth(store, authCode);

      await vi.waitFor(() =>
        expect(store.gateway.connection.bootstrapToken).toBe("owner-bootstrap"),
      );
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledWith(
        "/.well-known/openclaw/browser-bootstrap",
        expect.objectContaining({
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
        }),
      );
      expect(store.current().testOptions.bootstrapProfile).toBe("owner");
      expect(window.location.href).toBe(initialUrl);
    },
  );

  it.each(["native client", "unconfirmed Gateway"])(
    "does not replace the %s authentication flow with a browser handoff",
    async (flow) => {
      window.history.replaceState({}, "", "/settings/appearance");
      const store = useGateway();
      if (flow === "native client") {
        window[NATIVE_AUTH_KEY] = {
          gatewayUrl: store.gateway.connection.gatewayUrl,
          client: {
            id: "openclaw-ios",
            mode: "ui",
            platform: "iOS 27.0.0",
            deviceFamily: "iPhone",
            scopes: ["operator.read"],
          },
        };
      } else {
        window.history.replaceState(
          {},
          "",
          "/settings/appearance?gatewayUrl=wss%3A%2F%2Fother-gateway.example",
        );
      }
      const fetchMock = mockBrowserHandoff();
      await startDocument();
      rejectAuth(store, ConnectErrorDetailCodes.AUTH_TOKEN_MISSING);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.clients).toHaveLength(1);
    },
  );

  it("re-scopes credentials before confirming a changed Gateway URL", () => {
    const currentGatewayUrl = "wss://gateway.example/openclaw";
    const nextGatewayUrl = "wss://other-gateway.example/openclaw";
    persistSessionToken(nextGatewayUrl, "next-token");
    setNativeAuth({
      gatewayUrl: currentGatewayUrl,
      token: "old-token",
      password: "old-password",
    });
    window.history.replaceState({}, "", `/#gatewayUrl=${encodeURIComponent(nextGatewayUrl)}`);
    runtime = bootstrapApplication();

    runtime.confirmPendingGatewayConnection();

    expect(runtime.context.gateway.connection).toMatchObject({
      gatewayUrl: nextGatewayUrl,
      token: "next-token",
      password: "",
    });
    persistSessionToken(nextGatewayUrl, "");
  });

  it("uses paired-device credentials while other connection bootstrap work is pending", async () => {
    const gatewayUrl = "ws://localhost";
    setNativeAuth({ gatewayUrl });
    window.history.replaceState({}, "", "/settings/appearance");
    const store = useGateway({
      settings: { ...loadSettings(), gatewayUrl, token: "" },
    });
    const pending = createDeferred();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      if (new Headers(init?.headers).get("Authorization") !== "Bearer fixture-device-token") {
        return new Response(null, { status: 401 });
      }
      return new Response(
        JSON.stringify({
          serverVersion: "paired",
          pluginAssetsRequireAuth: true,
          pluginFrameGrants: [
            {
              pluginId: "fixture",
              path: "/__openclaw__/plugins/control-ui/fixture/",
              match: "prefix",
            },
          ],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    runtime = bootstrapApplication();
    runtime.context.gateway.start();
    const client = store.current();
    client.request.mockImplementation(async (method) => {
      if (method === "update.status" || method === "exec.approval.list") {
        await pending.promise;
      }
      return {};
    });

    try {
      client.testOptions.onHello?.({
        type: "hello-ok",
        protocol: 1,
        auth: { role: "operator", scopes: ["operator.admin"], deviceToken: "fixture-device-token" },
      });
      await vi.waitFor(() => {
        const methods = client.request.mock.calls.map(([method]) => method);
        expect(methods).toContain("update.status");
        expect(methods).toContain("exec.approval.list");
      });
      expect(fetchMock).toHaveBeenCalledOnce();

      await expect(runtime.context.config.refresh({ ifNeeded: true })).resolves.toMatchObject({
        serverVersion: "paired",
        pluginFrameGrants: [{ pluginId: "fixture" }],
      });
    } finally {
      runtime.stop();
      pending.resolve();
    }
  });
});
