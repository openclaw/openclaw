import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { json } from "node:stream/consumers";
import { afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { writeSecretStoreEntry } from "../src/secrets/store/secret-store.js";
import { writeRestartPlugin } from "./gateway-restart.test-support.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const instances: OpenClawTestInstance[] = [];
const dirs: string[] = [];
const servers: Array<Awaited<ReturnType<typeof startOpenAiResponsesModelServer>>> = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it.each(["sentinel", "plugin"] as const)(
  "real Gateway agent exec emits collision warning only for %s winner",
  { timeout: 180_000 },
  async (winner) => {
    const requests: Record<string, unknown>[] = [];
    const server = await startOpenAiResponsesModelServer({
      modelId: "collision-proof",
      bindError: "fake model bind failed",
      onRequest: async (req, res) => {
        const body = (await json(req)) as Record<string, unknown>;
        requests.push(body);
        const previous = JSON.stringify(body.input ?? []);
        if (previous.includes("call_collision_proof")) {
          writeOpenAiResponsesText(res, {
            text: "PROOF_FINISHED",
            responseId: `resp_final_${requests.length}`,
            messageId: `msg_final_${requests.length}`,
          });
          return;
        }
        const item = {
          type: "function_call",
          id: "fc_collision_proof",
          call_id: "call_collision_proof",
          name: "exec",
          arguments: JSON.stringify({
            command:
              'test "$GOG_KEYRING_PASSWORD" = "plugin-stable" && echo PLUGIN_WON || echo EXEC_DONE',
          }),
        };
        writeOpenAiResponsesSse(res, [
          { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
          {
            type: "response.function_call_arguments.delta",
            item_id: item.id,
            output_index: 0,
            delta: item.arguments,
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "resp_collision_proof",
              status: "completed",
              output: [item],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ]);
      },
    });
    servers.push(server);
    const root = await mkdtemp(path.join(tmpdir(), "openclaw-196698-proof-"));
    dirs.push(root);
    const pluginDir = path.join(root, "plugin");
    if (winner === "plugin") {
      await writeRestartPlugin(
        pluginDir,
        { id: "collision-proof", configSchema: { type: "object", properties: {} } },
        `export default { id: "collision-proof", register(api) {
  api.on("resolve_exec_env", () => ({ GOG_KEYRING_PASSWORD: "plugin-stable" }));
} };`,
      );
    }
    const config = createOpenAiResponsesModelConfig({
      baseUrl: server.baseUrl,
      providerId: "collision-proof",
      modelId: "collision-proof",
      reasoning: false,
      toolProfile: "coding",
    });
    config.secrets = { egressProxy: { enabled: true } };
    config.env = { vars: { GOG_KEYRING_PASSWORD: "stable-inherited" } };
    config.agents!.defaults!.workspace = path.join(root, "workspace");
    if (winner === "plugin") {
      config.plugins = {
        enabled: true,
        allow: ["collision-proof"],
        load: { paths: [pluginDir] },
        entries: { "collision-proof": { enabled: true, hooks: { allowConversationAccess: true } } },
        slots: { memory: "none" },
      };
    }
    const instance = await createOpenClawTestInstance({
      name: `collision-proof-${winner}`,
      config: config as OpenClawConfig,
      env: {
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        GOG_KEYRING_PASSWORD: undefined,
      },
    });
    instances.push(instance);
    await writeSecretStoreEntry({
      scope: { kind: "team" },
      name: "GOG_KEYRING_PASSWORD",
      value: "synthetic-protected-value",
      kind: "secret",
      allowedHosts: ["api.example.com"],
      updatedBy: "test",
      database: { env: instance.env },
    });
    await instance.startGateway();
    const client = await connectGatewayClient({
      url: instance.url,
      token: instance.gatewayToken,
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    try {
      const result = await client.request<{ status?: string }>(
        "agent",
        {
          sessionKey: `agent:main:collision-${winner}`,
          message: "Call exec once.",
          deliver: false,
          idempotencyKey: `collision-${winner}`,
        },
        { expectFinal: true, timeoutMs: 100_000 },
      );
      expect(result.status).toBe("ok");
      expect(requests.length).toBeGreaterThanOrEqual(2);
      const input = requests.at(-1)?.input;
      const toolResult = (Array.isArray(input) ? input : []).find(
        (entry) =>
          entry?.type === "function_call_output" && entry.call_id === "call_collision_proof",
      )?.output;
      expect(typeof toolResult).toBe("string");
      if (winner === "sentinel") {
        expect(toolResult).toContain('overrides the inherited "GOG_KEYRING_PASSWORD"');
        expect(toolResult).toContain("EXEC_DONE");
      } else {
        expect(toolResult).toContain("PLUGIN_WON");
        expect(toolResult).not.toContain("overrides the inherited");
      }
    } finally {
      await disconnectGatewayClient(client);
    }
  },
);
