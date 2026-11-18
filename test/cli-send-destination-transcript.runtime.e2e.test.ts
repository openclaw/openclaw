// Runtime proof: real CLI + resident Gateway + SQLite; only platform/model I/O is synthetic.
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
  "persists one delegated CLI send and appends a resident agent tool turn without sequence collisions",
  { timeout: 180_000 },
  async () => {
    let modelCalls = 0;
    let platformSends = 0;
    let platformSenderPid: number | undefined;
    let idempotencyKey: string | undefined;
    const model = await startOpenAiResponsesModelServer({
      modelId: "transcript-proof",
      bindError: "synthetic model did not bind",
      onRequest: async (request, response) => {
        const raw = await readRequestText(request);
        // The same loopback server also represents the fake external channel transport.
        if (raw.includes('"syntheticPlatformSend":true')) {
          platformSends += 1;
          idempotencyKey = JSON.parse(raw).params.idempotencyKey;
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
    let stage = "startup";
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
        'export const plugin = {\n  id: "transcript-proof",\n  meta: {"id":"transcript-proof","label":"Synthetic transcript proof","selectionLabel":"Synthetic transcript proof","docsPath":"/channels/test","blurb":"Synthetic transport"},\n  capabilities: { chatTypes: ["group"] },\n  outbound: { deliveryMode: "gateway" },\n  configSchema: { schema: { type: "object", properties: { enabled: { type: "boolean" } }, additionalProperties: false } },\n  config: { listAccountIds: () => ["default"], resolveAccount: () => ({ accountId: "default", enabled: true }), isConfigured: () => true, isEnabled: () => true },\n  actions: {\n    describeMessageTool: () => ({ actions: ["send"] }),\n    supportsAction: ({ action }) => action === "send",\n    resolveExecutionMode: () => "gateway",\n    async handleAction({ params, cfg }) {\n      const response = await fetch(cfg.plugins.entries["transcript-proof"].config.endpoint + "/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ syntheticPlatformSend: true, senderPid: process.pid, params }) });\n      const result = await response.json();\n      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };\n    }\n  },\n  messaging: { resolveOutboundSessionRoute: () => ({ sessionKey: "agent:main:transcript-proof:group:destination", baseSessionKey: "agent:main:transcript-proof:group:destination", recipientSessionExact: true, peer: { kind: "group", id: "destination" }, chatType: "group", from: "transcript-proof:group:destination", to: "group:destination" }) }\n};\nexport default { id: plugin.id, register(api) { api.registerChannel({ plugin }); api.registerTool({ name: "transcript_probe", label: "Transcript probe", description: "Synthetic proof tool", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "SYNTHETIC_TOOL_RESULT" }], details: { ok: true } }; } }); } };',
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
      stage = "warmup";
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
      stage = "cli-send";
      const cli = await instance.cli(
        [
          "message",
          "send",
          "--channel",
          channel,
          "--target",
          "group:destination",
          "--message",
          sentText,
          "--json",
        ],
        { timeoutMs: 60_000 },
      );
      expect(cli.code, cli.stdout + cli.stderr).toBe(0);
      expect(JSON.parse(cli.stdout)).toMatchObject({ handledBy: "plugin" });
      expect(platformSenderPid).toBe(instance.child?.pid);
      expect(await sentRows()).toHaveLength(1);
      // Inspect durable rows from this separate reader without refreshing the resident owner.
      expect(
        loadSessionEntry({ agentId: "main", sessionKey, storePath, readConsistency: "latest" }),
      ).toMatchObject({
        groupId: "destination",
        displayName: entry!.displayName,
      });
      expect(idempotencyKey).toBeTruthy();
      stage = "replay";
      await client.request("message.action", {
        channel,
        action: "send",
        params: { to: "group:destination", message: sentText, idempotencyKey },
        agentId: "main",
        senderIsOwner: true,
        conversationReadOrigin: "direct-operator",
        idempotencyKey,
      });
      expect(platformSends).toBe(1);
      expect(await sentRows()).toHaveLength(1);
      stage = "resident-followup";
      await turn("SYNTHETIC_FOLLOWUP_USER");
      const rows = await history();
      const serialized = rows.map((row) => JSON.stringify(row.event));
      const orderedMarkers = [
        sentText,
        "SYNTHETIC_FOLLOWUP_USER",
        "call_proof",
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
      process.stdout.write(
        JSON.stringify({
          proof: "cli-destination-transcript",
          cliExit: cli.code,
          platformSends,
          destinationRows: 1,
          modelCalls,
          transcriptRows: rows.length,
          uniqueSequences: true,
          orderedMarkers,
          markerSequences: markerRows.map((index) => rows[index]?.seq),
          residentFollowup: "user + tool call/result + assistant",
          externalIO: "synthetic loopback HTTP only",
        }) + "\n",
      );
    } catch (error) {
      process.stderr.write(
        JSON.stringify({
          stage,
          platformSends,
          modelCalls,
          diagnostics: instance
            .logs()
            .split("\n")
            .filter((line) => /conflict|collision|constraint|seq|error/i.test(line))
            .map((line) => line.replaceAll(instance.state.root, "<isolated-state>")),
        }) + "\n",
      );
      throw error;
    } finally {
      if (client) {
        await disconnectGatewayClient(client);
      }
      await instance.cleanup();
      await model.close();
    }
  },
);
