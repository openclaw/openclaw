// A session whose context engine owns its history: after a model switch rebuilds the system
// prompt and retires an earlier prompt update, the next request must still carry the user's text.
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { startGatewayWithClient } from "../src/gateway/test-helpers.e2e.js";
import { waitForGatewayActiveWork } from "../src/infra/gateway-active-work.js";
import {
  buildFakeProvider,
  latestInput,
  readWireRequest,
  toolNames,
  writeReply,
  type WireRequest,
} from "./helpers/fake-model-transports.js";
import { listenProofProvider, useRuntimeProofFixture } from "./runtime-proof.test-support.js";

const TOKEN = "engine-rebuild-token";
const TARGET = "agent:main:engine-rebuild-target";
const ENGINE_ID = "stored-history-engine";
const api = "anthropic-messages";

// A store-backed engine: it keeps the host's live notes but only conversation it has committed.
const ENGINE_SOURCE = `module.exports = { id: "${ENGINE_ID}", register(api) {
  const stored = new Set();
  const key = (message) => message.role + ":" + message.timestamp;
  api.registerContextEngine("${ENGINE_ID}", () => ({
    info: { id: "${ENGINE_ID}", name: "Stored history", ownsCompaction: true, transcriptSemantics: { currentTurnFence: "before-current-turn-entry-v1", turnAdvancementIdempotency: "atomic-idempotent-v1" } },
    async ingest() { return { ingested: false }; },
    async assemble({ messages }) { return { messages: messages.filter((message) => message.role === "custom" || stored.has(key(message))), estimatedTokens: 0 }; },
    async compact() { return { ok: true, compacted: false }; },
    async commitTurn({ messages }) { for (const message of messages) stored.add(key(message)); return { status: "committed" }; },
    async maintain() { return { changed: false, bytesFreed: 0, rewrittenEntries: 0 }; },
    async dispose() {},
  }));
} };`;

const createFixture = useRuntimeProofFixture(afterEach);

it(
  "sends the user message after a model switch retires a prompt update",
  { timeout: 240_000 },
  async () => {
    const fixture = await createFixture("openclaw-engine-rebuild-", TOKEN);
    const requests: Array<{ wire: WireRequest; model: unknown }> = [];
    let ordinal = 0;
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ providers: [] }));
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const json = JSON.parse(body) as Record<string, unknown>;
        const wire = readWireRequest(api, json);
        requests.push({ wire, model: json.model });
        writeReply(api, response, { text: `ok ${requests.length}` }, ++ordinal, {
          inputTokens: Math.ceil(body.length / 4),
          listed: toolNames(wire.tools),
          ...(typeof json.model === "string" ? { model: json.model } : {}),
        });
      });
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    // The engine's history legitimately differs from the host's; only the current turn is under test.
    const assertSetting = process.env.OPENCLAW_PROMPT_CACHE_ASSERT;
    process.env.OPENCLAW_PROMPT_CACHE_ASSERT = "0";
    try {
      const origin = await listenProofProvider(server);
      const provider = buildFakeProvider(api, origin);
      await fs.writeFile(path.join(fixture.workspaceDir, "AGENTS.md"), "# Rules\n- Be brief.\n");
      const pluginDir = path.join(fixture.stateDir, ENGINE_ID);
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: ENGINE_ID,
          version: "1.0.0",
          openclaw: { extensions: ["./index.cjs"] },
        }),
      );
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({
          id: ENGINE_ID,
          activation: { onStartup: true },
          configSchema: { type: "object" },
        }),
      );
      await fs.writeFile(path.join(pluginDir, "index.cjs"), ENGINE_SOURCE);
      const cfg = fixture.config(
        provider,
        {},
        {
          plugins: {
            allow: [ENGINE_ID],
            load: { paths: [pluginDir] },
            entries: { [ENGINE_ID]: { enabled: true } },
            slots: { memory: "none", contextEngine: ENGINE_ID },
          },
          tools: { codeMode: { enabled: false } },
        },
      );
      gateway = await startGatewayWithClient({
        cfg,
        configPath: fixture.configPath,
        token: TOKEN,
        clientDisplayName: "engine-rebuild",
      });
      const client = gateway.client;
      const send = async (message: string) => {
        const started = await client.request<{ runId?: string }>("chat.send", {
          sessionKey: TARGET,
          message,
          deliver: false,
          idempotencyKey: `engine-rebuild-${++ordinal}`,
        });
        await client.request(
          "agent.wait",
          { runId: started.runId, timeoutMs: 60_000 },
          { timeoutMs: 65_000 },
        );
        await waitForGatewayActiveWork(20_000);
      };

      await send("FIRST turn");
      await fs.appendFile(path.join(fixture.workspaceDir, "AGENTS.md"), "- Prefer bullets.\n");
      await send("SECOND turn");
      expect(requests.at(-1)!.wire.text, "the second turn carries a prompt update").toContain(
        "System prompt update",
      );

      await client.request("sessions.patch", { key: TARGET, model: provider.smallModelRef });
      await send("THIRD turn after the switch");

      const third = requests.at(-1)!;
      expect(third.model).toBe(provider.smallModelRef.split("/")[1]);
      expect(third.wire.text, "the rebuild retires the earlier update").not.toContain(
        "System prompt update",
      );
      expect(latestInput(third.wire)).toContain("THIRD turn after the switch");
    } finally {
      process.env.OPENCLAW_PROMPT_CACHE_ASSERT = assertSetting;
      await fixture.close(gateway, server, true);
    }
  },
);
