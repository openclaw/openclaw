import { readFile } from "node:fs/promises";
import { json } from "node:stream/consumers";
import { expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../packages/gateway-protocol/src/client-info.js";
import type { GatewayClient } from "../src/gateway/client.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

it.skipIf(process.platform === "win32")(
  "resumes a token-authenticated Control UI turn after a hard Gateway crash",
  { timeout: 600_000 },
  async () => {
    const sessionKey = "agent:main:operator-restart";
    const marker = "OPERATOR_RESTART_COMPLETE";
    const requests: unknown[] = [];
    const model = await startOpenAiResponsesModelServer({
      modelId: "restart-proof",
      bindError: "restart proof model did not bind",
      onRequest: async (request, response) => {
        requests.push(await json(request));
        // Leave the first model call in flight until the Gateway is killed.
        if (requests.length > 1) {
          writeOpenAiResponsesText(response, {
            text: marker,
            messageId: "msg_restart",
            responseId: "resp_restart",
          });
        }
      },
    });
    const instance = await createOpenClawTestInstance({
      name: "gateway-operator-restart",
      env: {
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
      startTimeoutMs: 300_000,
    });
    let client: GatewayClient | undefined;
    await runQaGatewayFixture(
      async () => {
        const config = createOpenAiResponsesModelConfig({
          baseUrl: model.baseUrl,
          providerId: "restart-proof",
          modelId: "restart-proof",
          reasoning: false,
          toolProfile: "minimal",
        });
        config.plugins = { enabled: false };
        config.gateway = {
          mode: "local",
          bind: "loopback",
          port: instance.port,
          auth: { mode: "token", token: instance.gatewayToken },
          controlUi: { enabled: true },
        };
        await instance.state.writeConfig(config);
        const buildInfo = JSON.parse(await readFile("dist/build-info.json", "utf8")) as {
          buildId: string;
        };
        const deviceIdentity = loadOrCreateDeviceIdentity({
          path: instance.state.path("proof-device.sqlite"),
        });
        const observerDeviceIdentity = loadOrCreateDeviceIdentity({
          path: instance.state.path("observer-device.sqlite"),
        });
        const connect = (controlUi: boolean) =>
          acquireGatewayTestClient(
            {
              url: instance.url,
              origin: controlUi ? `http://127.0.0.1:${instance.port}` : undefined,
              token: instance.gatewayToken,
              // Observing through another auth class must not replace the UI's credential.
              deviceIdentity: controlUi ? deviceIdentity : observerDeviceIdentity,
              clientName: controlUi ? GATEWAY_CLIENT_IDS.CONTROL_UI : GATEWAY_CLIENT_IDS.TEST,
              clientBuildId: controlUi ? buildInfo.buildId : undefined,
              mode: controlUi ? "webchat" : "test",
              scopes: ["operator.admin", "operator.read", "operator.write"],
            },
            {
              timeoutMs: 60_000,
              timeoutMessage: "restart connect timeout",
              closeMessage: "closed",
            },
          );
        await instance.startGateway();
        client = await connect(true);
        await client
          .request("sessions.create", {
            key: sessionKey,
            agentId: "main",
            model: "restart-proof/restart-proof",
            cwd: instance.state.workspaceDir,
          })
          .catch((cause: unknown) => {
            throw new Error(`Session creation failed: ${instance.logs()}`, { cause });
          });
        await client.request("chat.send", {
          sessionKey,
          message: `Reply with ${marker}.`,
          idempotencyKey: "operator-restart-original",
        });
        await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 60_000 });
        const originalPid = instance.child?.pid;
        await client.stopAndWait();
        client = undefined;
        await instance.crashGateway();
        await instance.startGateway();
        expect(instance.child?.pid).not.toBe(originalPid);
        client = await connect(false);
        const observer = client;
        await vi.waitFor(
          async () => {
            const sessions = await observer.request<SessionsListResult>("sessions.list", {
              agentId: "main",
            });
            const row = sessions.sessions.find((session) => session.key === sessionKey);
            if (row?.status === "failed") {
              throw new Error(`Recovery failed: ${instance.logs()}`);
            }
            expect(row).toMatchObject({ status: "done", hasActiveRun: false });
          },
          { timeout: 60_000, interval: 250 },
        );
        expect(requests).toHaveLength(2);
        const history = await observer.request<{ messages: unknown[] }>("chat.history", {
          sessionKey,
        });
        expect(JSON.stringify(history.messages)).toContain(marker);
        expect(instance.logs()).toContain("startup-orphaned main session(s)");
      },
      () => client?.stopAndWait(),
      () => instance.cleanup(),
      () => model.close(),
    );
  },
);
