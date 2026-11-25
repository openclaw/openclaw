/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://127.0.0.1:18789/new"} */
import { gatewayCredentialScope, PROTOCOL_VERSION } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { takeEarlyGatewaySubscription } from "../api/gateway-boot.ts";
import {
  getLatestWebSocket,
  MockWebSocket,
  useNodeFakeTimers,
  wsInstances,
} from "../api/gateway-socket.test-support.ts";
import type { startControlUi } from "../main.runtime.ts";
import {
  discardPrewarmedChatSnapshot,
  peekPrewarmedChatSnapshot,
} from "../pages/chat/chat-snapshot-prewarm.ts";
import * as snapshotDatabase from "../pages/chat/session-snapshot-database.ts";
import {
  CHAT_SNAPSHOT_PROJECTION_VERSION,
  type SessionSnapshotRecord,
} from "../pages/chat/session-snapshot-record.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { prepareApplicationStartup } from "./bootstrap-connection.ts";
import { makeBootRecord } from "./bootstrap.test-support.ts";
import { bootstrapApplication } from "./bootstrap.ts";
import { startEarlyApplicationGateway, type EarlyApplicationGateway } from "./early-gateway.ts";
import * as gatewayCredentials from "./gateway-store.credentials.ts";
import { loadSettings, persistSessionToken, saveSettings } from "./settings.ts";

const mainRuntime = vi.hoisted(() => ({ startControlUi: vi.fn<typeof startControlUi>() }));
// mock-isolation: Observe entrypoint handoff without mounting the full application.
vi.mock("../main.runtime.ts", () => mainRuntime);
// mock-isolation: Exercise the entrypoint independently of jsdom's browser capability probe.
vi.mock("./boot-capabilities.ts", () => ({ unsupportedControlUiBrowser: false }));

let runtime: ReturnType<typeof bootstrapApplication> | undefined;
let early: EarlyApplicationGateway | undefined;

beforeEach(() => {
  useNodeFakeTimers();
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("crypto", { randomUUID: () => "new-preconnect-proof" });
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  wsInstances.length = 0;
  document.documentElement.removeAttribute("data-openclaw-remote-ingress");
  window.history.replaceState({}, "", "/new");
  const gatewayUrl = "ws://127.0.0.1:18789";
  saveSettings({ ...loadSettings(), gatewayUrl });
  persistSessionToken(gatewayUrl, "synthetic-token");
  mainRuntime.startControlUi.mockImplementation(async (_initial, connection) => {
    early = connection;
  });
});

afterEach(() => {
  runtime?.stop();
  early?.transport.client.stop();
  discardPrewarmedChatSnapshot();
  runtime = undefined;
  early = undefined;
  mainRuntime.startControlUi.mockClear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function prepareRuntime() {
  const initial = prepareApplicationStartup();
  early = startEarlyApplicationGateway(initial);
  expect(early).toBeDefined();
  runtime = bootstrapApplication(initial, early);
  for (const routeId of ["new-session", "about"] as const) {
    vi.spyOn(runtime.router.getRoute(routeId)!, "component").mockResolvedValue({
      renderSolid: () => null,
    });
  }
  return { application: runtime, connection: early! };
}

it("prepares credentials once at adoption before starting New", async () => {
  const originalCreate = gatewayCredentials.createGatewayCredentials;
  let prepareCalls = 0;
  let routerStartsAtPreparation = 0;
  let readRouterStarts = () => 0;
  const create = vi
    .spyOn(gatewayCredentials, "createGatewayCredentials")
    .mockImplementation((ownsWarmBoot) => {
      const credentials = originalCreate(ownsWarmBoot);
      const prepare = credentials.prepare.bind(credentials);
      vi.spyOn(credentials, "prepare").mockImplementation((...args) => {
        prepareCalls += 1;
        routerStartsAtPreparation = readRouterStarts();
        return prepare(...args);
      });
      return credentials;
    });
  const initial = prepareApplicationStartup();
  early = startEarlyApplicationGateway(initial);
  expect(create).not.toHaveBeenCalled();
  const socket = getLatestWebSocket();
  socket.emitOpen();
  socket.emitConnectChallenge({ nonce: "new-preconnect", ts: 1_800_000_000_000 });
  await vi.advanceTimersByTimeAsync(0);
  expect(socket.sent).toEqual([]);

  runtime = bootstrapApplication(initial, early);
  vi.spyOn(runtime.router.getRoute("new-session")!, "component").mockResolvedValue({
    renderSolid: () => null,
  });
  expect(create).toHaveBeenCalledOnce();
  expect(prepareCalls).toBe(0);
  const routerStart = vi.spyOn(runtime.router, "start");
  readRouterStarts = () => routerStart.mock.calls.length;
  await runtime.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(prepareCalls).toBe(1);
  expect(routerStartsAtPreparation).toBe(0);
  expect(runtime.context.gateway.snapshot.client).toBe(early?.transport.client);
  expect(wsInstances).toHaveLength(1);
  expect(routerStart).toHaveBeenCalledOnce();
  expect(runtime.router.getState().matches[0]?.routeId).toBe("new-session");
  const connect = JSON.parse(socket.sent[0] ?? "{}");
  expect(connect).toMatchObject({
    method: "connect",
    params: { auth: { token: "synthetic-token" } },
  });
  socket.emitMessage({
    type: "res",
    id: connect.id,
    ok: true,
    payload: {
      type: "hello-ok",
      protocol: PROTOCOL_VERSION,
      auth: { role: "operator", scopes: [] },
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(runtime.context.gateway.snapshot.phase).toBe("connected");
  expect(socket.sent.map((frame) => JSON.parse(frame).method)).not.toContain(
    "sessions.messages.subscribe",
  );
});

it("closes the New connection when stop wins startup", async () => {
  const { application, connection } = prepareRuntime();
  const stop = vi.spyOn(connection.transport.client, "stop");
  const starting = application.start();
  application.stop();
  await starting;
  expect(stop).toHaveBeenCalledOnce();
  expect(application.context.gateway.snapshot.phase).toBe("stopped");
  expect(getLatestWebSocket().sent).toEqual([]);
});

it("rejects preconnection when the document URL changes before adoption", async () => {
  const { application, connection } = prepareRuntime();
  window.history.replaceState({}, "", "/about");
  const starting = application.start();
  await starting;
  expect(application.context.gateway.snapshot.client).not.toBe(connection.transport.client);
  expect(wsInstances).toHaveLength(2);
  expect(wsInstances[0]?.readyState).toBe(3);
});

it.each([
  ["native", "/new"],
  ["confirmation", "/new"],
  ["document", "/new"],
  ["relay", "/new"],
  ["confirmation", "/dashboard/main/dashboard/proof"],
])("keeps %s startup with its ordinary owner on %s", (boundary, pathname) => {
  window.history.replaceState({}, "", pathname);
  const initial = prepareApplicationStartup();
  if (boundary === "native") {
    initial.startup.nativeClient = { clientName: "openclaw-control-ui", mode: "webchat" };
  } else if (boundary === "confirmation") {
    initial.hasPendingGateway = true;
  } else if (boundary === "document") {
    initial.ownsWarmBoot = false;
  } else {
    document.documentElement.setAttribute("data-openclaw-remote-ingress", "true");
  }
  expect(startEarlyApplicationGateway(initial)).toBeUndefined();
  expect(wsInstances).toHaveLength(0);
});

it.each(["/dashboard/main", "/dashboard/main/abcdef12"])(
  "leaves non-literal dashboard route %s with its resolver",
  (pathname) => {
    window.history.replaceState({}, "", pathname);
    expect(startEarlyApplicationGateway(prepareApplicationStartup())).toBeUndefined();
    expect(wsInstances).toHaveLength(0);
  },
);

it("starts literal dashboard history on the early transport after hello", async () => {
  window.history.replaceState({}, "", "/dashboard/main/dashboard/proof");
  early = startEarlyApplicationGateway(prepareApplicationStartup());
  expect(early).toBeDefined();
  expect(wsInstances).toHaveLength(1);
  const socket = getLatestWebSocket();
  socket.emitOpen();
  socket.emitConnectChallenge({ nonce: "dashboard-early", ts: 1_800_000_000_000 });
  await vi.advanceTimersByTimeAsync(0);
  expect(socket.sent.map((frame) => JSON.parse(frame).method)).toEqual(["connect"]);
  const connect = JSON.parse(socket.sent[0]!);
  socket.emitMessage({
    type: "res",
    id: connect.id,
    ok: true,
    payload: { type: "hello-ok", protocol: PROTOCOL_VERSION },
  });
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(0);
  expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual(
    expect.objectContaining({
      method: "sessions.messages.subscribe",
      params: expect.objectContaining({
        key: "agent:main:dashboard:proof",
        initialHistory: { limit: 80, knownState: {}, maxBytes: 262144, toolResultMaxChars: 2000 },
      }),
    }),
  );
});

function prepareWarmSnapshot(pathname = "/chat/main/warm", savedKey = "agent:main:warm") {
  window.history.replaceState({}, "", pathname);
  const gatewayUrl = loadSettings().gatewayUrl;
  persistSessionToken(gatewayUrl, "test-token");
  saveSettings({ ...loadSettings(), sessionKey: savedKey, lastActiveSessionKey: savedKey });
  const record = makeBootRecord(gatewayCredentialScope(gatewayUrl), {
    recoveryScope: "account-a",
  });
  localStorage.setItem("openclaw.control.bootRecord.v1:" + record.scope, JSON.stringify(record));
  const read = Promise.withResolvers<unknown>();
  vi.spyOn(snapshotDatabase, "readStoredChatSnapshotRecord").mockReturnValue(read.promise);
  const initial = prepareApplicationStartup();
  early = startEarlyApplicationGateway(initial);
  initial.prewarmChatSnapshot();
  if (!early?.credentials) {
    throw new Error("Expected a warm early Gateway");
  }
  const entry = peekPrewarmedChatSnapshot();
  if (!entry) {
    throw new Error("Expected startup to prewarm the scoped snapshot");
  }
  return {
    initial,
    entry,
    transport: early.transport,
    resolve() {
      read.resolve({
        projectionVersion: CHAT_SNAPSHOT_PROJECTION_VERSION,
        savedAt: 1,
        sessionKey: entry.cacheKey,
        sessionId: "warm-session",
        snapshot: {
          messages: [{ role: "assistant", content: "Stored conversation" }],
          pagination: { hasMore: false, completeSnapshot: true },
          sessionId: "warm-session",
          deltaCursor: "warm-cursor",
          historyState: { stateRevision: { commands: "commands-1" }, commands: [] },
        },
      } satisfies SessionSnapshotRecord);
      return entry.ready;
    },
  };
}

async function connectWarmGateway() {
  const socket = getLatestWebSocket();
  socket.emitOpen();
  socket.emitConnectChallenge({ nonce: "warm-early", ts: 1_800_000_000_000 });
  await vi.advanceTimersByTimeAsync(0);
  const connect = JSON.parse(socket.sent[0]!);
  socket.emitMessage({
    type: "res",
    id: connect.id,
    ok: true,
    payload: {
      type: "hello-ok",
      protocol: PROTOCOL_VERSION,
      auth: { method: "token", role: "operator", scopes: [], recoveryScope: "account-a" },
    },
  });
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(0);
  return socket;
}

it.each(["before", "after"])(
  "requests warm cursor history prepared %s hello before mounting the pane",
  async (timing) => {
    const warm = prepareWarmSnapshot();
    if (timing === "before") {
      await warm.resolve();
    }
    expect(getLatestWebSocket().sent).toEqual([]);
    const socket = await connectWarmGateway();
    if (timing === "after") {
      await warm.resolve();
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual(
      expect.objectContaining({
        method: "sessions.messages.subscribe",
        params: expect.objectContaining({
          key: "agent:main:warm",
          initialHistory: {
            limit: 80,
            maxBytes: 262144,
            toolResultMaxChars: 2000,
            cursor: "warm-cursor",
            knownState: { commands: "commands-1" },
          },
        }),
      }),
    );
    expect(runtime).toBeUndefined();
  },
);

it.each(["different route cache", "foreground handoff", "retired recovery scope"])(
  "leaves warm history with the pane after %s",
  async (change) => {
    const warm =
      change === "different route cache"
        ? prepareWarmSnapshot(
            "/dashboard/main/mission-control",
            "agent:main:dashboard:12345678-90ab-4def-8234-567890abcdef",
          )
        : prepareWarmSnapshot();
    const socket = await connectWarmGateway();
    if (change === "foreground handoff") {
      expect(
        warm.transport.adopt({
          url: warm.initial.settings.gatewayUrl,
          token: warm.initial.settings.token,
        }),
      ).toBe(warm.transport.client);
      await expect(
        takeEarlyGatewaySubscription(warm.transport.client, "agent:main:warm", {}),
      ).resolves.toBeNull();
    } else if (change === "retired recovery scope") {
      warm.transport.client.retireOfflineRecoveryScope();
    }
    await warm.resolve();
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent.map((frame) => JSON.parse(frame).method)).toEqual(["connect"]);
  },
);

it("imports New without waiting for the socket to open", async () => {
  await import("../main.ts");
  await vi.dynamicImportSettled();
  expect(mainRuntime.startControlUi).toHaveBeenCalledOnce();
  expect(wsInstances).toHaveLength(1);
  expect(getLatestWebSocket().sent).toEqual([]);
});
