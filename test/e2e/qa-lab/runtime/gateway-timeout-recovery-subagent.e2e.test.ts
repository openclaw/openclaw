import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import { afterEach, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  createQaGatewayChild,
  startQaBusServer,
} from "../../../../extensions/qa-lab/api.js";
import { closeHttpServer, readRequestText } from "../../../helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesSse as writeSse } from "../../../helpers/openai-responses-sse.js";
import { createDeferred, withTestTimeout } from "../../../helpers/promise.js";
import { readQaSubagentRuns } from "../../../helpers/qa-subagent-runs.js";
import { listenLoopback } from "./gateway-recovery.test-support.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const MODEL = "mock-openai/gpt-5.6-luna";
const CHILD_MODEL = "mock-openai/gpt-5.6-luna-alt";
const CONVERSATION = { id: "timeout-recovery", kind: "direct" as const };
const PROMPT =
  "Subagent terminal reply QA check: visible. Spawn one native worker, then finish the parent turn without waiting. Do not use ACP.";
const CHILD_MARKER = "QA-TIMEOUT-RECOVERY-CHILD-OK";
const PARENT_READY = "QA-TIMEOUT-RECOVERY-PARENT-READY";
const RECOVERY_PROMPT = "Continue while the existing worker finishes. Do not spawn another worker.";
const COMPACTION_SUMMARY = [
  "## Decisions\nOne native worker has already been spawned.",
  "## Open TODOs\nDeliver the existing worker's terminal reply once.",
  "## Constraints/Rules\nDo not spawn another worker or use ACP.",
  `## Pending user asks\n${RECOVERY_PROMPT}`,
  "## Exact identifiers\nqa-timeout-recovery-child",
].join("\n\n");
const TURN_PREFIX_SUMMARY = [
  `## Original Request\n${RECOVERY_PROMPT}`,
  "## Early Progress\nThe existing worker is still running.",
  "## Context for Suffix\nDeliver qa-timeout-recovery-child once; do not spawn another worker.",
].join("\n\n");
type SseEvent = {
  type: string;
  response?: Record<string, unknown>;
  [key: string]: unknown;
};

let responseSequence = 0;

function responseEvents(
  id: string,
  item: Record<string, unknown>,
  inputTokens: number,
): SseEvent[] {
  return [
    {
      type: "response.created",
      response: {
        id,
        object: "response",
        status: "in_progress",
        output: [],
        created_at: Math.floor(Date.now() / 1_000),
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item:
        item.type === "message"
          ? { ...item, content: [], status: "in_progress" }
          : { ...item, arguments: "" },
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: inputTokens, output_tokens: 8, total_tokens: inputTokens + 8 },
      },
    },
  ];
}

function buildAssistantEvents(text: string, inputTokens = 20): SseEvent[] {
  const sequence = ++responseSequence;
  const itemId = `msg_qa_timeout_recovery_${sequence}`;
  const item = {
    type: "message",
    id: itemId,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return responseEvents(`resp_qa_timeout_recovery_${sequence}`, item, inputTokens);
}

function buildToolCallEventsWithArgs(name: string, args: Record<string, unknown>): SseEvent[] {
  const sequence = ++responseSequence;
  const itemId = `fc_qa_timeout_recovery_${sequence}`;
  const argumentsText = JSON.stringify(args);
  const item = {
    type: "function_call",
    id: itemId,
    call_id: `call_qa_timeout_recovery_${sequence}`,
    name,
    arguments: argumentsText,
  };
  return responseEvents(`resp_qa_timeout_recovery_tool_${sequence}`, item, 90_000);
}

async function streamAssistantReply(
  response: ServerResponse,
  text: string,
  release: Promise<void>,
) {
  const closed = once(response, "close");
  response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
  for (const event of buildAssistantEvents(text)) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.type === "response.created") {
      // Keep successful requests alive; only the silent parent should hit its idle deadline.
      const heartbeat = setInterval(() => {
        response.write(`data: ${JSON.stringify({ ...event, type: "response.in_progress" })}\n\n`);
      }, 500);
      try {
        await Promise.race([release, closed]);
      } finally {
        clearInterval(heartbeat);
      }
      if (response.destroyed) {
        return false;
      }
    }
  }
  response.end("data: [DONE]\n\n");
  return true;
}

async function startProofProvider() {
  const proof: {
    parentContinuationStartedAt?: number;
    childReleasedAt?: number;
    compactionStartedAt?: number;
    compactionReleasedAt?: number;
    recoveredParentReplies: string[];
  } = { recoveredParentReplies: [] };
  let parentContinuationSeen = false;
  let childRequestSeen = false;
  const compactionStarted = createDeferred();
  const compactionRelease = createDeferred();
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-luna", object: "model" }] }));
        return;
      }
      const body = JSON.parse(await readRequestText(request)) as Record<string, unknown>;
      const inputText = JSON.stringify(body.input ?? body);
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      // Model identity distinguishes the child from its task in the parent's history.
      if (body.model === CHILD_MODEL.split("/")[1]) {
        if (!childRequestSeen) {
          childRequestSeen = true;
          if (await streamAssistantReply(response, CHILD_MARKER, compactionStarted.promise)) {
            proof.childReleasedAt = performance.now();
          }
        } else {
          // Preserve the original worker's completion time for the overlap proof.
          writeSse(response, buildAssistantEvents(CHILD_MARKER));
        }
        return;
      }
      // Tool-free summaries quote old calls; they must not spawn another worker.
      if (!Array.isArray(body.tools) || body.tools.length === 0) {
        // Split-turn context has its own format; the retained suffix owns the pending ask.
        const summary = inputText.includes("This is the PREFIX of a turn")
          ? TURN_PREFIX_SUMMARY
          : COMPACTION_SUMMARY;
        // Multi-stage summaries must preserve the first request's overlap timestamps.
        if (proof.compactionStartedAt !== undefined) {
          writeSse(response, buildAssistantEvents(summary));
          return;
        }
        proof.compactionStartedAt = performance.now();
        compactionStarted.resolve();
        if (await streamAssistantReply(response, summary, compactionRelease.promise)) {
          proof.compactionReleasedAt = performance.now();
        }
        return;
      }
      if (parentContinuationSeen) {
        // Compacted history must neither respawn the child nor fabricate its completion.
        // The "awaiting delivery" roster is status, not delivery; only the completion event counts.
        const currentInput = JSON.stringify(Array.isArray(body.input) ? body.input.at(-1) : body);
        const hasChildCompletion =
          currentInput.includes("[Internal task completion event]") &&
          currentInput.includes("qa-timeout-recovery-child") &&
          currentInput.includes(CHILD_MARKER);
        const reply = hasChildCompletion ? CHILD_MARKER : "QA-TIMEOUT-RECOVERY-PARENT-OK";
        proof.recoveredParentReplies.push(reply);
        writeSse(response, buildAssistantEvents(reply));
        return;
      }
      if (!inputText.includes(PROMPT)) {
        writeSse(response, buildAssistantEvents("QA-TIMEOUT-RECOVERY-ANNOUNCE-OK"));
        return;
      }
      if (!inputText.includes("function_call_output")) {
        expect(body.tools).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "function", name: "sessions_spawn" }),
          ]),
        );
        writeSse(
          response,
          buildToolCallEventsWithArgs("sessions_spawn", {
            task: `Subagent terminal reply QA worker: visible. Return exactly ${CHILD_MARKER}.`,
            label: "qa-timeout-recovery-child",
            thread: false,
            mode: "run",
            model: CHILD_MODEL,
          }),
        );
        return;
      }
      if (!inputText.includes(RECOVERY_PROMPT)) {
        writeSse(response, buildAssistantEvents(PARENT_READY, 90_000));
        return;
      }
      parentContinuationSeen = true;
      proof.parentContinuationStartedAt = performance.now();
      await once(response, "close");
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });
  const baseUrl = await listenLoopback(server, "proof provider did not bind");
  return {
    baseUrl,
    compactionStarted: compactionStarted.promise,
    releaseCompaction: () => compactionRelease.resolve(),
    proof,
    stop: async () => {
      compactionStarted.resolve();
      compactionRelease.resolve();
      await closeHttpServer(server);
    },
  };
}

function withTimeoutConfig(config: OpenClawConfig): OpenClawConfig {
  const provider = config.models?.providers?.["mock-openai"];
  if (!provider) {
    throw new Error("mock-openai provider missing from QA config");
  }
  // Exercise model silence, not a terminal run deadline or deferred tool discovery.
  provider.timeoutSeconds = 4;
  config.tools = { ...config.tools, codeMode: false, toolSearch: false };
  const agents = (config.agents ??= {});
  const defaults = (agents.defaults ??= {});
  defaults.model = { primary: MODEL }; // The alternate model identifies the child, not a fallback.
  defaults.compaction = { ...defaults.compaction, keepRecentTokens: 1 };
  agents.entries = { ...agents.entries, qa: { ...agents.entries?.qa, model: { primary: MODEL } } };
  return config;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

it("delivers a child completion once while parent timeout recovery is active", async () => {
  const provider = await startProofProvider();
  cleanups.push(() => provider.stop());
  const state = createQaBusState();
  const transport = createQaChannelTransport(state);
  const bus = await startQaBusServer({ state });
  cleanups.push(() => bus.stop());
  const owner = createQaGatewayChild();
  cleanups.push(async () => expect((await owner.stop()).errors).toEqual([]));
  const gateway = await owner.start({
    repoRoot: REPO_ROOT,
    useRepoCli: false,
    providerBaseUrl: `${provider.baseUrl}/v1`,
    providerMode: "mock-openai",
    primaryModel: MODEL,
    alternateModel: CHILD_MODEL,
    transport,
    transportBaseUrl: bus.baseUrl,
    controlUiEnabled: false,
    mutateConfig: withTimeoutConfig,
  });
  await transport.waitReady({ gateway });
  const readChildRuns = () =>
    readQaSubagentRuns(gateway.runtimeEnv).filter(
      (entry) => entry.label === "qa-timeout-recovery-child",
    );
  // The completion stays owed on its controller reservation while recovery holds the requester.
  const readChildHandoff = () =>
    readChildRuns().map((run) => ({
      execution: run.execution.status,
      outcome: run.execution.outcome?.status,
      delivery: run.delivery?.status,
    }));
  const sendInbound = (text: string) =>
    transport.sendInbound({
      accountId: "default",
      conversation: CONVERSATION,
      senderId: CONVERSATION.id,
      text,
    });
  const outbound = () => state.getSnapshot().messages.filter((m) => m.direction === "outbound");
  const waitOutbound = (sinceIndex: number, textIncludes: string, timeoutMs = 90_000) =>
    transport.waitForOutbound({ conversation: CONVERSATION, sinceIndex, textIncludes, timeoutMs });
  // Four turns leave an older prefix beyond the three retained turns for model compaction.
  for (let turn = 1; turn <= 4; turn += 1) {
    const before = outbound().length;
    await sendInbound(`Record timeout-recovery setup turn ${turn}. Acknowledge this setup.`);
    await waitOutbound(before, "QA-TIMEOUT-RECOVERY-ANNOUNCE-OK");
  }
  const sinceIndex = outbound().length;
  await sendInbound(PROMPT);
  await waitOutbound(sinceIndex, PARENT_READY);
  // Recover the next turn; the committed spawn cannot be replayed.
  await sendInbound(RECOVERY_PROMPT);
  const completionDeadline = performance.now() + 90_000;
  const remainingMs = () => Math.max(1, completionDeadline - performance.now());
  let phase = "compaction start";
  const completion = await withTestTimeout(
    (async () => {
      await provider.compactionStarted;
      phase = "child completion handoff";
      // Hold compaction until the child is terminal with its delivery still owed.
      await expect
        .poll(readChildHandoff, { timeout: remainingMs() })
        .toEqual([{ execution: "terminal", outcome: "ok", delivery: "pending" }]);
      provider.releaseCompaction();
      phase = "child completion outbound";
      return await waitOutbound(sinceIndex, CHILD_MARKER, remainingMs());
    })(),
    remainingMs(),
    "Timed out waiting for child completion during parent timeout recovery",
  ).catch((error: unknown) => {
    // All barriers share one budget; name the stalled one with its evidence.
    const evidence = JSON.stringify({
      phase,
      provider: provider.proof,
      child: readChildHandoff(),
      gatewayLogTail: redactSensitiveText(gateway.logs().replaceAll(gateway.token, "[redacted]"), {
        mode: "tools",
      }).slice(-8_000),
    });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} ${evidence}`, { cause: error });
  });
  expect(completion.accountId).toBe("default");
  expect(provider.proof.parentContinuationStartedAt).toBeTypeOf("number");
  expect(provider.proof.childReleasedAt).toBeTypeOf("number");
  expect(provider.proof.compactionStartedAt).toBeTypeOf("number");
  expect(provider.proof.compactionReleasedAt).toBeTypeOf("number");
  expect(provider.proof.compactionStartedAt!).toBeLessThan(provider.proof.childReleasedAt!);
  expect(provider.proof.childReleasedAt!).toBeLessThan(provider.proof.compactionReleasedAt!);
  // Prompt assembly no longer drains owed results; the reservation's own turn delivers it once.
  expect(provider.proof.recoveredParentReplies).toEqual([
    "QA-TIMEOUT-RECOVERY-PARENT-OK",
    CHILD_MARKER,
  ]);
  expect(gateway.logs()).toContain("attempting compaction before retry");
  expect(gateway.logs()).toContain("compaction succeeded");
  const runs = readChildRuns();
  expect(runs).toHaveLength(1);
  const run = runs[0]!;
  expect(run.runId).toBeTypeOf("string");
  // The terminal reply may precede the native outbox delivery commit.
  await expect.poll(readChildRuns, { timeout: 10_000 }).toEqual([
    expect.objectContaining({
      execution: expect.objectContaining({
        status: "terminal",
        outcome: expect.objectContaining({ status: "ok" }),
      }),
      delivery: expect.objectContaining({ status: "delivered" }),
    }),
  ]);
  const matching = outbound().filter(
    (message) => !message.deleted && message.text.includes(CHILD_MARKER),
  );
  expect(matching, JSON.stringify(matching)).toHaveLength(1);
}, 180_000);
