import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { toSandboxProvisioningError } from "../agents/sandbox/provisioning-error.js";
import * as workspaceSandbox from "../agents/workspace-sandbox.js";
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
import {
  createProductState,
  productModelConfig,
  productProvider,
} from "./server.chat-product.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it(
  "keeps both orphan and current images on a merging provider route",
  { timeout: 90_000 },
  async () => {
    const state = await createProductState("chat-merged-media");
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    const requests: string[] = [];
    const errors: unknown[] = [];
    const server = productProvider(errors, (body, response) => {
      requests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        'data: {"choices":[{"index":0,"delta":{"content":"Acknowledged."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    });
    const sessionKey = "agent:main:merged-media";
    const resolveWorkspace = workspaceSandbox.resolveAttemptWorkspaceSandbox;
    let failSetup = true;
    const setup = vi
      .spyOn(workspaceSandbox, "resolveAttemptWorkspaceSandbox")
      .mockImplementation(async (params) => {
        if (params.sessionKey === sessionKey && failSetup) {
          failSetup = false;
          throw toSandboxProvisioningError(new Error("Synthetic sandbox setup failure"), "docker");
        }
        return resolveWorkspace(params);
      });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      const provider = buildMockOpenAiResponsesProvider(
        await listenProvider(server),
        "media-replay",
      );
      provider.config.api = "openai-completions";
      provider.config.models[0].api = "openai-completions";
      provider.config.models[0].input = ["text", "image"];
      const model = productModelConfig(state.workspaceDir, provider);
      gateway = await startGatewayWithClient({
        cfg: {
          agents: { defaults: { ...model.defaults, utilityModel: "" } },
          models: model.models,
          plugins: { enabled: false, slots: { memory: "none" } },
          tools: { profile: "minimal" },
          gateway: { auth: { mode: "token", token: "synthetic-merged-media" } },
        },
        configPath: state.configPath,
        token: "synthetic-merged-media",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      await gateway.server.startupSettled;
      const client = gateway.client;
      await client.request("sessions.create", { key: sessionKey, agentId: "main" });
      const send = (content: string) =>
        client.request<{ runId: string }>("chat.send", {
          sessionKey,
          message: "Inspect this image.",
          deliver: false,
          idempotencyKey: randomUUID(),
          attachments: [{ fileName: "image.png", mimeType: "image/png", content }],
        });
      const wait = (runId: string) =>
        client.request("agent.wait", { runId, timeoutMs: 30_000 }, { timeoutMs: 35_000 });
      const earlier = createSolidPngBuffer(1, 1, { r: 255, g: 0, b: 0 }).toString("base64");
      const current = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 }).toString("base64");
      expect(await wait((await send(earlier)).runId)).toMatchObject({ status: "error" });
      expect(failSetup).toBe(false);
      expect(requests).toEqual([]);
      expect(await wait((await send(current)).runId)).toMatchObject({ status: "ok" });
      expect(errors).toEqual([]);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain(earlier);
      expect(requests[0]).toContain(current);
      const history = await client.request<{ messages: unknown[] }>("chat.history", { sessionKey });
      expect(
        history.messages.filter((message) => Reflect.get(message as object, "role") === "user"),
      ).toHaveLength(2);
    } finally {
      setup.mockRestore();
      try {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "merged media proof complete" });
        }
      } finally {
        await closeProvider(server);
        vi.unstubAllEnvs();
        await state.cleanup();
      }
    }
  },
);
