// Real CLI Gateway + authenticated synthetic channel ingress; no controller or model-run mocks.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { json } from "node:stream/consumers";
import { expect, it, onTestFinished } from "vitest";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

const CHANNEL = "rollover-proof";
const FIRST = "TRIGGER_CLEANUP_FAULT_167078";
const NEXT = "AFTER_RESET_PROBE_167078";

it(
  "a shipped Gateway accepts /new and another channel turn after typing cleanup throws",
  { timeout: 240_000 },
  async ({ signal }) => {
    const requests: string[] = [];
    const model = await startOpenAiResponsesModelServer({
      modelId: "rollover-proof",
      bindError: "rollover model fixture did not bind",
      onRequest: async (req, res) => {
        requests.push(JSON.stringify(await json(req)));
        writeOpenAiResponsesText(res, {
          text: "ROLLOVER_PROOF_REPLY_" + requests.length,
          messageId: "msg_rollover_" + requests.length,
          responseId: "resp_rollover_" + requests.length,
        });
      },
    });
    onTestFinished(model.close);
    const profile = "rollover-proof-" + randomUUID();
    const ingressToken = randomUUID();
    const pluginDir = path.join(process.cwd(), ".openclaw", "tmp", profile);
    await fs.mkdir(pluginDir, { recursive: true });
    onTestFinished(() => fs.rm(pluginDir, { recursive: true, force: true }));
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: CHANNEL,
        channels: [CHANNEL],
        activation: { onStartup: true },
        configSchema: { type: "object", additionalProperties: false },
      }),
    );
    await fs.writeFile(path.join(pluginDir, "index.ts"), authoredPlugin());
    const config = createOpenAiResponsesModelConfig({
      baseUrl: model.baseUrl,
      providerId: "rollover-proof",
      modelId: "rollover-proof",
      reasoning: false,
      toolProfile: "minimal",
    });
    config.plugins = {
      ...config.plugins,
      load: { paths: [pluginDir] },
      entries: { [CHANNEL]: { enabled: true } },
    };
    config.discovery = { mdns: { mode: "off" } };
    config.agents = {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        modelPolicy: { allow: ["rollover-proof/rollover-proof"] },
      },
    };
    const gateway = await createOpenClawTestInstance({
      name: profile,
      entrypoint: ["scripts/run-node.mjs", "--profile", profile],
      config,
      signal,
      env: {
        OPENCLAW_PROFILE: profile,
        ROLLOVER_PROOF_INGRESS_TOKEN: ingressToken,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_AGENT_RUNTIME: undefined,
      },
    });
    onTestFinished(() => gateway.cleanup());
    await gateway.state.writeConfig({
      ...config,
      gateway: {
        port: gateway.port,
        auth: { mode: "token", token: gateway.gatewayToken },
        controlUi: { enabled: false },
      },
      logging: { level: "debug", file: path.join(gateway.stateDir, "gateway.log") },
    });
    const prepared = await gateway.cli(["--help"], { timeoutMs: 150_000 });
    expect(prepared.code, prepared.stderr).toBe(0);
    await gateway.startGateway();
    // Only preparation uses the CLI; channel input enters its actual attributed HTTP transport.
    const send = async (message: string, expectedStatus = 200) => {
      const response = await fetch("http://127.0.0.1:" + gateway.port + "/rollover-proof", {
        method: "POST",
        headers: { "content-type": "application/json", "x-proof-token": ingressToken },
        body: JSON.stringify({ sender: "proof-sender", message }),
        signal,
      }).catch(async (error: unknown) => {
        throw new Error(
          "Channel request failed: " +
            String(error) +
            "\n" +
            (await gateway.diagnose()) +
            "\n" +
            gateway.logs(),
          { cause: error },
        );
      });
      const body = (await response.json()) as {
        delivered: string[];
        cleanupCalls: number;
        typingStarts: number;
        error?: string;
      };
      expect(response.status, JSON.stringify(body) + "\n" + gateway.logs()).toBe(expectedStatus);
      return body;
    };
    // The fault may fail its original ingress request, but must not poison the next reset.
    const first = await send(FIRST, 500);
    expect(first.error).toBe("Error: rollover-proof typing cleanup failure");
    expect(requests).toHaveLength(1);
    expect(first.typingStarts).toBeGreaterThan(0);
    expect(first.cleanupCalls).toBeGreaterThan(0);
    const reset = await send("/new");
    expect(reset.error, gateway.logs()).toBeUndefined();
    const next = await send(NEXT);
    expect(next.error, gateway.logs()).toBeUndefined();
    expect(next.delivered.some((text) => text.includes("ROLLOVER_PROOF_REPLY_"))).toBe(true);
    const afterReset = requests.findLast((request) => request.includes(NEXT));
    expect(afterReset).toBeDefined();
    expect(afterReset).not.toContain(FIRST);
    expect(gateway.logs()).toContain("reply operation after-clear callback failed:");
    expect(gateway.logs()).not.toContain("timed out draining work before reply session rollover");
    console.log(
      JSON.stringify({
        proof: "shipped-gateway-rollover-cleanup",
        modelRequests: requests.length,
        typingStarts: first.typingStarts,
        faultCleanupCalls: first.cleanupCalls,
        resetDelivered: reset.delivered,
        nextDelivered: next.delivered,
        callbackWarningObserved: true,
        freshContextObserved: true,
        profileIsolated: true,
      }),
    );
  },
);

function authoredPlugin() {
  return `export default {
  id: "rollover-proof",
  register(api) {
    const id = "rollover-proof";
    api.registerChannel({ plugin: {
      id, meta: { id, label: "Rollover proof", selectionLabel: "Rollover proof", docsPath: "/plugins", blurb: "Disposable synthetic channel" },
      capabilities: { chatTypes: ["direct"] },
      config: { listAccountIds: () => ["default"], resolveAccount: () => ({ accountId: "default", enabled: true }), isConfigured: () => true, isEnabled: () => true },
    }});
    api.registerHttpRoute({ path: "/rollover-proof", auth: "plugin", handler: async (req, res) => {
      if (req.method !== "POST" || req.headers["x-proof-token"] !== process.env.ROLLOVER_PROOF_INGRESS_TOKEN) {
        res.statusCode = 401; res.end(); return true;
      }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (input.sender !== "proof-sender") { res.statusCode = 403; res.end(); return true; }
      const delivered = []; let cleanupCalls = 0; let typingStarts = 0;
      try {
        await api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          cfg: api.config,
          ctx: { Body: input.message, RawBody: input.message, CommandBody: input.message,
            From: id + ":proof-sender", To: id + ":bot", SenderId: "proof-sender",
            SenderName: "Synthetic proof sender", ChatType: "direct", AccountId: "default",
            SessionKey: "agent:main:rollover-proof:direct:proof-sender",
            MessageSid: "proof-" + Date.now(), Provider: id, Surface: id,
            OriginatingChannel: id, OriginatingTo: "proof-sender", CommandAuthorized: true },
          dispatcherOptions: {
            deliver: async (payload) => { if (payload.text) delivered.push(payload.text); },
            onReplyStart: () => { typingStarts++; },
            onCleanup: () => { cleanupCalls++; if (input.message === "TRIGGER_CLEANUP_FAULT_167078") throw new Error("rollover-proof typing cleanup failure"); },
          },
          toolsAllow: [],
        });
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ delivered, cleanupCalls, typingStarts }));
      } catch (error) {
        res.statusCode = 500; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ delivered, cleanupCalls, typingStarts, error: String(error) }));
      }
      return true;
    }});
  },
};`;
}
