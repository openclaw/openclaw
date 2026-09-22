// Real provider discovery through the admitted OpenClaw runner; no response or tool-choice mocks.
import fs from "node:fs/promises";
import path from "node:path";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { runEmbeddedAgent } from "./embedded-agent-runner.js";
import {
  createContextEngineLogicalTurnLease,
  type ContextEngineLogicalTurnLease,
} from "./harness/context-engine-logical-turn.js";
import { collectProviderApiKeys } from "./live-auth-keys.js";
import { isLiveTestEnabled, logLiveProgress } from "./live-test-helpers.js";
import { SessionManager } from "./sessions/session-manager.js";

const liveOpenAiKey = collectProviderApiKeys("openai")[0];
const describeLive = isLiveTestEnabled() && liveOpenAiKey ? describe : describe.skip;
const PLUGIN_ID = "live-tool-search-fixture";
const TARGET = "warehouse_release_receipt";
const DIRECT_ONLY = "warehouse_service_status";
const DENIED = "warehouse_release_receipt_admin";
const CONTROLS = ["tool_search", "tool_describe", "tool_call"];
const MAX_REQUESTS = 10;
const LANES = ["direct", "default", "tools", "code", "directory"] as const;
const TARGET_ORDER_FIELD = "releaseOrderReference";

type Lane = (typeof LANES)[number];
type RequestMetrics = {
  toolNames: string[];
  toolBytes: number;
  payloadBytes: number;
};
type Receipt = {
  tool: string;
  callId: string;
  orderId: string;
  nonce: string;
  executedAtMs: number;
};

// Different argument names and enums make these genuinely distinct schemas, not
// thirty aliases of the target. The fixture is intentionally read-only.
const departments = (
  "invoices returns suppliers shipments bins pallets docks drivers routes customs insurance " +
  "weights labels barcodes batches expiry temperature humidity inventory reservations allocations " +
  "picklists packing inspections damages transfers replenishment forecasts schedules equipment maintenance audits"
).split(" ");
const distractors = departments.map((department) => ({
  name: `warehouse_${department}_lookup`,
  label: `Warehouse ${department} lookup`,
  description: `Look up warehouse ${department} records and their current status.`,
  parameters: {
    type: "object",
    properties: {
      [`${department}Id`]: {
        type: "string",
        description: `Identifier of the ${department} record.`,
      },
      view: { type: "string", enum: [`${department}_summary`, `${department}_history`] },
    },
    required: [`${department}Id`],
    additionalProperties: false,
  },
}));
const requiredDefinitions = [
  {
    name: TARGET,
    label: "Warehouse release receipt",
    description:
      "Retrieve the current release receipt for a warehouse order, including its exact verification code.",
    parameters: {
      type: "object",
      properties: {
        [TARGET_ORDER_FIELD]: { type: "string", description: "Warehouse order identifier." },
      },
      required: [TARGET_ORDER_FIELD],
      additionalProperties: false,
    },
  },
  {
    name: DIRECT_ONLY,
    label: "Warehouse service status",
    description: "Read warehouse service availability. This does not return order receipts.",
    catalogMode: "direct-only",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: DENIED,
    label: "Warehouse administrative release receipt",
    description:
      "Retrieve an administrative release receipt and verification code for a warehouse order.",
    parameters: {
      type: "object",
      properties: { administrativeOrderId: { type: "string" } },
      required: ["administrativeOrderId"],
      additionalProperties: false,
    },
  },
];

async function runLane(
  lane: Lane,
  distractorCount: number,
  apiKey: string,
): Promise<RequestMetrics> {
  const definitions = [...distractors.slice(0, distractorCount), ...requiredDefinitions];
  const sessionId = `tool-search-live-${distractorCount}-${lane}`;
  return await withOpenClawTestState(
    { label: sessionId, env: { OPENAI_API_KEY: apiKey } },
    async (state) => {
      const pluginDir = state.path("fixture-plugin");
      const pluginFile = path.join(pluginDir, "index.cjs");
      const receiptPath = state.path("executions.jsonl");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(receiptPath, "");
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({
          id: PLUGIN_ID,
          configSchema: { type: "object", properties: {}, additionalProperties: false },
          contracts: { tools: definitions.map((tool) => tool.name) },
        }),
      );
      // The nonce is created only INSIDE execution, never in config, source,
      // schemas or the prompt. No file/shell tools are allowed to read receipts.
      await fs.writeFile(
        pluginFile,
        `
const fs = require("node:fs");
const { randomBytes } = require("node:crypto");
module.exports = {
  id: ${JSON.stringify(PLUGIN_ID)},
  register(api) {
    for (const definition of ${JSON.stringify(definitions)}) {
      api.registerTool({
        ...definition,
        async execute(callId, args) {
          const executedAtMs = Date.now();
          const nonce = "RECEIPT_" + randomBytes(24).toString("hex");
          fs.appendFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({
            tool: definition.name, callId, orderId: args[${JSON.stringify(TARGET_ORDER_FIELD)}], nonce, executedAtMs,
          }) + "\\n");
          if (definition.name !== ${JSON.stringify(TARGET)}) {
            return { content: [{ type: "text", text: "No release receipt from this lookup." }], details: {} };
          }
          const result = { orderId: args[${JSON.stringify(TARGET_ORDER_FIELD)}], verificationCode: nonce };
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        },
      });
    }
  },
};
`,
      );
      const modelId = process.env.OPENCLAW_LIVE_RESPONSES_MODEL?.trim() || "gpt-5.4-mini";
      const config = {
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              auth: "api-key",
              baseUrl: "https://api.openai.com/v1",
              timeoutSeconds: 90,
              models: [
                {
                  id: modelId,
                  name: modelId,
                  reasoning: true,
                  input: ["text"],
                  contextWindow: 200_000,
                  maxTokens: 4096,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
        agents: {
          list: [{ id: "main", default: true, workspace: state.workspaceDir }],
          defaults: {
            skipBootstrap: true,
            models: { [`openai/${modelId}`]: { params: { transport: "sse" } } },
          },
        },
        tools: {
          codeMode: false,
          ...(lane === "default"
            ? {}
            : { toolSearch: lane === "direct" ? false : { enabled: true, mode: lane } }),
          deny: [DENIED],
        },
        plugins: {
          allow: ["openai", PLUGIN_ID],
          load: { paths: [pluginFile] },
          entries: { [PLUGIN_ID]: { enabled: true } },
          slots: { memory: "none" },
        },
      } satisfies OpenClawConfig;
      await state.writeConfig(config);
      const cache = createPluginCache();
      try {
        return await withPluginCache(cache, async () => {
          const sessionManager = SessionManager.inMemory(state.workspaceDir);
          const requests: RequestMetrics[] = [];
          const host = getAiTransportHost();
          const runStartedAtMs = performance.now();
          const admission = prepareSystemAgentRunAdmission(
            config,
            sessionId,
            "main",
            "tool-search-live",
          );
          let lease: ContextEngineLogicalTurnLease | undefined;
          let firstRequestBody = "";
          let firstRequestAtMs: number | undefined;
          let firstRequestToTargetMs: number | undefined;
          let wireFailure: Error | undefined;
          let completed = false;
          configureAiTransportHost({
            ...host,
            buildModelFetch: (...args) => {
              const fetchModel = host.buildModelFetch(...args) ?? globalThis.fetch;
              return async (input, init) => {
                firstRequestAtMs ??= Date.now();
                if (requests.length >= MAX_REQUESTS) {
                  wireFailure = new Error(
                    `Live tool-search ${lane} exceeded ${MAX_REQUESTS} provider requests`,
                  );
                  throw wireFailure;
                }
                if (typeof init?.body !== "string") {
                  throw new Error("Live tool-search expected a JSON Responses request");
                }
                const request = JSON.parse(init.body) as ResponseCreateParamsStreaming;
                const toolNames = (request.tools ?? []).flatMap((tool) =>
                  tool.type === "function" ? [tool.name] : [],
                );
                requests.push({
                  toolNames,
                  toolBytes: Buffer.byteLength(JSON.stringify(request.tools ?? [])),
                  payloadBytes: Buffer.byteLength(init.body),
                });
                if (requests.length === 1) {
                  firstRequestBody = init.body;
                }
                try {
                  expect(request.tool_choice === undefined || request.tool_choice === "auto").toBe(
                    true,
                  );
                  expect(
                    init.body.includes(DENIED),
                    "denied decoy leaked into provider payload",
                  ).toBe(false);
                  expect(toolNames).toContain(DIRECT_ONLY);
                  const expected =
                    lane === "direct"
                      ? definitions.filter((tool) => tool.name !== DENIED).map((tool) => tool.name)
                      : [DIRECT_ONLY, ...(lane === "code" ? ["tool_search_code"] : CONTROLS)];
                  expect(toolNames.toSorted()).toEqual(expected.toSorted());
                  if (requests.length === 1 && lane !== "direct") {
                    expect(
                      init.body.includes(TARGET_ORDER_FIELD),
                      "deferred input schema leaked into the initial provider payload",
                    ).toBe(false);
                  }
                } catch (error) {
                  // The runner may turn fetch errors into reply payloads. Preserve
                  // the original assertion so a surface regression remains legible.
                  wireFailure = error instanceof Error ? error : new Error(String(error));
                  throw error;
                }
                // Observe the genuine wire request, forwarding its bytes and stream unchanged.
                // Log only aggregate metrics, never request bodies, headers or credentials.
                return fetchModel(input, init);
              };
            },
          });
          try {
            lease = await createContextEngineLogicalTurnLease({
              identity: { runId: sessionId, sessionId },
              config,
              agentDir: state.agentDir(),
              workspaceDir: state.workspaceDir,
            });
            const result = await runEmbeddedAgent({
              preparedRunAdmission: admission,
              contextEngineLogicalTurnLease: lease,
              agentId: "main",
              sessionId,
              sessionKey: `agent:main:${sessionId}`,
              sessionManager,
              sessionPersistence: "detached",
              agentDir: state.agentDir(),
              workspaceDir: state.workspaceDir,
              config,
              provider: "openai",
              model: modelId,
              agentHarnessRuntimeOverride: "openclaw",
              modelSelectionLocked: true,
              codeModeOverride: false,
              thinkLevel: "off",
              // Include the decoy here so tools.deny, not an omission, must remove it.
              toolsAllow: definitions.map((tool) => tool.name),
              requireWorkspaceOnly: true,
              prompt:
                "What is the exact current release-receipt verification code for warehouse order WH-4821? " +
                "Look it up in the warehouse service and report the order identifier and code verbatim. " +
                "Do not guess or substitute another order.",
              timeoutMs: 180_000,
              runId: sessionId,
              cleanupBundleMcpOnRunEnd: true,
            });
            if (wireFailure) {
              throw wireFailure;
            }
            const receipts = (await fs.readFile(receiptPath, "utf8"))
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as Receipt);
            expect(receipts.some((receipt) => receipt.tool === DENIED)).toBe(false);
            const targetReceipts = receipts.filter((receipt) => receipt.tool === TARGET);
            expect(targetReceipts.length, `live ${lane} target execution count`).toBe(1);
            const receipt = targetReceipts[0];
            if (!receipt) {
              throw new Error(`Live tool-search ${lane} did not execute the target`);
            }
            if (firstRequestAtMs === undefined) {
              throw new Error("Target executed without an observed provider request");
            }
            firstRequestToTargetMs = receipt.executedAtMs - firstRequestAtMs;
            expect(firstRequestToTargetMs).toBeGreaterThanOrEqual(0);
            expect(receipt.orderId).toBe("WH-4821");
            expect(receipt.callId).toBeTruthy();
            expect(receipt.nonce).toMatch(/^RECEIPT_[0-9a-f]{48}$/);
            expect(firstRequestBody.includes(receipt.nonce), "nonce leaked before execution").toBe(
              false,
            );
            const reply = result.payloads?.map((payload) => payload.text ?? "").join("\n") ?? "";
            expect(reply.includes(receipt.nonce), "reply must preserve the executed nonce").toBe(
              true,
            );
            expect(reply).toContain("WH-4821");
            expect(result.payloads?.some((payload) => payload.isError)).toBe(false);
            const messages = sessionManager
              .getBranch()
              .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
            const toolResults = messages.filter((message) => message.role === "toolResult");
            expect(
              toolResults.some((message) =>
                JSON.stringify(message.content).includes(receipt.nonce),
              ),
            ).toBe(true);
            expect(
              JSON.stringify(messages).includes(DENIED),
              "denied decoy entered transcript",
            ).toBe(false);
            if (lane !== "direct") {
              // Full target schema is deferred; capability names in the directory are allowed.
              expect(requests[0]?.toolNames).not.toContain(TARGET);
              const bridge = result.meta.agentMeta?.bridgeCalls;
              // A directory name is already discoverable. Valid calls may use it
              // immediately or recover its input signature from a contract error.
              // Require actual bridged execution, not a particular model strategy.
              if (lane !== "directory") {
                expect(bridge?.call).toBeGreaterThan(0);
              }
            }
            expect(requests.length).toBeGreaterThanOrEqual(2);
            expect(result.meta.agentMeta?.assistantTurns).toBeGreaterThanOrEqual(2);
            completed = true;
            logLiveProgress(
              JSON.stringify({
                suite: "tool-search",
                lane,
                distractorCount,
                assistantTurns: result.meta.agentMeta?.assistantTurns,
                bridgeCalls: result.meta.agentMeta?.bridgeCalls,
                inputContractRecovery: toolResults.some(
                  (message) =>
                    message.isError && JSON.stringify(message.content).includes(TARGET_ORDER_FIELD),
                ),
              }),
            );
            const firstRequest = requests[0];
            if (!firstRequest) {
              throw new Error(`Live tool-search ${lane} made no provider requests`);
            }
            return firstRequest;
          } finally {
            // Exclude fixture creation and teardown; include run admission/lease setup.
            const wallElapsedMs = Math.round(performance.now() - runStartedAtMs);
            configureAiTransportHost(host);
            admission.close();
            await lease?.dispose();
            logLiveProgress(
              JSON.stringify({
                suite: "tool-search",
                lane,
                distractorCount,
                completed,
                wallElapsedMs,
                firstRequestToTargetMs,
                providerRequests: requests.length,
                requests: requests.map(({ toolNames, toolBytes, payloadBytes }) => ({
                  toolCount: toolNames.length,
                  toolBytes,
                  payloadBytes,
                })),
              }),
            );
          }
        });
      } finally {
        const cleanup = await retirePluginCache(cache);
        expect(cleanup.failures).toEqual([]);
      }
    },
  );
}

describeLive("tool-search real-provider default-readiness probe", { concurrent: false }, () => {
  const baselines = new Map<number, RequestMetrics>();
  it.each(
    [0, distractors.length].flatMap((distractorCount) =>
      LANES.map((lane) => ({ lane, distractorCount })),
    ),
  )(
    "$lane with $distractorCount distractors: discovers and executes without forced tool choice",
    async ({ lane, distractorCount }) => {
      const apiKey = liveOpenAiKey;
      if (!apiKey) {
        throw new Error(
          "Live tool-search requires OpenAI credentials (OPENAI_API_KEY or OPENCLAW_LIVE_OPENAI_KEY); no live coverage ran.",
        );
      }
      const firstRequest = await runLane(lane, distractorCount, apiKey);
      if (lane === "direct") {
        baselines.set(distractorCount, firstRequest);
      } else {
        const direct = baselines.get(distractorCount);
        if (!direct) {
          throw new Error(`Direct baseline with ${distractorCount} distractors must pass first`);
        }
        // Small catalogs can cost more behind discovery controls. Measure that
        // overhead instead of presupposing that default enablement would help.
        logLiveProgress(
          JSON.stringify({
            suite: "tool-search-comparison",
            lane,
            distractorCount,
            firstToolCountDelta: firstRequest.toolNames.length - direct.toolNames.length,
            firstToolBytesDelta: firstRequest.toolBytes - direct.toolBytes,
            firstPayloadBytesDelta: firstRequest.payloadBytes - direct.payloadBytes,
          }),
        );
        if (distractorCount > 0) {
          expect(firstRequest.toolNames.length).toBeLessThan(direct.toolNames.length);
          expect(firstRequest.toolBytes).toBeLessThan(direct.toolBytes);
        }
      }
    },
    210_000,
  );
});
