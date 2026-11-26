import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { seedQaSessionTranscript } from "../../../../extensions/qa-lab/test-api.js";
import { createTrackedProvider } from "../../../../src/gateway/test-helpers.tracked-provider.js";
import { respondJson } from "../../../helpers/gateway-integration-fixtures.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { runQaGatewayTestFixture } from "../../../helpers/qa-gateway-test-lifetime.js";
import { messageText } from "./agent-session.test-support.js";
import { type GatewayChatHistory, sendChat, waitForRun } from "./gateway-recovery.test-support.js";
import { nativeModel, writeNativeCompletion } from "./native-provider-proof-fixture.js";

const contextWindow = 32_768;
const maxTokens = 2_048;
const modelId = "fork-local";
const model = `mock-openai/${modelId}`;
const parent = "agent:qa:dashboard:fork-proof-parent";
const child = "agent:qa:dashboard:fork-proof-child";
const oldReceipt = "VaultSlipRaven91";
const bulk = "RetiredLedgerCrate85";
const decision = "CobaltTrellis49";
const question = "What was the QA canary code we chose?";

type WireRequest = {
  messages: Array<{ role: string; content: unknown }>;
  tools: unknown[];
  max_tokens?: number;
  max_completion_tokens?: number;
};

it(
  "continues an oversized chat fork from the recent decision on its first provider request",
  { timeout: 120_000 },
  async (context) => {
    // Real archived transcript content, not inflated usage metadata. Detect leaked rows even
    // if clipping stripped both labels around the ledger.
    const rows = new Set(
      Array.from({ length: 2_800 }, (_, i) =>
        createHash("sha256").update(`retired-ledger-row:${i}`).digest("hex"),
      ),
    );
    let first: { raw: string; body: WireRequest } | undefined;
    const provider = createTrackedProvider((raw, response, request) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        return respondJson(response, { data: [{ id: modelId, object: "model" }] });
      }
      expect([request.method, request.url]).toEqual(["POST", "/v1/chat/completions"]);
      const body: WireRequest = JSON.parse(raw);
      first ??= { raw, body }; // Never skip a compaction request and inspect a later retry.
      // A deterministic reader of the received text, not model inference.
      const code = /the QA canary code is (\w+)/u.exec(
        body.messages.map(messageText).join("\n"),
      )?.[1];
      writeNativeCompletion(response, "fork-reply", modelId, code ?? "No decision in the request.");
    });
    const owner = createQaGatewayChild();
    await runQaGatewayTestFixture(
      context,
      async () => {
        const baseUrl = await provider.listen();
        const gateway = await owner.start({
          repoRoot: process.cwd(),
          providerBaseUrl: baseUrl,
          transportBaseUrl: "http://127.0.0.1",
          providerMode: "mock-openai",
          primaryModel: model,
          alternateModel: model,
          forcedRuntime: "openclaw",
          controlUiEnabled: false,
          mutateConfig: (cfg) => ({
            ...cfg,
            plugins: { allow: ["openai"], slots: { memory: "none" } },
            agents: {
              ...cfg.agents,
              defaults: {
                ...cfg.agents?.defaults,
                contextTokens: contextWindow,
                skills: [],
                skipBootstrap: true,
                heartbeat: { every: "0m" },
                models: { [model]: { params: { maxTokens } } },
              },
            },
            models: {
              mode: "replace",
              providers: {
                "mock-openai": {
                  api: "openai-completions",
                  baseUrl,
                  auth: "none",
                  request: { allowPrivateNetwork: true },
                  models: [nativeModel(modelId, { contextWindow, maxTokens })],
                },
              },
            },
            tools: { allow: ["read"], codeMode: { enabled: false } },
          }),
        });
        const now = Date.now();
        const history = [
          `Retired receipt: ${oldReceipt}.`,
          "The historical receipt is filed.",
          `Archived ledger: ${bulk}\n${[...rows].join(" ")}\nEnd of ${bulk}.`,
          "Ledger archived.",
          `Final routing decision: the QA canary code is ${decision}.`,
          "That is the routing decision for the handoff.",
        ];
        await gateway.restartAfterStateMutation(() =>
          seedQaSessionTranscript(
            { gateway },
            {
              sessionId: randomUUID(),
              sessionKey: parent,
              updatedAt: now,
              messages: history.map((text, i) => ({
                role: i % 2 === 0 ? "user" : "assistant",
                text,
                timestamp: now - history.length + i,
              })),
            },
          ),
        );
        await gateway.call("sessions.create", {
          agentId: "qa",
          key: child,
          // Title generation is independent model work, not a continuation of this child.
          label: "Fork proof child",
          parentSessionKey: parent,
          fork: true,
        });
        expect(first).toBeUndefined();
        const sent = await sendChat(gateway, child, question);
        expect(await waitForRun(gateway, sent.runId)).toMatchObject({ status: "ok" });
        expect.assert(first, "no model request was received");
        const { raw, body } = first;
        const current = body.messages.findIndex(
          (m) => m.role === "user" && messageText(m).includes(question),
        );
        expect(
          current,
          JSON.stringify(
            body.messages.map((m) => ({ role: m.role, text: messageText(m).slice(0, 90) })),
          ),
        ).toBeGreaterThan(0);
        expect(messageText(body.messages[current])).not.toContain(decision);
        expect(
          body.messages
            .slice(0, current)
            .some((m) => m.role === "user" && messageText(m).includes(decision)),
        ).toBe(true);
        expect(
          body.messages.some(
            (m) => ["system", "developer"].includes(m.role) && messageText(m).trim(),
          ),
        ).toBe(true);
        expect(body.tools.length).toBeGreaterThan(0);
        expect(raw.includes(oldReceipt) || raw.includes(bulk)).toBe(false);
        expect(raw.match(/[a-f0-9]{64}/gu)?.some((row) => rows.has(row)) ?? false).toBe(false);
        expect(body.max_completion_tokens ?? body.max_tokens).toBe(maxTokens);
        // One token per UTF-8 byte bounds this byte-level fixture. Count the entire wire envelope
        // (instructions and tool schemas included); this is not measured provider usage.
        expect(Buffer.byteLength(raw) + maxTokens).toBeLessThanOrEqual(contextWindow);
        const delivered = (await gateway.call("chat.history", {
          sessionKey: child,
          limit: 8,
        })) as GatewayChatHistory;
        expect(messageText(delivered.messages?.findLast((m) => m.role === "assistant"))).toBe(
          decision,
        );
      },
      () => stopQaGatewayFixture(owner),
      () => provider.close(),
    );
  },
);
