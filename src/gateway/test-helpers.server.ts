import fs from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { WebSocket } from "ws";
import type { GatewayServerOptions } from "./server.js";
import { resolveMainSessionKeyFromConfig, type SessionEntry } from "../config/sessions.js";
import { resetAgentRunContextForTest } from "../infra/agent-events.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { drainSystemEvents, peekSystemEvents } from "../infra/system-events.js";
import { rawDataToString } from "../infra/ws.js";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { DEFAULT_AGENT_ID, toAgentStoreSessionKey } from "../routing/session-key.js";
import { captureEnv } from "../test-utils/env.js";
import { getDeterministicFreePortBlock } from "../test-utils/ports.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../utils/message-channel.js";
import { buildDeviceAuthPayload } from "./device-auth.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import {
  agentCommand,
  cronIsolatedRun,
  embeddedRunMock,
  piSdkMock,
  sessionStoreSaveDelayMs,
  setTestConfigRoot,
  testIsNixMode,
  testTailscaleWhois,
  testState,
  testTailnetIPv4,
} from "./test-helpers.mocks.js";

// Import lazily after test env/home setup so config/session paths resolve to test dirs.
// Keep one cached module per worker for speed.
let serverModulePromise: Promise<typeof import("./server.js")> | undefined;

async function getServerModule() {
  serverModulePromise ??= import("./server.js");
  return await serverModulePromise;
}

let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousStateDir: string | undefined;
let previousConfigPath: string | undefined;
let previousSkipBrowserControl: string | undefined;
let previousSkipGmailWatcher: string | undefined;
let previousSkipCanvasHost: string | undefined;
let previousBundledPluginsDir: string | undefined;
let previousSkipChannels: string | undefined;
let previousSkipProviders: string | undefined;
let previousSkipCron: string | undefined;
let previousMinimalGateway: string | undefined;
let tempHome: string | undefined;
let tempConfigRoot: string | undefined;

export async function writeSessionStore(params: {
  entries: Record<string, Partial<SessionEntry>>;
  storePath?: string;
  agentId?: string;
  mainKey?: string;
}): Promise<void> {
  const storePath = params.storePath ?? testState.sessionStorePath;
  if (!storePath) {
    throw new Error("writeSessionStore requires testState.sessionStorePath");
  }
  const agentId = params.agentId ?? DEFAULT_AGENT_ID;
  const store: Record<string, Partial<SessionEntry>> = {};
  for (const [requestKey, entry] of Object.entries(params.entries)) {
    const rawKey = requestKey.trim();
    const storeKey =
      rawKey === "global" || rawKey === "unknown"
        ? rawKey
        : toAgentStoreSessionKey({
            agentId,
            requestKey,
            mainKey: params.mainKey,
          });
    store[storeKey] = entry;
  }
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
}

async function setupGatewayTestHome() {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousStateDir = process.env.BOT_STATE_DIR;
  previousConfigPath = process.env.BOT_CONFIG_PATH;
  previousSkipBrowserControl = process.env.BOT_SKIP_BROWSER_CONTROL_SERVER;
  previousSkipGmailWatcher = process.env.BOT_SKIP_GMAIL_WATCHER;
  previousSkipCanvasHost = process.env.BOT_SKIP_CANVAS_HOST;
  previousBundledPluginsDir = process.env.BOT_BUNDLED_PLUGINS_DIR;
  previousSkipChannels = process.env.BOT_SKIP_CHANNELS;
  previousSkipProviders = process.env.BOT_SKIP_PROVIDERS;
  previousSkipCron = process.env.BOT_SKIP_CRON;
  previousMinimalGateway = process.env.BOT_TEST_MINIMAL_GATEWAY;
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "bot-gateway-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  await fs.mkdir(path.join(tempHome, ".hanzo/bot"), { recursive: true });
  process.env.BOT_STATE_DIR = path.join(tempHome, ".hanzo/bot");
  delete process.env.BOT_CONFIG_PATH;
}

function applyGatewaySkipEnv() {
  process.env.BOT_SKIP_BROWSER_CONTROL_SERVER = "1";
  process.env.BOT_SKIP_GMAIL_WATCHER = "1";
  process.env.BOT_SKIP_CANVAS_HOST = "1";
  process.env.BOT_SKIP_CHANNELS = "1";
  process.env.BOT_SKIP_PROVIDERS = "1";
  process.env.BOT_SKIP_CRON = "1";
  process.env.BOT_TEST_MINIMAL_GATEWAY = "1";
  process.env.BOT_BUNDLED_PLUGINS_DIR = tempHome
    ? path.join(tempHome, "bot-test-no-bundled-extensions")
    : "bot-test-no-bundled-extensions";
}

async function resetGatewayTestState(options: { uniqueConfigRoot: boolean }) {
  // Some tests intentionally use fake timers; ensure they don't leak into gateway suites.
  vi.useRealTimers();
  setLoggerOverride({ level: "silent", consoleLevel: "silent" });
  if (!tempHome) {
    throw new Error("resetGatewayTestState called before temp home was initialized");
  }
  applyGatewaySkipEnv();
  if (options.uniqueConfigRoot) {
    tempConfigRoot = await fs.mkdtemp(path.join(tempHome, "bot-test-"));
  } else {
    tempConfigRoot = path.join(tempHome, ".bot-test");
    await fs.rm(tempConfigRoot, { recursive: true, force: true });
    await fs.mkdir(tempConfigRoot, { recursive: true });
  }
  setTestConfigRoot(tempConfigRoot);
  sessionStoreSaveDelayMs.value = 0;
  testTailnetIPv4.value = undefined;
  testTailscaleWhois.value = null;
  testState.gatewayBind = undefined;
  testState.gatewayAuth = { mode: "token", token: "test-gateway-token-1234567890" };
  testState.gatewayControlUi = undefined;
  testState.hooksConfig = undefined;
  testState.canvasHostPort = undefined;
  testState.legacyIssues = [];
  testState.legacyParsed = {};
  testState.migrationConfig = null;
  testState.migrationChanges = [];
  testState.cronEnabled = false;
  testState.cronStorePath = undefined;
  testState.sessionConfig = undefined;
  testState.sessionStorePath = undefined;
  testState.agentConfig = undefined;
  testState.agentsConfig = undefined;
  testState.bindingsConfig = undefined;
  testState.channelsConfig = undefined;
  testState.allowFrom = undefined;
  testIsNixMode.value = false;
  cronIsolatedRun.mockClear();
  agentCommand.mockClear();
  embeddedRunMock.activeIds.clear();
  embeddedRunMock.abortCalls = [];
  embeddedRunMock.waitCalls = [];
  embeddedRunMock.waitResults.clear();
  drainSystemEvents(resolveMainSessionKeyFromConfig());
  resetAgentRunContextForTest();
  const mod = await getServerModule();
  mod.__resetModelCatalogCacheForTest();
  piSdkMock.enabled = false;
  piSdkMock.discoverCalls = 0;
  piSdkMock.models = [];
}

async function cleanupGatewayTestHome(options: { restoreEnv: boolean }) {
  vi.useRealTimers();
  resetLogger();
  if (options.restoreEnv) {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    if (previousStateDir === undefined) {
      delete process.env.BOT_STATE_DIR;
    } else {
      process.env.BOT_STATE_DIR = previousStateDir;
    }
    if (previousConfigPath === undefined) {
      delete process.env.BOT_CONFIG_PATH;
    } else {
      process.env.BOT_CONFIG_PATH = previousConfigPath;
    }
    if (previousSkipBrowserControl === undefined) {
      delete process.env.BOT_SKIP_BROWSER_CONTROL_SERVER;
    } else {
      process.env.BOT_SKIP_BROWSER_CONTROL_SERVER = previousSkipBrowserControl;
    }
    if (previousSkipGmailWatcher === undefined) {
      delete process.env.BOT_SKIP_GMAIL_WATCHER;
    } else {
      process.env.BOT_SKIP_GMAIL_WATCHER = previousSkipGmailWatcher;
    }
    if (previousSkipCanvasHost === undefined) {
      delete process.env.BOT_SKIP_CANVAS_HOST;
    } else {
      process.env.BOT_SKIP_CANVAS_HOST = previousSkipCanvasHost;
    }
    if (previousBundledPluginsDir === undefined) {
      delete process.env.BOT_BUNDLED_PLUGINS_DIR;
    } else {
      process.env.BOT_BUNDLED_PLUGINS_DIR = previousBundledPluginsDir;
    }
    if (previousSkipChannels === undefined) {
      delete process.env.BOT_SKIP_CHANNELS;
    } else {
      process.env.BOT_SKIP_CHANNELS = previousSkipChannels;
    }
    if (previousSkipProviders === undefined) {
      delete process.env.BOT_SKIP_PROVIDERS;
    } else {
      process.env.BOT_SKIP_PROVIDERS = previousSkipProviders;
    }
    if (previousSkipCron === undefined) {
      delete process.env.BOT_SKIP_CRON;
    } else {
      process.env.BOT_SKIP_CRON = previousSkipCron;
    }
    if (previousMinimalGateway === undefined) {
      delete process.env.BOT_TEST_MINIMAL_GATEWAY;
    } else {
      process.env.BOT_TEST_MINIMAL_GATEWAY = previousMinimalGateway;
    }
  }
  if (options.restoreEnv && tempHome) {
    await fs.rm(tempHome, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 25,
    });
    tempHome = undefined;
  }
  tempConfigRoot = undefined;
}

export function installGatewayTestHooks(options?: { scope?: "test" | "suite" }) {
  const scope = options?.scope ?? "test";
  if (scope === "suite") {
    beforeAll(async () => {
      await setupGatewayTestHome();
      await resetGatewayTestState({ uniqueConfigRoot: true });
    });
    beforeEach(async () => {
      await resetGatewayTestState({ uniqueConfigRoot: true });
    }, 60_000);
    afterEach(async () => {
      await cleanupGatewayTestHome({ restoreEnv: false });
    });
    afterAll(async () => {
      await cleanupGatewayTestHome({ restoreEnv: true });
    });
    return;
  }

  beforeEach(async () => {
    await setupGatewayTestHome();
    await resetGatewayTestState({ uniqueConfigRoot: false });
  }, 60_000);

  afterEach(async () => {
    await cleanupGatewayTestHome({ restoreEnv: true });
  });
}

export async function getFreePort(): Promise<number> {
  return await getDeterministicFreePortBlock({ offsets: [0, 1, 2, 3, 4] });
}

export async function occupyPort(): Promise<{
  server: ReturnType<typeof createServer>;
  port: number;
}> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port });
    });
  });
}

const CONNECT_CHALLENGE_NONCE_KEY = "__botTestConnectChallengeNonce";
const CONNECT_CHALLENGE_TRACKED_KEY = "__botTestConnectChallengeTracked";
type TrackedWs = WebSocket & Record<string, unknown>;

export function getTrackedConnectChallengeNonce(ws: WebSocket): string | undefined {
  const tracked = (ws as TrackedWs)[CONNECT_CHALLENGE_NONCE_KEY];
  return typeof tracked === "string" && tracked.trim().length > 0 ? tracked.trim() : undefined;
}

/**
 * Wait for the connect challenge nonce to arrive on a tracked WebSocket.
 * Returns the nonce string once available, or undefined after timeout.
 */
export async function readConnectChallengeNonce(
  ws: WebSocket,
  timeoutMs = 2000,
): Promise<string | undefined> {
  trackConnectChallengeNonce(ws);
  const existing = getTrackedConnectChallengeNonce(ws);
  if (existing) {
    return existing;
  }
  return new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => {
      ws.off("message", check);
      resolve(getTrackedConnectChallengeNonce(ws));
    }, timeoutMs);
    const check = () => {
      const nonce = getTrackedConnectChallengeNonce(ws);
      if (nonce) {
        clearTimeout(timer);
        ws.off("message", check);
        resolve(nonce);
      }
    };
    ws.on("message", check);
    // Check immediately in case it arrived between calls.
    check();
  });
}

export function trackConnectChallengeNonce(ws: WebSocket): void {
  const trackedWs = ws as TrackedWs;
  if (trackedWs[CONNECT_CHALLENGE_TRACKED_KEY] === true) {
    return;
  }
  trackedWs[CONNECT_CHALLENGE_TRACKED_KEY] = true;
  ws.on("message", (data) => {
    try {
      const obj = JSON.parse(rawDataToString(data)) as Record<string, unknown>;
      if (obj.type !== "event" || obj.event !== "connect.challenge") {
        return;
      }
      const nonce = (obj.payload as { nonce?: unknown } | undefined)?.nonce;
      if (typeof nonce === "string" && nonce.trim().length > 0) {
        trackedWs[CONNECT_CHALLENGE_NONCE_KEY] = nonce.trim();
      }
    } catch {
      // ignore parse errors in nonce tracker
    }
  });
}

export function onceMessage<T = unknown>(
  ws: WebSocket,
  filter: (obj: unknown) => boolean,
  // Full-suite runs can saturate the event loop (581+ files). Keep this high
  // enough to avoid flaky RPC timeouts, but still fail fast when a response
  // never arrives.
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    const closeHandler = (code: number, reason: Buffer) => {
      clearTimeout(timer);
      ws.off("message", handler);
      reject(new Error(`closed ${code}: ${reason.toString()}`));
    };
    const handler = (data: WebSocket.RawData) => {
      const obj = JSON.parse(rawDataToString(data));
      if (filter(obj)) {
        clearTimeout(timer);
        ws.off("message", handler);
        ws.off("close", closeHandler);
        resolve(obj as T);
      }
    };
    ws.on("message", handler);
    ws.once("close", closeHandler);
  });
}

export async function startGatewayServer(port: number, opts?: GatewayServerOptions) {
  const mod = await getServerModule();
  const resolvedOpts =
    opts?.controlUiEnabled === undefined ? { ...opts, controlUiEnabled: false } : opts;
  return await mod.startGatewayServer(port, resolvedOpts);
}

async function startGatewayServerWithRetries(params: {
  port: number;
  opts?: GatewayServerOptions;
}): Promise<{ port: number; server: Awaited<ReturnType<typeof startGatewayServer>> }> {
  let port = params.port;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return {
        port,
        server: await startGatewayServer(port, params.opts),
      };
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code;
      if (code !== "EADDRINUSE") {
        throw err;
      }
      port = await getFreePort();
    }
  }
  throw new Error("failed to start gateway server after retries");
}

export async function withGatewayServer<T>(
  fn: (ctx: { port: number; server: Awaited<ReturnType<typeof startGatewayServer>> }) => Promise<T>,
  opts?: { port?: number; serverOptions?: GatewayServerOptions },
): Promise<T> {
  const started = await startGatewayServerWithRetries({
    port: opts?.port ?? (await getFreePort()),
    opts: opts?.serverOptions,
  });
  try {
    return await fn({ port: started.port, server: started.server });
  } finally {
    await started.server.close();
  }
}

export async function startServerWithClient(
  token?: string,
  opts?: GatewayServerOptions & { wsHeaders?: Record<string, string> },
) {
  const { wsHeaders, ...gatewayOpts } = opts ?? {};
  let port = await getFreePort();
  const envSnapshot = captureEnv(["BOT_GATEWAY_TOKEN"]);
  const prev = process.env.BOT_GATEWAY_TOKEN;
  if (typeof token === "string") {
    testState.gatewayAuth = { mode: "token", token };
  }
  const fallbackToken =
    token ??
    (typeof (testState.gatewayAuth as { token?: unknown } | undefined)?.token === "string"
      ? (testState.gatewayAuth as { token?: string }).token
      : undefined);
  if (fallbackToken === undefined) {
    delete process.env.BOT_GATEWAY_TOKEN;
  } else {
    process.env.BOT_GATEWAY_TOKEN = fallbackToken;
  }

  const started = await startGatewayServerWithRetries({ port, opts: gatewayOpts });
  port = started.port;
  const server = started.server;

  const ws = new WebSocket(
    `ws://127.0.0.1:${port}`,
    wsHeaders ? { headers: wsHeaders } : undefined,
  );
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for ws open")), 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`closed ${code}: ${reason.toString()}`));
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
  return { server, ws, port, prevToken: prev, envSnapshot };
}

type ConnectResponse = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message?: string };
};

export async function connectReq(
  ws: WebSocket,
  opts?: {
    token?: string;
    password?: string;
    skipDefaultAuth?: boolean;
    minProtocol?: number;
    maxProtocol?: number;
    client?: {
      id: string;
      displayName?: string;
      version: string;
      platform: string;
      mode: string;
      deviceFamily?: string;
      modelIdentifier?: string;
      instanceId?: string;
    };
    role?: string;
    scopes?: string[];
    caps?: string[];
    commands?: string[];
    permissions?: Record<string, boolean>;
    device?: {
      id: string;
      publicKey: string;
      signature: string;
      signedAt: number;
      nonce?: string;
    } | null;
  },
): Promise<ConnectResponse> {
  // Ensure challenge nonce tracking is active before we need it.
  trackConnectChallengeNonce(ws);

  // Wait briefly for the challenge nonce to arrive (server sends it on open).
  if (!getTrackedConnectChallengeNonce(ws)) {
    await new Promise<void>((resolve) => {
      const check = () => {
        if (getTrackedConnectChallengeNonce(ws)) {
          clearTimeout(timer);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        ws.off("message", check);
        resolve(); // proceed without nonce — tests that don't need device auth
      }, 500);
      ws.on("message", check);
      // Check immediately in case it already arrived.
      check();
    });
  }

  const { randomUUID } = await import("node:crypto");
  const id = randomUUID();
  const client = opts?.client ?? {
    id: GATEWAY_CLIENT_NAMES.TEST,
    version: "1.0.0",
    platform: "test",
    mode: GATEWAY_CLIENT_MODES.TEST,
  };
  const role = opts?.role ?? "operator";
  const defaultToken =
    opts?.skipDefaultAuth === true
      ? undefined
      : typeof (testState.gatewayAuth as { token?: unknown } | undefined)?.token === "string"
        ? ((testState.gatewayAuth as { token?: string }).token ?? undefined)
        : process.env.BOT_GATEWAY_TOKEN;
  const defaultPassword =
    opts?.skipDefaultAuth === true
      ? undefined
      : typeof (testState.gatewayAuth as { password?: unknown } | undefined)?.password === "string"
        ? ((testState.gatewayAuth as { password?: string }).password ?? undefined)
        : process.env.BOT_GATEWAY_PASSWORD;
  const token = opts?.token ?? defaultToken;
  const password = opts?.password ?? defaultPassword;
  const requestedScopes = Array.isArray(opts?.scopes)
    ? opts.scopes
    : role === "operator"
      ? ["operator.admin"]
      : [];
  const device = (() => {
    if (opts?.device === null) {
      return undefined;
    }
    if (opts?.device) {
      return opts.device;
    }
    const identity = loadOrCreateDeviceIdentity();
    const signedAtMs = Date.now();
    const nonce = getTrackedConnectChallengeNonce(ws) ?? "";
    const payload = buildDeviceAuthPayload({
      deviceId: identity.deviceId,
      clientId: client.id,
      clientMode: client.mode,
      role,
      scopes: requestedScopes,
      signedAtMs,
      token: token ?? null,
      nonce,
    });
    return {
      id: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      signature: signDevicePayload(identity.privateKeyPem, payload),
      signedAt: signedAtMs,
      nonce: nonce || undefined,
    };
  })();
  ws.send(
    JSON.stringify({
      type: "req",
      id,
      method: "connect",
      params: {
        minProtocol: opts?.minProtocol ?? PROTOCOL_VERSION,
        maxProtocol: opts?.maxProtocol ?? PROTOCOL_VERSION,
        client,
        caps: opts?.caps ?? [],
        commands: opts?.commands ?? [],
        permissions: opts?.permissions ?? undefined,
        role,
        scopes: requestedScopes,
        auth:
          token || password
            ? {
                token,
                password,
              }
            : undefined,
        device,
      },
    }),
  );
  const isResponseForId = (o: unknown): boolean => {
    if (!o || typeof o !== "object" || Array.isArray(o)) {
      return false;
    }
    const rec = o as Record<string, unknown>;
    return rec.type === "res" && rec.id === id;
  };
  return await onceMessage<ConnectResponse>(ws, isResponseForId);
}

export async function connectOk(ws: WebSocket, opts?: Parameters<typeof connectReq>[1]) {
  const res = await connectReq(ws, opts);
  expect(res.ok).toBe(true);
  expect((res.payload as { type?: unknown } | undefined)?.type).toBe("hello-ok");
  return res.payload as { type: "hello-ok" };
}

export async function rpcReq<T = unknown>(
  ws: WebSocket,
  method: string,
  params?: unknown,
  timeoutMs?: number,
) {
  const { randomUUID } = await import("node:crypto");
  const id = randomUUID();
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return await onceMessage<{
    type: "res";
    id: string;
    ok: boolean;
    payload?: T;
    error?: { message?: string; code?: string };
  }>(
    ws,
    (o) => {
      if (!o || typeof o !== "object" || Array.isArray(o)) {
        return false;
      }
      const rec = o as Record<string, unknown>;
      return rec.type === "res" && rec.id === id;
    },
    timeoutMs,
  );
}

export async function waitForSystemEvent(timeoutMs = 2000) {
  const sessionKey = resolveMainSessionKeyFromConfig();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = peekSystemEvents(sessionKey);
    if (events.length > 0) {
      return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout waiting for system event");
}

/**
 * Convenience wrapper: starts a gateway server + connected client and
 * immediately performs `connectOk`. Returns the same shape as
 * `startServerWithClient` plus the resolved port.
 */
export async function startConnectedServerWithClient(
  token?: string,
  opts?: Parameters<typeof startServerWithClient>[1],
) {
  const started = await startServerWithClient(token, opts);
  await connectOk(started.ws);
  return started;
}

/**
 * Opens a webchat WebSocket client, tracks the nonce, waits for open,
 * and performs `connectOk` with webchat client info.
 */
export async function connectWebchatClient(params: { port: number }): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${params.port}`, {
    headers: { origin: `http://127.0.0.1:${params.port}` },
  });
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  await connectOk(ws, {
    client: {
      id: GATEWAY_CLIENT_NAMES.WEBCHAT,
      version: "1.0.0",
      platform: "test",
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    },
  });
  return ws;
}
