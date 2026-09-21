// Minimal Gateway websocket test helpers.
// Provides small fake-server frames plus an isolated real-Gateway boundary harness.
import fs from "node:fs";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { WebSocket, type WebSocketServer } from "ws";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.js";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import type { OpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { stateDirGatewayFixtureEntrypoint } from "../cli/cli-entrypoint.test-support.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { toAgentRequestSessionKey } from "../routing/session-key.js";

type MinimalGatewayRequestFrame = {
  type?: string;
  id?: string;
  method?: string;
  params?: Record<string, unknown> & {
    auth?: { token?: string };
    device?: { nonce?: string };
  };
};

/** Parses a raw WebSocket frame into the small request shape used by tests. */
export function parseMinimalGatewayRequestFrame(
  data: WebSocket.RawData,
): MinimalGatewayRequestFrame {
  return JSON.parse(rawDataToString(data)) as MinimalGatewayRequestFrame;
}

/** Sends the connect challenge event expected by minimal gateway clients. */
export function sendMinimalGatewayConnectChallenge(ws: WebSocket, nonce = "test-nonce"): void {
  ws.send(
    JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce, ts: Date.now() },
    }),
  );
}

/** Builds a minimal hello-ok payload for fake gateway servers. */
export function buildMinimalGatewayHelloOkPayload(params?: {
  connId?: string;
  methods?: string[];
  snapshot?: Record<string, unknown>;
  auth?: { role: string; scopes: string[]; deviceToken?: string };
  policy?: {
    maxPayload: number;
    maxBufferedBytes: number;
    tickIntervalMs: number;
  };
}) {
  return {
    type: "hello-ok",
    protocol: PROTOCOL_VERSION,
    server: { version: "test", connId: params?.connId ?? "conn-test" },
    features: { methods: params?.methods ?? [], events: ["connect.challenge"] },
    snapshot: params?.snapshot ?? {},
    ...(params?.auth ? { auth: params.auth } : {}),
    policy: params?.policy ?? {
      maxPayload: 1_000_000,
      maxBufferedBytes: 1_000_000,
      tickIntervalMs: 60_000,
    },
  };
}

/** Sends a successful response frame from a fake gateway server. */
export function sendMinimalGatewayResponse(ws: WebSocket, id: string, payload: unknown): void {
  ws.send(JSON.stringify({ type: "res", id, ok: true, payload }));
}

/** Terminates all clients and closes a fake WebSocket gateway server. */
export async function closeMinimalGatewayServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.terminate();
  }
  await new Promise<void>((resolve, reject) => {
    wss.close((error) => (error ? reject(error) : resolve()));
  });
}

type MinimalGatewaySession = {
  agentId: string;
  key: string;
  visibility?: import("../config/sessions.js").SessionEntry["visibility"];
};

type MinimalGatewayObservation = {
  method: "sessions.list" | "sessions.resolve";
  params: Record<string, unknown>;
};

export async function startMinimalRealGateway(options: {
  sessions?: MinimalGatewaySession[];
  signal?: AbortSignal;
  registerCleanup: (cleanup: () => Promise<void>) => unknown;
}) {
  const lifetime = createFixtureLifetime();
  const cancellation = new AbortController();
  const abort = () => cancellation.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) {
    abort();
  }
  const clients: WebSocket[] = [];
  const dropConnections = () => clients.forEach((client) => client.terminate());
  let instance: OpenClawTestInstance | undefined;
  let startupSettled: Promise<void> = Promise.resolve();
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) {
      return closing;
    }
    cancellation.abort(new Error("Minimal Gateway fixture is closing"));
    closing = (async () => {
      const cleanup = lifetime.verifyCleanup(async () => {
        await startupSettled;
        dropConnections();
        await instance?.cleanup();
      });
      try {
        await runQaGatewayFixture(
          () => cleanup,
          () => lifetime.cleanup(),
        );
      } finally {
        options.signal?.removeEventListener("abort", abort);
      }
    })();
    return closing;
  };
  // Cancellation can finish the test wrapper before acquisition returns a handle.
  options.registerCleanup(close);
  const startup = lifetime.run(async () => {
    cancellation.signal.throwIfAborted();
    const { createOpenClawTestInstance } =
      await import("../../test/helpers/openclaw-test-instance.js");
    const entrypoint = resolveRuntimeWorkerUrl(stateDirGatewayFixtureEntrypoint);
    const gateway = await createOpenClawTestInstance({
      name: "minimal-real-gateway",
      entrypoint: [...resolveRuntimeWorkerArgv(entrypoint), "--minimal-real-gateway"],
      gatewayCommandPrefix: [process.execPath],
      gatewayToken: "minimal-real-gateway-token",
      signal: cancellation.signal,
      verifyCleanup: lifetime.verifyCleanup,
      config: { hooks: { enabled: false } },
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    instance = gateway;
    gateway.state.applyEnv();
    const requestLog = gateway.state.path("gateway-requests.jsonl");
    fs.writeFileSync(requestLog, "");
    gateway.env.OPENCLAW_GATEWAY_PORT = String(gateway.port);
    gateway.env.OPENCLAW_TEST_GATEWAY_TOKEN = gateway.gatewayToken;
    gateway.env.OPENCLAW_TEST_GATEWAY_REQUEST_LOG = requestLog;
    const sessions = options.sessions ?? [];
    if (sessions.length > 0) {
      const { upsertSessionEntryCore } =
        await import("../config/sessions/session-accessor.sqlite-entry.js");
      for (const session of sessions) {
        cancellation.signal.throwIfAborted();
        await upsertSessionEntryCore(
          {
            agentId: session.agentId,
            sessionKey: toAgentRequestSessionKey(session.key)!,
            storePath: path.join(gateway.state.agentDir(session.agentId), "openclaw-agent.sqlite"),
          },
          { sessionId: session.key, updatedAt: Date.now(), visibility: session.visibility },
        );
      }
    }
    await gateway.startGateway();
    const readRequests = (method: MinimalGatewayObservation["method"]) =>
      fs
        .readFileSync(requestLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          // This synthetic test log is emitted by the prepared fixture before the real RPC returns.
          const observation: unknown = JSON.parse(line);
          if (
            !isRecord(observation) ||
            (observation.method !== "sessions.list" && observation.method !== "sessions.resolve") ||
            !isRecord(observation.params)
          ) {
            throw new Error("Invalid synthetic Gateway request observation");
          }
          return observation.method === method ? [observation.params] : [];
        });
    const issueNodeBootstrapToken = () =>
      lifetime.run(async () => {
        cancellation.signal.throwIfAborted();
        const [bootstrap, profiles] = await Promise.all([
          import("../infra/device-bootstrap.js"),
          import("../shared/device-bootstrap-profile.js"),
        ]);
        cancellation.signal.throwIfAborted();
        return (
          await bootstrap.issueDeviceBootstrapToken({
            baseDir: gateway.stateDir,
            profile: profiles.NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
          })
        ).token;
      });
    const hellos: unknown[] = [];
    const connectFailures: unknown[] = [];
    return {
      url: gateway.url,
      token: gateway.gatewayToken,
      get sessionListRequests() {
        return readRequests("sessions.list");
      },
      get sessionResolveRequests() {
        return readRequests("sessions.resolve");
      },
      hellos,
      connectFailures,
      issueNodeBootstrapToken,
      createDeviceIdentity: (label: string) =>
        lifetime.run(async () => {
          cancellation.signal.throwIfAborted();
          const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
          cancellation.signal.throwIfAborted();
          return loadOrCreateDeviceIdentity({
            path: gateway.state.statePath(`device-${label}.sqlite`),
          });
        }),
      restart: () =>
        lifetime.run(async () => {
          cancellation.signal.throwIfAborted();
          await gateway.stopGateway();
          cancellation.signal.throwIfAborted();
          await gateway.startGateway();
        }),
      connectBootstrap: (mismatched = false) =>
        lifetime.run(async () => {
          const helpers = await import("./test-helpers.js");
          const bootstrapToken = await issueNodeBootstrapToken();
          cancellation.signal.throwIfAborted();
          const ws = new WebSocket(gateway.url);
          clients.push(ws);
          helpers.trackConnectChallengeNonce(ws);
          const response = await helpers.connectReq(ws, {
            bootstrapToken,
            ...(mismatched ? { deviceToken: "mismatched-device-token" } : {}),
            skipDefaultAuth: true,
            role: "node",
            scopes: [],
            client: { id: "node-host", version: "test", platform: "test", mode: "node" },
            deviceIdentityPath: gateway.state.statePath(
              `device-${mismatched ? "bad" : "ok"}.sqlite`,
            ),
            timeoutMs: 2_000,
          });
          (response.ok ? hellos : connectFailures).push(
            response.ok ? response.payload : response.error,
          );
          return response;
        }),
      dropConnections,
      close,
    };
  });
  startupSettled = startup.then(
    () => undefined,
    () => undefined,
  );
  return await startup;
}
