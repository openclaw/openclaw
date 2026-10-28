import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { getEnvironmentData } from "node:worker_threads";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { expect, test } from "vitest";
import { WebSocket } from "ws";
import { startQaMockOpenAiServer } from "../extensions/qa-lab/api.js";
import { PROTOCOL_VERSION } from "../packages/gateway-protocol/src/index.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const postgres = typeof configured === "string" ? configured : undefined;
const email = "creation-proof@example.invalid";
const origin = "https://creation.example.invalid";

type Response = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: unknown;
};
async function connect(url: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const ws = new WebSocket(url, {
    origin,
    headers: {
      "x-forwarded-user": email,
      "x-forwarded-for": "203.0.113.42",
      "x-forwarded-proto": "https",
    },
  });
  const cancel = () => ws.close();
  signal.addEventListener("abort", cancel, { once: true });
  ws.once("close", () => signal.removeEventListener("abort", cancel));
  const pending = new Map<
    string,
    { resolve: (value: Response) => void; reject: (error: Error) => void }
  >();
  ws.on("message", (raw) => {
    const message = JSON.parse(rawDataToString(raw));
    if (message.type === "res") {
      pending.get(message.id)?.resolve(message);
      pending.delete(message.id);
    }
  });
  ws.on("close", () => {
    for (const request of pending.values()) {
      request.reject(new Error("proof client closed"));
    }
    pending.clear();
  });
  const request = (method: string, params: Record<string, unknown>) => {
    const id = randomUUID();
    const response = new Promise<Response>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
    return response;
  };
  await once(ws, "open", { signal });
  const hello = await request("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: { id: "openclaw-control-ui", mode: "webchat", version: "test", platform: "web" },
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
  });
  expect(hello.ok, JSON.stringify(hello.error)).toBe(true);
  return {
    request,
    close: async () => {
      if (ws.readyState === WebSocket.CLOSED) {
        return;
      }
      const closed = once(ws, "close");
      ws.close();
      await closed;
    },
  };
}

for (const engine of ["sqlite", "postgres"] as const) {
  test.skipIf(engine === "postgres" && !postgres)(
    engine + " reconciles creation across a cold Gateway restart and accepts a separate turn",
    async ({ signal }) => {
      const model = await startQaMockOpenAiServer({ modelRefs: ["creation-proof/creation-proof"] });
      const { config: provider } = buildMockOpenAiResponsesProvider(
        model.baseUrl + "/v1",
        "creation-proof",
      );
      provider.apiKey = "synthetic-creation-proof";
      provider.request = { allowPrivateNetwork: true };
      const instance = await createOpenClawTestInstance({
        name: "creation-restart-" + engine,
        // This fixture authenticates through the proxy, never a shared bearer token.
        gatewayToken: "",
        env: {
          NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(","),
          no_proxy: [process.env.no_proxy, "127.0.0.1", "localhost"].filter(Boolean).join(","),
        },
        signal,
        config: {
          ...(engine === "postgres"
            ? {
                database: {
                  engine: "postgres",
                  postgres: { connection: postgres, schemaPrefix: "creation_wire" },
                },
              }
            : {}),
          gateway: {
            trustedProxies: ["127.0.0.1"],
            controlUi: { enabled: false, allowedOrigins: [origin] },
            auth: {
              mode: "trusted-proxy",
              identityScopes: { [email]: ["operator.admin"] },
              trustedProxy: {
                userHeader: "x-forwarded-user",
                requiredHeaders: ["x-forwarded-proto"],
                allowLoopback: true,
                allowUsers: [email],
              },
            },
          },
          agents: {
            ownership: "explicit",
            entries: { main: {} },
            defaults: {
              systemAgent: { agentId: "main" },
              sessionStore: { agentId: "main" },
              model: { primary: "creation-proof/creation-proof" },
              modelPolicy: { allow: ["creation-proof/creation-proof"] },
              models: { "creation-proof/creation-proof": { agentRuntime: { id: "openclaw" } } },
              skipBootstrap: true,
              skills: [],
            },
          },
          models: { mode: "merge", providers: { "creation-proof": provider } },
          plugins: { slots: { memory: "none" } },
          tools: { profile: "minimal" },
        },
      });
      let client: Awaited<ReturnType<typeof connect>> | undefined;
      await runQaGatewayFixture(
        async () => {
          await instance.startGateway();
          const oldPid = instance.child?.pid;
          client = await connect(instance.url, signal);
          const now = Date.now();
          const stamp = now.toString(16).padStart(12, "0");
          const sessionId =
            stamp.slice(0, 8) +
            "-" +
            stamp.slice(8) +
            "-7000-8000-" +
            randomUUID().replaceAll("-", "").slice(-12);
          const params = {
            agentId: "main",
            sessionId,
            creationOperationId: "v1:" + now + ":" + randomUUID().replaceAll("-", ""),
          };
          const key = "agent:main:dashboard:" + sessionId;
          // Discard the successful acknowledgment: recovery must use persisted intent,
          // never the client's prior payload or the first process's replay cache.
          const first = await Promise.all([
            client.request("sessions.create", params),
            client.request("sessions.create", params),
          ]);
          for (const reply of first) {
            expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
            expect(reply.payload).toMatchObject({ sessionId, key, runStarted: false });
          }
          expect(new Set(first.map((reply) => reply.payload?.creationReplayed))).toEqual(
            new Set([false, true]),
          );
          await client.close();
          client = undefined;
          await instance.stopGateway();
          await instance.startGateway();
          expect(instance.child?.pid).not.toBe(oldPid);
          client = await connect(instance.url, signal);
          const replay = await client.request("sessions.create", params);
          expect(replay.ok, JSON.stringify(replay.error)).toBe(true);
          expect(replay.payload).toMatchObject({
            sessionId,
            key,
            runStarted: false,
            creationReplayed: true,
          });
          const before = await client.request("chat.history", { sessionKey: key });
          expect(before.ok, JSON.stringify(before.error)).toBe(true);
          expect(before.payload?.messages).toEqual([]);
          const turn = await client.request("chat.send", {
            sessionKey: key,
            message: "Reply with a short creation proof acknowledgment.",
            idempotencyKey: "separate-creation-turn",
          });
          expect(turn.ok, JSON.stringify(turn.error)).toBe(true);
          const runId = turn.payload?.runId;
          expect(typeof runId).toBe("string");
          const settled = await client.request("agent.wait", { runId, timeoutMs: 30000 });
          expect(settled.ok, JSON.stringify(settled.error)).toBe(true);
          expect(
            settled.payload?.status,
            JSON.stringify(settled.payload) + "\n" + instance.logs().slice(-8000),
          ).toBe("ok");
          const history = await client.request("chat.history", { sessionKey: key });
          expect(history.ok, JSON.stringify(history.error)).toBe(true);
          expect(JSON.stringify(history.payload?.messages)).toContain(
            "creation proof acknowledgment",
          );
          expect(history.payload?.messages).toEqual(
            expect.arrayContaining([expect.objectContaining({ role: "assistant" })]),
          );
          const deleted = await client.request("sessions.delete", { key });
          expect(deleted.ok, JSON.stringify(deleted.error)).toBe(true);
          expect(await client.request("sessions.create", params)).toMatchObject({ ok: false });
        },
        () => client?.close(),
        () => instance.cleanup(),
        () => model.stop(),
      );
    },
  );
}
