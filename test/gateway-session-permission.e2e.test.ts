// Real inference and tool execution prove a current session permission change gates effects.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import {
  restartEnv,
  connectRestartClient,
  restartProviderServer,
  restartToolNames,
  writeRestartJsonText,
  restartModelConfig,
  writeRestartToolCall,
} from "./gateway-restart.test-support.js";
import { GATEWAY_RESTART_TEST_KILL_MS } from "./helpers/gateway-restart-budget.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { createDeferred, withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const ORDINARY_KEY = "agent:main:ordinary-permission-control";
const ORDINARY_REQUEST = "ORDINARY_PERMISSION_CONTROL: wait for the operator.";
const ORDINARY_FINAL = "ORDINARY_PERMISSION_CHANGE_FINISHED";

async function startProvider(signal: AbortSignal) {
  const ordinaryReady = createDeferred();
  const releaseOrdinary = createDeferred();
  const failed = createDeferred<never>();
  void failed.promise.catch(() => {});
  let ordinaryEffectIssued = false;
  let ordinal = 0;
  const reservation = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () =>
      restartProviderServer(
        failed,
        async (request, response, body) => {
          expect(request.url).toBe("/v1/responses");
          const tools = restartToolNames(body);
          const input = JSON.stringify(body.input);
          const callOrdinal = ++ordinal;
          const text = (value: string) => {
            if (body.stream === false) {
              writeRestartJsonText(response, value, `permission_${callOrdinal}`);
            } else {
              writeOpenAiResponsesText(response, {
                text: value,
                messageId: `msg_permission_${callOrdinal}`,
                responseId: `resp_permission_${callOrdinal}`,
              });
            }
          };
          if (tools.length === 0) {
            text("Synthetic permission test");
            return;
          }
          expect(input).toContain(ORDINARY_REQUEST);
          if (!ordinaryEffectIssued) {
            ordinaryReady.resolve();
            await withinTest(releaseOrdinary.promise, signal);
            if (response.destroyed) {
              return;
            }
            ordinaryEffectIssued = true;
            const args = { command: "printf 'forbidden\\n' > ordinary-effect" };
            const wireName = tools.includes("exec") ? "exec" : "dispatch_action";
            expect(tools).toContain(wireName);
            writeRestartToolCall(
              response,
              "permission",
              wireName,
              wireName === "exec" ? args : { id: "exec", args },
              callOrdinal,
            );
          } else {
            const results = Array.isArray(body.input)
              ? body.input.filter((item) => isRecord(item) && item.type === "function_call_output")
              : [];
            expect(results.at(-1)).toMatchObject({ output: "Permission change" });
            text(ORDINARY_FINAL);
          }
        },
        { ignoreAborted: true },
      ),
  });
  return {
    baseUrl: `http://127.0.0.1:${reservation.claim.port}/v1`,
    failed: failed.promise,
    ordinaryReady: ordinaryReady.promise,
    releaseOrdinary: () => releaseOrdinary.resolve(),
    close: () =>
      runQaGatewayFixture(
        async () => {
          releaseOrdinary.resolve();
          reservation.listener.closeAllConnections();
        },
        reservation.releaseListener,
        reservation.claim.release,
      ),
  };
}

async function createInstance(
  provider: Awaited<ReturnType<typeof startProvider>>,
  signal: AbortSignal,
) {
  const model = buildMockOpenAiResponsesProvider(provider.baseUrl);
  const noProxy = [process.env.no_proxy ?? process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"]
    .filter(Boolean)
    .join(",");
  const instance = await createOpenClawTestInstance({
    name: "gateway-session-permission",
    signal,
    startTimeoutMs: 120_000,
    stopTimeoutMs: 10_000,
    gracefulShutdownTimeoutMs: GATEWAY_RESTART_TEST_KILL_MS,
    env: {
      // Keep only the owned loopback fixtures direct; preserve external proxy routing.
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      ...restartEnv,
      OPENCLAW_NO_RESPAWN: "1",
    },
  });
  await instance.state.writeConfig({
    update: { checkOnStart: false },
    browser: { enabled: false },
    discovery: { mdns: { mode: "off" } },
    plugins: { enabled: false },
    ...restartModelConfig(
      model,
      instance.state.workspaceDir,
      {},
      { catalogRefresh: { enabled: false } },
    ),
    tools: {
      allow: ["exec"],
      codeMode: { enabled: false },
      sessions: { visibility: "all" },
      exec: { host: "gateway", security: "full", ask: "off" },
    },
    gateway: {
      mode: "local",
      controlUi: { enabled: false },
      bind: "loopback",
      port: instance.port,
      auth: { mode: "token", token: instance.gatewayToken },
    },
  });
  return instance;
}

function connectInstance(
  instance: Awaited<ReturnType<typeof createInstance>>,
  signal: AbortSignal,
) {
  return connectRestartClient(instance, { mode: "backend" }, signal);
}

async function applyReadOnly(
  client: GatewayClient,
  instance: Awaited<ReturnType<typeof createInstance>>,
  key: string,
) {
  try {
    await client.request("sessions.patch", { key, permissionMode: "read-only" });
  } catch (error) {
    const diagnostics = instance
      .logs()
      .split("\n")
      .filter((line) => line.includes("Permission change failed:"));
    throw new Error(`${String(error)}\n${diagnostics.join("\n")}`, { cause: error });
  }
}

it.skipIf(process.platform === "win32")(
  "applies an ordinary operator permission change while inference is pending",
  { timeout: 120_000 },
  async ({ signal }) => {
    const provider = await startProvider(signal);
    const instance = await createInstance(provider, signal);
    let client: GatewayClient | undefined;
    const race = <T>(promise: Promise<T>) =>
      withinTest(Promise.race([promise, provider.failed]), signal);
    await runQaGatewayFixture(
      async () => {
        await instance.startGateway();
        client = await connectInstance(instance, signal);
        await client.request("sessions.create", {
          key: ORDINARY_KEY,
          agentId: "main",
          permissionMode: "full",
        });
        await client.request(
          "chat.send",
          {
            sessionKey: ORDINARY_KEY,
            message: ORDINARY_REQUEST,
            idempotencyKey: "ordinary-control",
          },
          { expectFinal: false },
        );
        await race(provider.ordinaryReady);
        await applyReadOnly(client, instance, ORDINARY_KEY);
        provider.releaseOrdinary();
        await race(
          vi.waitFor(
            async () => {
              const history = await client!.request("chat.history", { sessionKey: ORDINARY_KEY });
              expect(JSON.stringify(history)).toContain(ORDINARY_FINAL);
              const sessions = await client!.request<SessionsListResult>("sessions.list", {
                agentId: "main",
              });
              expect(sessions.sessions.find((row) => row.key === ORDINARY_KEY)).toMatchObject({
                hasActiveRun: false,
                permissionMode: "read-only",
              });
            },
            { timeout: 30_000 },
          ),
        );
        await expect(
          readFile(path.join(instance.state.workspaceDir, "ordinary-effect")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      },
      async () => client?.stopAndWait(),
      () => instance.cleanup(),
      provider.close,
    );
  },
);
