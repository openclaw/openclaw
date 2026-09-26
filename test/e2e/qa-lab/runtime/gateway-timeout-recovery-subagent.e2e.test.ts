import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  createQaGatewayChild,
  startQaBusServer,
} from "../../../../extensions/qa-lab/api.js";
import { writeOpenAiResponsesSse as writeSse } from "../../../helpers/openai-responses-sse.js";
import { createDeferred, withTestTimeout } from "../../../helpers/promise.js";

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

function buildAssistantEvents(text: string): SseEvent[] {
  const sequence = ++responseSequence;
  const responseId = `resp_qa_timeout_recovery_${sequence}`;
  const itemId = `msg_qa_timeout_recovery_${sequence}`;
  const part = { type: "output_text", text, annotations: [] };
  const item = {
    type: "message",
    id: itemId,
    role: "assistant",
    status: "completed",
    content: [part],
  };
  const position = { item_id: itemId, output_index: 0, content_index: 0 };
  return [
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        created_at: Math.floor(Date.now() / 1_000),
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, content: [], status: "in_progress" },
    },
    {
      type: "response.content_part.added",
      ...position,
      part: { ...part, text: "" },
    },
    { type: "response.output_text.delta", ...position, delta: text },
    { type: "response.output_text.done", ...position, text },
    { type: "response.content_part.done", ...position, part },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 64, output_tokens: 24, total_tokens: 88 },
      },
    },
  ];
}

function buildToolCallEventsWithArgs(name: string, args: Record<string, unknown>): SseEvent[] {
  const sequence = ++responseSequence;
  const responseId = `resp_qa_timeout_recovery_tool_${sequence}`;
  const itemId = `fc_qa_timeout_recovery_${sequence}`;
  const callId = `call_qa_timeout_recovery_${sequence}`;
  const argumentsText = JSON.stringify(args);
  const item = {
    type: "function_call",
    id: itemId,
    call_id: callId,
    name,
    arguments: argumentsText,
  };
  return [
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        created_at: Math.floor(Date.now() / 1_000),
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: itemId,
      output_index: 0,
      delta: argumentsText,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: itemId,
      output_index: 0,
      name,
      arguments: argumentsText,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 64, output_tokens: 16, total_tokens: 80 },
      },
    },
  ];
}

async function streamAssistantReply(
  response: ServerResponse,
  text: string,
  release: Promise<void>,
) {
  const closed = once(response, "close");
  response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
  for (const event of withUsage(buildAssistantEvents(text), 20)) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.type === "response.created") {
      // Successful requests wait on lifecycle facts. Provider progress keeps
      // only the deliberately silent parent on the real idle deadline.
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

function withUsage(events: SseEvent[], inputTokens: number): SseEvent[] {
  return events.map((event) => {
    if (event.type !== "response.completed" || !event.response) {
      return event;
    }
    return {
      ...event,
      response: {
        ...event.response,
        usage: { input_tokens: inputTokens, output_tokens: 8, total_tokens: inputTokens + 8 },
      },
    };
  });
}

async function startProofProvider() {
  const proof: {
    parentContinuationStartedAt?: number;
    childReleasedAt?: number;
    compactionStartedAt?: number;
    compactionReleasedAt?: number;
  } = {};
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
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const inputText = JSON.stringify(body.input ?? body);
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      // A distinct configured model identifies child requests without matching
      // the worker task also present in the parent's tool-call history.
      if (body.model === CHILD_MODEL.split("/")[1]) {
        if (!childRequestSeen) {
          childRequestSeen = true;
          if (await streamAssistantReply(response, CHILD_MARKER, compactionStarted.promise)) {
            proof.childReleasedAt = performance.now();
          }
        } else {
          // Follow-up model calls must not overwrite the original worker's
          // completion time used to prove the recovery window.
          writeSse(response, withUsage(buildAssistantEvents(CHILD_MARKER), 20));
        }
        return;
      }
      // Compaction serializes history into tool-free summary requests; their
      // quoted tool calls are not a fresh request to spawn another worker.
      if (!Array.isArray(body.tools) || body.tools.length === 0) {
        // Split-turn context has its own format; the retained suffix owns the pending ask.
        const summary = inputText.includes("This is the PREFIX of a turn")
          ? TURN_PREFIX_SUMMARY
          : COMPACTION_SUMMARY;
        // Multi-stage compaction can request more summaries. Keep the first
        // request's overlap evidence paired, just like the original child run.
        if (proof.compactionStartedAt !== undefined) {
          writeSse(response, withUsage(buildAssistantEvents(summary), 20));
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
        // Compaction changes history representation. Do not interpret missing
        // tool-output items as a request to spawn again or invent a child reply.
        const hasChildCompletion =
          inputText.includes("Agent steering queue items arrived since your last turn.") &&
          inputText.includes("qa-timeout-recovery-child") &&
          inputText.includes(CHILD_MARKER);
        writeSse(
          response,
          withUsage(
            buildAssistantEvents(
              hasChildCompletion ? CHILD_MARKER : "QA-TIMEOUT-RECOVERY-PARENT-OK",
            ),
            20,
          ),
        );
        return;
      }
      if (!inputText.includes(PROMPT)) {
        writeSse(response, withUsage(buildAssistantEvents("QA-TIMEOUT-RECOVERY-ANNOUNCE-OK"), 20));
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
          withUsage(
            buildToolCallEventsWithArgs("sessions_spawn", {
              task: `Subagent terminal reply QA worker: visible. Return exactly ${CHILD_MARKER}.`,
              label: "qa-timeout-recovery-child",
              thread: false,
              mode: "run",
              model: CHILD_MODEL,
            }),
            90_000,
          ),
        );
        return;
      }
      if (!inputText.includes(RECOVERY_PROMPT)) {
        writeSse(response, withUsage(buildAssistantEvents(PARENT_READY), 90_000));
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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("proof provider did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    compactionStarted: compactionStarted.promise,
    releaseCompaction: () => compactionRelease.resolve(),
    proof,
    stop: async () => {
      compactionStarted.resolve();
      compactionRelease.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

function withTimeoutConfig(config: OpenClawConfig): OpenClawConfig {
  const provider = config.models?.providers?.["mock-openai"];
  if (!provider) {
    throw new Error("mock-openai provider missing from QA config");
  }
  return {
    ...config,
    // The synthetic provider tests timeout recovery, not deferred tool discovery.
    tools: { ...config.tools, codeMode: false, toolSearch: false },
    agents: {
      ...config.agents,
      // The alternate model identifies the child, not a parent fallback.
      defaults: {
        ...config.agents?.defaults,
        model: { primary: MODEL },
        compaction: {
          ...config.agents?.defaults?.compaction,
          // Leave an older prefix to compact in this tiny synthetic transcript.
          keepRecentTokens: 1,
        },
      },
      entries: {
        ...config.agents?.entries,
        qa: { ...config.agents?.entries?.qa, model: { primary: MODEL } },
      },
    },
    // Exercise recoverable model silence, not the terminal whole-run deadline.
    models: {
      ...config.models,
      providers: { ...config.models?.providers, "mock-openai": { ...provider, timeoutSeconds: 4 } },
    },
  };
}

describe("Gateway timeout recovery subagent delivery", () => {
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
      useRepoCli: true,
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
    const readChildTasks = async () => {
      const listing = (await gateway.call("tasks.list", { agentId: "qa", limit: 100 })) as {
        tasks?: Array<Record<string, unknown>>;
      };
      return listing.tasks?.filter((entry) => entry.title === "qa-timeout-recovery-child");
    };
    const sendInbound = (text: string) =>
      transport.sendInbound({
        accountId: "default",
        conversation: CONVERSATION,
        senderId: CONVERSATION.id,
        text,
      });
    // Compaction preserves the latest three turns locally. An older real
    // conversation prefix is required to exercise model-backed summarization.
    for (let turn = 1; turn <= 4; turn += 1) {
      const before = state.getSnapshot().messages.filter((m) => m.direction === "outbound").length;
      await sendInbound(`Record timeout-recovery setup turn ${turn}. Acknowledge this setup.`);
      await transport.waitForOutbound({
        conversation: CONVERSATION,
        sinceIndex: before,
        textIncludes: "QA-TIMEOUT-RECOVERY-ANNOUNCE-OK",
        timeoutMs: 90_000,
      });
    }
    const sinceIndex = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound").length;
    await sendInbound(PROMPT);
    await transport.waitForOutbound({
      conversation: CONVERSATION,
      sinceIndex,
      textIncludes: PARENT_READY,
      timeoutMs: 90_000,
    });
    // Spawning is a committed side effect and cannot be replayed after timeout.
    // Recover the next turn while the already-started child is still running.
    await sendInbound(RECOVERY_PROMPT);
    const completionDeadline = performance.now() + 90_000;
    const remainingMs = () => Math.max(1, completionDeadline - performance.now());
    const completion = await withTestTimeout(
      (async () => {
        await provider.compactionStarted;
        // Capture the child's terminal result inside recovery before the retry
        // successor can start. All barriers share the original completion budget.
        await expect
          .poll(readChildTasks, { timeout: remainingMs() })
          .toEqual([expect.objectContaining({ status: "completed" })]);
        provider.releaseCompaction();
        return await transport.waitForOutbound({
          conversation: CONVERSATION,
          sinceIndex,
          textIncludes: CHILD_MARKER,
          timeoutMs: remainingMs(),
        });
      })(),
      remainingMs(),
      "Timed out waiting for child completion during parent timeout recovery",
    );
    expect(completion.accountId).toBe("default");
    expect(provider.proof.parentContinuationStartedAt).toBeTypeOf("number");
    expect(provider.proof.childReleasedAt).toBeTypeOf("number");
    expect(provider.proof.compactionStartedAt).toBeTypeOf("number");
    expect(provider.proof.compactionReleasedAt).toBeTypeOf("number");
    expect(provider.proof.compactionStartedAt!).toBeLessThan(provider.proof.childReleasedAt!);
    expect(provider.proof.childReleasedAt!).toBeLessThan(provider.proof.compactionReleasedAt!);
    expect(gateway.logs()).toContain("attempting compaction before retry");
    expect(gateway.logs()).toContain("compaction succeeded");
    const tasks = await readChildTasks();
    expect(tasks).toHaveLength(1);
    const task = tasks?.[0];
    expect(task?.runId).toBeTypeOf("string");
    expect(task?.taskId).toBeTypeOf("string");
    // Read completion through the serving Gateway's durable task projection.
    // The terminal reply can precede its delivery-state commit.
    await expect
      .poll(
        async () => {
          const result = (await gateway.call("tasks.get", { taskId: task?.taskId })) as {
            task: Record<string, unknown>;
          };
          return result.task;
        },
        { timeout: 10_000 },
      )
      .toMatchObject({ status: "completed", deliveryStatus: "delivered" });
    const matching = state
      .getSnapshot()
      .messages.filter(
        (message) =>
          message.direction === "outbound" &&
          !message.deleted &&
          message.text.includes(CHILD_MARKER),
      );
    expect(matching, JSON.stringify(matching)).toHaveLength(1);
    console.log(
      JSON.stringify({
        phase: "gateway-timeout-recovery-subagent",
        stateDir: gateway.runtimeEnv.OPENCLAW_STATE_DIR,
        childRunId: task?.runId,
        outboundCompletionCount: matching.length,
        childReleasedAt: provider.proof.childReleasedAt,
        compactionReleasedAt: provider.proof.compactionReleasedAt,
      }),
    );
  }, 180_000);
});
