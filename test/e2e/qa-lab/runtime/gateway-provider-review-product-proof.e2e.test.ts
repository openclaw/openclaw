import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { buildDeviceAuthPayloadV3 } from "../../../../packages/gateway-client/src/device-auth.js";
import { rawDataToString } from "../../../../packages/gateway-client/src/websocket-data.js";
import type { ResponseFrame } from "../../../../packages/gateway-protocol/src/schema/frames.js";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/version.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../../../../src/infra/device-identity.js";
import { acquireTestPortBlock } from "../../../../src/test-utils/port-claims.js";
import { VERSION } from "../../../../src/version.js";
import {
  acquireGatewayTestWebSocket,
  closeGatewayTestWebSocket,
} from "../../../helpers/gateway-websocket.js";
import { writeOpenAiResponsesSse } from "../../../helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import { createDeferred } from "../../../helpers/promise.js";
import { runQaGatewayTestFixture } from "../../../helpers/qa-gateway-test-lifetime.js";

const MODEL = "openai/gpt-5.6-sol";
const ORIGIN = "https://control.example.test";
const ALLOWED_STEER = "  CONTINUE_ALLOWED e\u0301\n ";
const REVOKED_STEER = "  CONTINUE_REVOKE e\u0301\n ";
const SEED_ALLOWED = "Seed the allowed review.";
const SEED_REVOKED = "Seed the revoked review.";
const WRITER_SCOPES = ["operator.read", "operator.write"];

type ProviderRequest = {
  input: Array<{ role?: string; content?: string | Array<{ text?: string }> }>;
  client_metadata?: Record<string, string>;
};
type SessionDescription = {
  session: {
    sessionId: string;
    sharingRole: string;
    visibility: string;
    providerReview?: {
      id: string;
      runId: string;
      continuationMessage?: string;
      canContinue: boolean;
    };
  };
};

function userTexts(body: ProviderRequest): string[] {
  return body.input
    .filter((item) => item.role === "user")
    .map((item) =>
      typeof item.content === "string"
        ? item.content
        : (item.content ?? []).map((part) => part.text ?? "").join(""),
    );
}

async function connectOperator(gateway: OpenClawTestInstance, email: string, signal: AbortSignal) {
  const identity = loadOrCreateDeviceIdentity({
    path: gateway.state.statePath("proof-identities", `${email}.sqlite`),
  });
  const socket = new WebSocket(gateway.url, {
    headers: {
      origin: ORIGIN,
      "x-forwarded-user": email,
      "x-forwarded-proto": "https",
      "x-forwarded-for": "198.51.100.40",
    },
  });
  const challenge = createDeferred<string>();
  // Acquisition owns failures that can arrive before the socket opens.
  void challenge.promise.catch(() => {});
  const pending = new Map<string, ReturnType<typeof createDeferred<ResponseFrame>>>();
  const fail = (error: Error) => {
    challenge.reject(error);
    for (const result of pending.values()) {
      result.reject(error);
    }
    pending.clear();
  };
  const abort = () => fail(new Error("Provider review fixture canceled"));
  signal.addEventListener("abort", abort, { once: true });
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("Provider review Gateway connection closed")));
  socket.on("message", (data) => {
    const frame = JSON.parse(rawDataToString(data)) as
      | ResponseFrame
      | { type: "event"; event: string; payload?: { nonce?: string } };
    if (frame.type === "event" && frame.event === "connect.challenge" && frame.payload?.nonce) {
      challenge.resolve(frame.payload.nonce);
    } else if (frame.type === "res") {
      pending.get(frame.id)?.resolve(frame);
      pending.delete(frame.id);
    }
  });
  const request = async (method: string, params: unknown): Promise<ResponseFrame> => {
    signal.throwIfAborted();
    const id = randomUUID();
    const result = createDeferred<ResponseFrame>();
    pending.set(id, result);
    socket.send(JSON.stringify({ type: "req", id, method, params }));
    return result.promise;
  };
  const call = async (method: string, params: unknown): Promise<unknown> => {
    const result = await request(method, params);
    if (!result.ok) {
      throw new Error(`${method}: ${JSON.stringify(result.error)}`);
    }
    return result.payload;
  };
  const close = async () => {
    signal.removeEventListener("abort", abort);
    await closeGatewayTestWebSocket(socket);
  };
  try {
    const noncePromise = challenge.promise;
    let scopes: string[] = [];
    await acquireGatewayTestWebSocket(socket, 30_000, async () => {
      const nonce = await noncePromise;
      const signedAt = Date.now();
      const client = {
        id: "openclaw-control-ui" as const,
        version: VERSION,
        platform: "web",
        mode: "webchat" as const,
      };
      const signature = buildDeviceAuthPayloadV3({
        deviceId: identity.deviceId,
        clientId: client.id,
        clientMode: client.mode,
        platform: client.platform,
        role: "operator",
        scopes: WRITER_SCOPES,
        token: null,
        nonce,
        signedAtMs: signedAt,
      });
      const hello = (await call("connect", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client,
        role: "operator",
        scopes: WRITER_SCOPES,
        device: {
          id: identity.deviceId,
          publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
          signature: signDevicePayload(identity.privateKeyPem, signature),
          signedAt,
          nonce,
        },
      })) as { auth: { scopes: string[] } };
      scopes = hello.auth.scopes;
    });
    return { deviceId: identity.deviceId, scopes, call, request, close };
  } catch (error) {
    await close();
    throw error;
  }
}

describe("Gateway provider review product proof", () => {
  it("dispatches the exact acknowledged steer and preserves session and device authority", async (context) => {
    const requests: ProviderRequest[] = [];
    const startedAt = Date.now();
    const mark = (phase: string) =>
      console.log(
        "[provider-review-proof]",
        JSON.stringify({ phase, elapsedMs: Date.now() - startedAt, requests: requests.length }),
      );
    mark("start");
    const barrierEntered = createDeferred();
    const releaseBarrier = createDeferred();
    const cancelBarrier = () => barrierEntered.resolve();
    context.signal.addEventListener("abort", cancelBarrier, { once: true });
    let gateway: OpenClawTestInstance | undefined;
    let portClaim: Awaited<ReturnType<typeof acquireTestPortBlock>> | undefined;
    const clients: Awaited<ReturnType<typeof connectOperator>>[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        if (request.url === "/barrier") {
          barrierEntered.resolve();
          await releaseBarrier.promise;
          response.writeHead(204).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const compressed = Buffer.concat(chunks);
        const bytes =
          request.headers["content-encoding"] === "zstd"
            ? zstdDecompressSync(compressed)
            : compressed;
        const body = JSON.parse(bytes.toString()) as ProviderRequest;
        requests.push(body);
        const text = userTexts(body).at(-1) ?? "";
        if (text.includes(SEED_ALLOWED) || text.includes(SEED_REVOKED)) {
          response.writeHead(403, { "content-type": "application/json" }).end(
            JSON.stringify({
              error: {
                code: "misalignment_policy_violation",
                type: "invalid_request_error",
                message: "Synthetic provider pause.",
                misalignment: {
                  detailed_explanation: "Synthetic review findings.",
                  steer: {
                    message: text.includes(SEED_REVOKED) ? REVOKED_STEER : ALLOWED_STEER,
                  },
                },
              },
            }),
          );
          return;
        }
        writeAcceptedResponse(response);
      })().catch((error: unknown) => {
        response.writeHead(500).end(String(error));
      });
    });
    context.onTestFailed(() => console.error(gateway?.logs()));
    await runQaGatewayTestFixture(
      context,
      async ({ signal, verifyCleanup, createTempDir }) => {
        portClaim = await acquireTestPortBlock({ offsets: [0], signal });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(portClaim!.port, "127.0.0.1", resolve);
        });
        const baseUrl = `http://127.0.0.1:${portClaim.port}`;
        const pluginDir = createTempDir("openclaw-provider-review-proof-");
        await fs.writeFile(
          path.join(pluginDir, "package.json"),
          JSON.stringify({
            name: "provider-review-proof",
            openclaw: { extensions: ["./index.cjs"] },
          }),
        );
        await fs.writeFile(
          path.join(pluginDir, "openclaw.plugin.json"),
          JSON.stringify({
            id: "provider-review-proof",
            configSchema: {
              type: "object",
              properties: { barrierUrl: { type: "string" } },
              additionalProperties: false,
            },
          }),
        );
        await fs.writeFile(
          path.join(pluginDir, "index.cjs"),
          `module.exports = {
            id: "provider-review-proof",
            register(api) {
              api.on("before_prompt_build", async (event) => {
                if (event.prompt.includes("CONTINUE_REVOKE")) {
                  await fetch(api.pluginConfig.barrierUrl);
                }
              });
            }
          };`,
        );
        gateway = await createOpenClawTestInstance({
          name: "provider-review-product-proof",
          signal,
          verifyCleanup,
          env: {
            OPENCLAW_SKIP_PROVIDERS: undefined,
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
            OPENAI_API_KEY: undefined,
            CODEX_HOME: undefined,
          },
          config: {
            gateway: {
              mode: "local",
              bind: "loopback",
              trustedProxies: ["127.0.0.1", "::1"],
              auth: {
                mode: "trusted-proxy",
                token: undefined,
                identityScopes: { "admin@example.test": ["operator.admin"] },
                trustedProxy: {
                  userHeader: "x-forwarded-user",
                  requiredHeaders: ["x-forwarded-proto"],
                  allowLoopback: true,
                  deviceAutoApprove: { enabled: true, scopes: WRITER_SCOPES },
                },
              },
              controlUi: { enabled: false, allowedOrigins: [ORIGIN] },
            },
            agents: {
              defaults: {
                model: { primary: MODEL, fallbacks: [] },
                models: {
                  [MODEL]: {
                    agentRuntime: { id: "openclaw" },
                    params: { transport: "sse", openaiWsWarmup: false },
                  },
                },
                utilityModel: "",
                workspace: "~/workspace",
                skipBootstrap: true,
                sandbox: { mode: "off" },
              },
            },
            tools: { deny: ["*"] },
            models: {
              mode: "replace",
              providers: {
                openai: {
                  baseUrl: `${baseUrl}/backend-api/codex`,
                  api: "openai-chatgpt-responses",
                  auth: "oauth",
                  request: { allowPrivateNetwork: true },
                  models: [
                    {
                      id: "gpt-5.6-sol",
                      name: "Synthetic review model",
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 128_000,
                      maxTokens: 1024,
                    },
                  ],
                },
              },
            },
            plugins: {
              enabled: true,
              allow: ["openai", "provider-review-proof"],
              load: { paths: [pluginDir] },
              slots: { memory: "none" },
              entries: {
                openai: { enabled: true },
                "provider-review-proof": {
                  enabled: true,
                  hooks: { allowConversationAccess: true },
                  config: { barrierUrl: `${baseUrl}/barrier` },
                },
              },
            },
          },
        });
        const childEnvKeys = new Set([
          ...Object.keys(gateway.state.envVars),
          "PATH",
          "Path",
          "SystemRoot",
          "SYSTEMROOT",
          "WINDIR",
          "ComSpec",
          "COMSPEC",
          "PATHEXT",
          "TMPDIR",
          "TMP",
          "TEMP",
          "LANG",
          "LC_ALL",
          "OPENCLAW_GATEWAY_TOKEN",
          "OPENCLAW_GATEWAY_PASSWORD",
          "OPENCLAW_GATEWAY_PORT",
          "OPENCLAW_GATEWAY_URL",
          "OPENCLAW_SKIP_CHANNELS",
          "OPENCLAW_SKIP_GMAIL_WATCHER",
          "OPENCLAW_SKIP_CRON",
          "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
          "OPENCLAW_SKIP_CANVAS_HOST",
          "OPENCLAW_TEST_MINIMAL_GATEWAY",
          "OPENCLAW_AGENT_HARNESS_FALLBACK",
          "VITEST",
        ]);
        for (const key of Object.keys(gateway.env)) {
          if (!childEnvKeys.has(key)) {
            delete gateway.env[key];
          }
        }
        const expires = Date.UTC(2036, 0, 1);
        const access = [
          { alg: "none" },
          {
            "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-review-account" },
            exp: Math.floor(expires / 1000),
          },
        ]
          .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
          .concat("synthetic")
          .join(".");
        await gateway.state.writeAuthProfiles({
          version: 1,
          profiles: {
            "openai:review-proof": {
              type: "oauth",
              provider: "openai",
              access,
              refresh: "synthetic-refresh",
              expires,
              accountId: "synthetic-review-account",
            },
          },
          order: { openai: ["openai:review-proof"] },
        });
        mark("gateway-starting");
        await gateway.startGateway();
        const connect = async (email: string) => {
          const client = await connectOperator(gateway!, email, signal);
          clients.push(client);
          return client;
        };
        mark("gateway-ready");
        const admin = await connect("admin@example.test");
        const owner = await connect("owner@example.test");
        const viewer = await connect("viewer@example.test");
        expect(admin.scopes).toContain("operator.admin");
        expect(owner.scopes.toSorted()).toEqual(WRITER_SCOPES.toSorted());
        expect(viewer.scopes.toSorted()).toEqual(WRITER_SCOPES.toSorted());
        const ownerProfile = (await owner.call("users.self", {})) as { profile: { id: string } };
        const viewerProfile = (await viewer.call("users.self", {})) as { profile: { id: string } };
        expect(ownerProfile.profile.id).not.toBe(viewerProfile.profile.id);

        const describeSession = async (client: typeof owner, sessionKey: string) =>
          (await client.call("sessions.describe", { key: sessionKey })) as SessionDescription;
        const wait = async (runId: string) =>
          admin.call("agent.wait", { runId, timeoutMs: 30_000 });
        const seed = async (message: string, steer: string) => {
          const sessionKey = `agent:main:review-${randomUUID()}`;
          const started = (await owner.call("chat.send", {
            sessionKey,
            message,
            deliver: false,
            idempotencyKey: randomUUID(),
          })) as { runId: string; status: string };
          expect(started.status).toBe("started");
          await expect(wait(started.runId)).resolves.toMatchObject({ status: "error" });
          const { session } = await describeSession(owner, sessionKey);
          expect(session).toMatchObject({
            sharingRole: "owner",
            providerReview: { continuationMessage: steer, canContinue: true },
          });
          return {
            sessionKey,
            sessionId: session.sessionId,
            reviewId: session.providerReview!.id,
          };
        };

        mark("allowed-seed-start");
        const allowed = await seed(SEED_ALLOWED, ALLOWED_STEER);
        mark("one-provider-request");
        expect(requests).toHaveLength(1);
        await owner.call("session.visibility.set", {
          sessionKey: allowed.sessionKey,
          visibility: "read-only",
        });
        expect((await describeSession(viewer, allowed.sessionKey)).session).toMatchObject({
          visibility: "read-only",
          sharingRole: "viewer",
        });
        expect(
          await viewer.request("sessions.providerReview.continue", {
            ...allowed,
            idempotencyKey: randomUUID(),
          }),
        ).toMatchObject({
          ok: false,
          error: { details: { code: "SESSION_PARTICIPATION_REQUIRED" } },
        });
        mark("one-provider-request");
        expect(requests).toHaveLength(1);
        mark("viewer-rejected");
        const acknowledgedAt = Date.now();
        const continued = (await owner.call("sessions.providerReview.continue", {
          ...allowed,
          idempotencyKey: randomUUID(),
        })) as { runId: string; status: string };
        expect(continued.status).toBe("started");
        mark("allowed-acknowledged");
        await expect(wait(continued.runId)).resolves.toMatchObject({ status: "ok" });
        expect(requests).toHaveLength(2);
        expect(userTexts(requests[1]!)).toEqual([...userTexts(requests[0]!), ALLOWED_STEER]);
        const metadata = JSON.parse(
          requests[1]!.client_metadata?.["x-codex-turn-metadata"] ?? "{}",
        ) as { misalignment_override: string };
        const override = JSON.parse(metadata.misalignment_override) as { timestamp: number };
        expect(override.timestamp).toBeGreaterThanOrEqual(acknowledgedAt);
        expect(override.timestamp).toBeLessThanOrEqual(Date.now());
        expect(
          (await describeSession(owner, allowed.sessionKey)).session.providerReview,
        ).toBeUndefined();

        mark("allowed-verified");
        const revoked = await seed(SEED_REVOKED, REVOKED_STEER);
        expect(requests).toHaveLength(3);
        mark("revoked-seeded");
        const admitted = (await owner.call("sessions.providerReview.continue", {
          ...revoked,
          idempotencyKey: randomUUID(),
        })) as { runId: string; status: string };
        expect(admitted.status).toBe("started");
        mark("revoked-acknowledged");
        const terminal = wait(admitted.runId);
        await Promise.race([
          barrierEntered.promise,
          terminal.then((result) => {
            throw new Error(
              `Continuation ended before the revocation barrier: ${JSON.stringify(result)}`,
            );
          }),
        ]);
        signal.throwIfAborted();
        mark("barrier-entered");
        await admin.call("device.pair.remove", { deviceId: owner.deviceId });
        mark("device-removed");
        releaseBarrier.resolve();
        mark("barrier-released");
        await expect(terminal).resolves.toMatchObject({ status: "error" });
        expect(requests).toHaveLength(3);
        expect(
          (await describeSession(admin, revoked.sessionKey)).session.providerReview,
        ).toMatchObject({
          id: revoked.reviewId,
          continuationMessage: REVOKED_STEER,
          canContinue: true,
        });
      },
      () => {
        context.signal.removeEventListener("abort", cancelBarrier);
        mark("cleanup");
        releaseBarrier.resolve();
      },
      async () => {
        for (const client of clients) {
          await client.close();
        }
      },
      () => gateway?.cleanup(),
      async () => {
        server.closeAllConnections();
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      },
      () => portClaim?.release(),
    );
  }, 120_000);
});

function writeAcceptedResponse(response: ServerResponse): void {
  const message = {
    type: "message",
    id: "msg_review_accepted",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Continuation accepted.", annotations: [] }],
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.created",
      response: { id: "resp_review_accepted", status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: "resp_review_accepted",
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}
