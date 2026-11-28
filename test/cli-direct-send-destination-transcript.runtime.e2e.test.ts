// Runtime proof: real CLI + resident Gateway + SQLite; only platform/model I/O is synthetic.
// Direct-mode channel (Slack, Discord, IRC, ...): the CLI process runs the adapter itself.
import fs from "node:fs/promises";
import path from "node:path";
import { readSessionTranscriptRawDelta } from "openclaw/plugin-sdk/session-transcript-runtime";
import { expect, it } from "vitest";
import { loadSessionEntry } from "../src/config/sessions/session-accessor.js";
import { disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { connectProofClient, readRequestText } from "./helpers/gateway-integration-fixtures.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

const channel = "transcript-proof";
const sessionKey = "agent:main:transcript-proof:group:destination";
const sentText = "SYNTHETIC_CLI_DESTINATION_MESSAGE";

it(
  "appends the tool result after a direct-mode CLI send that the same turn ran into its own conversation",
  { timeout: 180_000 },
  async () => {
    let modelCalls = 0;
    let platformSends = 0;
    let platformSenderPid: number | undefined;
    const model = await startOpenAiResponsesModelServer({
      modelId: "transcript-proof",
      bindError: "synthetic model did not bind",
      onRequest: async (request, response) => {
        const raw = await readRequestText(request);
        // The same loopback server also represents the fake external channel transport.
        if (raw.includes('"syntheticPlatformSend":true')) {
          platformSends += 1;
          platformSenderPid = JSON.parse(raw).senderPid;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ ok: true, result: { messageId: "synthetic-platform-message" } }),
          );
          return;
        }
        modelCalls += 1;
        if (modelCalls === 2) {
          const item = {
            type: "function_call",
            id: "fc_proof",
            call_id: "call_proof",
            name: "dispatch_action",
            arguments: JSON.stringify({ id: "transcript_probe", args: {} }),
            status: "completed",
          };
          writeOpenAiResponsesSse(response, [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, arguments: "", status: "in_progress" },
            },
            {
              type: "response.function_call_arguments.delta",
              output_index: 0,
              item_id: item.id,
              delta: item.arguments,
            },
            {
              type: "response.function_call_arguments.done",
              output_index: 0,
              item_id: item.id,
              arguments: item.arguments,
            },
            { type: "response.output_item.done", output_index: 0, item },
            {
              type: "response.completed",
              response: {
                id: "response_tool",
                status: "completed",
                output: [item],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ]);
        } else {
          writeOpenAiResponsesText(response, {
            text: modelCalls === 1 ? "SYNTHETIC_WARMUP" : "SYNTHETIC_FOLLOWUP_COMPLETE",
            messageId: "message_" + modelCalls,
            responseId: "response_" + modelCalls,
          });
        }
      },
    });
    const config = createOpenAiResponsesModelConfig({
      baseUrl: model.baseUrl,
      providerId: "transcript-proof",
      modelId: "transcript-proof",
      reasoning: false,
      toolProfile: "full",
    });
    config.agents!.defaults!.systemAgent = { agentId: "main" };
    config.tools = { profile: "full", allow: [channel], codeMode: false };
    config.plugins = { allow: [channel], slots: { memory: "none" } };
    config.channels = { [channel]: { enabled: true } };
    const instance = await createOpenClawTestInstance({
      name: "cli-destination-transcript",
      config,
      entrypoint: ["dist/index.js"],
      env: {
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
    });
    let client: Awaited<ReturnType<typeof connectProofClient>> | undefined;
    try {
      const pluginRoot = instance.state.statePath("fixture-plugin");
      const meta = {
        id: channel,
        label: "Synthetic transcript proof",
        selectionLabel: "Synthetic transcript proof",
        docsPath: "/channels/test",
        blurb: "Synthetic transport",
      };
      const schema = {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        additionalProperties: false,
      };
      await instance.state.writeJson("fixture-plugin/package.json", {
        name: channel,
        version: "1.0.0",
        type: "module",
        openclaw: { extensions: ["./index.js"], setupEntry: "./index.js", channel: meta },
      });
      await instance.state.writeJson("fixture-plugin/openclaw.plugin.json", {
        id: channel,
        activation: { onStartup: true },
        channels: [channel],
        configSchema: { type: "object", properties: {} },
        channelConfigs: { [channel]: { schema } },
        contracts: { tools: ["transcript_probe"] },
      });
      await instance.state.writeText(
        "fixture-plugin/index.js",
        'import { execFileSync } from "node:child_process";\nexport const plugin = {\n  id: "transcript-proof",\n  meta: {"id":"transcript-proof","label":"Synthetic transcript proof","selectionLabel":"Synthetic transcript proof","docsPath":"/channels/test","blurb":"Synthetic transport"},\n  capabilities: { chatTypes: ["group"] },\n  outbound: {\n    deliveryMode: "direct",\n    async sendText({ to, text, cfg }) {\n      const response = await fetch(cfg.plugins.entries["transcript-proof"].config.endpoint + "/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ syntheticPlatformSend: true, senderPid: process.pid, params: { to, text } }) });\n      await response.json();\n      return { channel: "transcript-proof", messageId: "synthetic-platform-message" };\n    }\n  },\n  configSchema: { schema: { type: "object", properties: { enabled: { type: "boolean" } }, additionalProperties: false } },\n  config: { listAccountIds: () => ["default"], resolveAccount: () => ({ accountId: "default", enabled: true }), isConfigured: () => true, isEnabled: () => true },\n  messaging: { resolveOutboundSessionRoute: () => ({ sessionKey: "agent:main:transcript-proof:group:destination", baseSessionKey: "agent:main:transcript-proof:group:destination", recipientSessionExact: true, peer: { kind: "group", id: "destination" }, chatType: "group", from: "transcript-proof:group:destination", to: "group:destination" }) }\n};\nexport default { id: plugin.id, register(api) { api.registerChannel({ plugin }); api.registerTool({ name: "transcript_probe", label: "Transcript probe", description: "Synthetic proof tool", parameters: { type: "object", properties: {} }, async execute() { const out = execFileSync(process.execPath, [process.argv[1], "message", "send", "--channel", "transcript-proof", "--target", "group:destination", "--message", "SYNTHETIC_CLI_DESTINATION_MESSAGE", "--json"], { env: process.env, encoding: "utf8", timeout: 60000 }); return { content: [{ type: "text", text: "SYNTHETIC_TOOL_RESULT" }], details: { ok: true, cli: out.length } }; } }); } };',
      );
      const current = JSON.parse(await fs.readFile(instance.configPath, "utf8"));
      current.plugins.load = { paths: [pluginRoot] };
      current.plugins.entries = {
        [channel]: { enabled: true, config: { endpoint: model.baseUrl } },
      };
      await instance.state.writeConfig(current);
      await instance.startGateway();
      client = await connectProofClient(instance, {
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      const turn = async (message: string) => {
        const started = await client!.request<{ runId: string; status: string }>("agent", {
          sessionKey,
          message,
          deliver: false,
          idempotencyKey: message,
        });
        if (started.status !== "ok") {
          const finished = await client!.request<{ status: string }>(
            "agent.wait",
            { runId: started.runId, timeoutMs: 60_000 },
            { timeoutMs: 65_000 },
          );
          expect(finished.status, JSON.stringify(finished) + instance.logs()).toBe("ok");
        }
      };
      await turn("SYNTHETIC_WARMUP_USER");
      const storePath = path.join(instance.state.sessionsDir("main"), "sessions.json");
      const entry = loadSessionEntry({
        agentId: "main",
        sessionKey,
        storePath,
        readConsistency: "latest",
      });
      expect(entry).toBeTruthy();
      const history = async () => {
        const page = await readSessionTranscriptRawDelta({
          agentId: "main",
          sessionKey,
          sessionId: entry!.sessionId,
          storePath,
          maxBytes: 1_000_000,
          maxEvents: 100,
        });
        expect(page.kind).toBe("page");
        if (page.kind !== "page") {
          throw new Error("Expected transcript page");
        }
        expect(page.hasMore).toBe(false);
        return page.events;
      };
      const sentRows = async () =>
        (await history()).filter((row) => JSON.stringify(row.event).includes(sentText));
      // The follow-up turn's tool runs `openclaw message send` into this same conversation,
      // as a skill script run by an exec tool does; the CLI process runs the direct adapter.
      await turn("SYNTHETIC_FOLLOWUP_USER");
      expect(platformSends).toBe(1);
      expect(platformSenderPid).not.toBe(instance.child?.pid);
      const rows = await history();
      const serialized = rows.map((row) => JSON.stringify(row.event));
      const orderedMarkers = [
        "SYNTHETIC_FOLLOWUP_USER",
        "call_proof",
        sentText,
        "SYNTHETIC_TOOL_RESULT",
        "SYNTHETIC_FOLLOWUP_COMPLETE",
      ];
      const markerRows = orderedMarkers.map((marker) =>
        serialized.findIndex((text) => text.includes(marker)),
      );
      expect(
        markerRows.every((index) => index >= 0),
        JSON.stringify({ orderedMarkers, markerRows }),
      ).toBe(true);
      expect(markerRows).toEqual(markerRows.toSorted((a, b) => a - b));
      expect(new Set(markerRows).size).toBe(markerRows.length);
      const sequences = rows.map((row) => row.seq);
      expect(new Set(sequences).size).toBe(rows.length);
      expect(sequences).toEqual(sequences.toSorted((a, b) => a - b));
      expect(await sentRows()).toHaveLength(1);
      expect(modelCalls).toBe(3);
      expect(instance.logs()).not.toMatch(
        /UNIQUE constraint failed.*transcript|sequence collision/i,
      );
    } finally {
      if (client) {
        await disconnectGatewayClient(client);
      }
      await instance.cleanup();
      await model.close();
    }
  },
);
