import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createTrackedProvider } from "../../../../src/gateway/test-helpers.tracked-provider.js";
import { buildMockOpenAiResponsesProvider } from "../../../../src/gateway/test-openai-responses-model.js";
import {
  createFixtureRequest,
  verifyBuiltGatewayHead,
} from "../../../helpers/gateway-built-fixture.js";
import { acquireGatewayTestClient } from "../../../helpers/gateway-client.js";
import { writeOpenAiResponsesText } from "../../../helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import { runQaGatewayTestFixture } from "../../../helpers/qa-gateway-test-lifetime.js";

it(
  "replays a committed creation across Gateway processes without starting its task twice",
  { timeout: 240_000 },
  async (context) => {
    let gateway: OpenClawTestInstance | undefined;
    let client: Awaited<ReturnType<typeof acquireGatewayTestClient>> | undefined;
    let modelRequests = 0;
    const provider = createTrackedProvider((_raw, response, request) => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [] }));
        return;
      }
      modelRequests += 1;
      writeOpenAiResponsesText(response, {
        text: "CREATION_REPLAY_OK",
        messageId: `msg_${modelRequests}`,
        responseId: `resp_${modelRequests}`,
      });
    });
    await runQaGatewayTestFixture(
      context,
      async ({ signal, verifyCleanup }) => {
        await verifyBuiltGatewayHead(process.cwd(), signal);
        const model = buildMockOpenAiResponsesProvider(await provider.listen(), "replay-fixture");
        gateway = await createOpenClawTestInstance({
          name: "session-create-restart",
          cwd: process.cwd(),
          signal,
          verifyCleanup,
          stopTimeoutMs: 10_000,
          env: {
            // The deterministic provider is loopback, never the host's outbound proxy.
            NO_PROXY: "127.0.0.1,localhost,::1",
            no_proxy: "127.0.0.1,localhost,::1",
            VITEST: undefined,
            NODE_ENV: "production",
            OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
            OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          },
        });
        const instance = gateway;
        await instance.state.writeConfig({
          gateway: {
            port: instance.port,
            auth: { mode: "token", token: instance.gatewayToken },
            controlUi: { enabled: false },
          },
          hooks: { enabled: false },
          plugins: { slots: { memory: "none" } },
          tools: { profile: "minimal" },
          agents: {
            ownership: "explicit",
            entries: { replay: {} },
            defaults: {
              workspace: instance.state.workspaceDir,
              skipBootstrap: true,
              model: { primary: model.modelRef, fallbacks: [] },
              models: {
                [model.modelRef]: {
                  agentRuntime: { id: "openclaw" },
                  params: { transport: "sse", openaiWsWarmup: false },
                },
              },
            },
          },
          models: {
            mode: "replace",
            providers: {
              [model.providerId]: {
                ...model.config,
                apiKey: "synthetic-replay-fixture",
                request: { allowPrivateNetwork: true },
              },
            },
          },
        });
        const connect = async () => {
          await instance.startGateway();
          client = await acquireGatewayTestClient(
            {
              url: instance.url,
              token: instance.gatewayToken,
              clientName: "cli",
              mode: "cli",
              role: "operator",
              scopes: ["operator.admin", "operator.read", "operator.write"],
            },
            {
              timeoutMs: 30_000,
              timeoutMessage: "Replay Gateway did not connect",
              closeMessage: "Replay Gateway closed",
              signal,
              verifyCleanup,
            },
          );
          return createFixtureRequest(client, signal);
        };
        let request = await connect();
        const firstPid = instance.child?.pid;
        expect(firstPid).toBeTypeOf("number");
        const params = {
          agentId: "replay",
          key: "agent:replay:dashboard:original",
          label: "Original receipt label",
          idempotencyKey: randomUUID(),
          message: "Reply CREATION_REPLAY_OK.",
        };
        const created = await request<{
          key: string;
          sessionId: string;
          runId: string;
          runStarted: boolean;
        }>("sessions.create", params);
        expect(created.runStarted, JSON.stringify(created)).toBe(true);
        const wait = async (runId: string) => {
          const terminal = await request<{ status: string }>(
            "agent.wait",
            { runId, timeoutMs: 60_000 },
            { timeoutMs: 65_000 },
          );
          if (terminal.status !== "ok") {
            throw new Error(JSON.stringify({ terminal, modelRequests }) + "\n" + instance.logs());
          }
          return terminal;
        };
        expect(await wait(created.runId)).toMatchObject({ status: "ok" });
        expect(modelRequests).toBe(1);
        await request("sessions.patch", {
          key: created.key,
          agentId: "replay",
          label: "Renamed original",
        });
        await request("sessions.create", { agentId: "replay", label: params.label });
        await client?.stopAndWait({ timeoutMs: 1_000 });
        client = undefined;
        await instance.stopGateway();
        request = await connect();
        expect(instance.child?.pid).not.toBe(firstPid);
        const replay = await request("sessions.create", params);
        expect(replay).toMatchObject({
          key: created.key,
          sessionId: created.sessionId,
          creationReplayed: true,
          runStarted: false,
          entry: { label: "Renamed original" },
        });
        expect(modelRequests).toBe(1);
        const history = await request<{ messages: unknown[] }>("chat.history", {
          sessionKey: created.key,
          agentId: "replay",
        });
        expect(JSON.stringify(history.messages)).toContain("CREATION_REPLAY_OK");
        const next = await request<{ runId: string }>("chat.send", {
          sessionKey: created.key,
          agentId: "replay",
          message: "Reply again.",
          idempotencyKey: randomUUID(),
        });
        expect(await wait(next.runId)).toMatchObject({ status: "ok" });
        expect(modelRequests).toBe(2);
        await request("sessions.reset", { key: created.key, agentId: "replay" });
        await expect(request("sessions.create", params)).rejects.toThrow(
          "original creation incarnation",
        );
      },
      async () => {
        await client?.stopAndWait({ timeoutMs: 1_000 });
      },
      async () => {
        await gateway?.cleanup();
      },
      () => provider.close(),
    );
  },
);
