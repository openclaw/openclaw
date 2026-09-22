// Real-Gateway regression for #153271: stopping an ownerless yielded parent
// must close its held child and stay terminal across restart.
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
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../helpers/openai-responses-sse.js";
import { createDeferred } from "../../../helpers/promise.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const PARENT_MODEL = "mock-openai/qa-yield-parent";
const CHILD_MODEL = "mock-openai/qa-yield-child";
const PARENT_KEY = "agent:qa:main";
const CONVERSATION = { id: "yield-cancel-restart", kind: "direct" as const };
const INITIAL_PROMPT = "Spawn the held cancellation worker and yield for its completion.";
const FRESH_PROMPT = "After cancellation recovery, reply with the fresh-turn marker.";
const CHILD_LABEL = "qa-yield-cancel-held-child";
const CHILD_MARKER = "QA-YIELD-CANCEL-LATE-CHILD";
const WAKE_MARKER = "QA-YIELD-CANCEL-UNEXPECTED-WAKE";
const FRESH_MARKER = "QA-YIELD-CANCEL-FRESH-OK";

type ProviderInput = {
  type?: string;
  role?: string;
  call_id?: string;
  output?: string;
};

type ProviderRequest = {
  model?: string;
  input?: ProviderInput[];
};

type SpawnReceipt = {
  status?: string;
  runId?: string;
};

type TaskRow = {
  runId?: string;
  title?: string;
  status?: string;
};

function writeToolCall(
  response: ServerResponse,
  name: string,
  callId: string,
  args: Record<string, unknown>,
): void {
  const item = {
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  };
  writeOpenAiResponsesSse(response, [
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
        id: `resp_${callId}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

function readToolOutput(body: ProviderRequest, callId: string): SpawnReceipt | undefined {
  const raw = body.input?.find(
    (item) => item.type === "function_call_output" && item.call_id === callId,
  )?.output;
  return raw ? (JSON.parse(raw) as SpawnReceipt) : undefined;
}

async function startProofProvider() {
  const spawnCompleted = createDeferred<SpawnReceipt>();
  const releaseYieldCall = createDeferred();
  const firstChildStarted = createDeferred();
  const firstChildClosed = createDeferred();
  const releaseFirstChild = createDeferred();
  const requests: Array<{ kind: "parent" | "child" | "title"; afterCancel: boolean }> = [];
  const errors: unknown[] = [];
  let afterCancel = false;
  let childRequestCount = 0;
  let sequence = 0;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: ["qa-yield-parent", "qa-yield-child"].map((id) => ({ id, object: "model" })),
          }),
        );
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProviderRequest;
      const inputText = JSON.stringify(body.input ?? []);
      const developerText = JSON.stringify(
        body.input?.filter((item) => item.role === "developer" || item.role === "system") ?? [],
      );
      const kind = developerText.includes("Generate a concise session title")
        ? "title"
        : body.model === "qa-yield-child"
          ? "child"
          : "parent";
      requests.push({ kind, afterCancel });
      sequence += 1;
      const reply = (text: string) =>
        writeOpenAiResponsesText(response, {
          text,
          messageId: `msg_yield_cancel_${sequence}`,
          responseId: `resp_yield_cancel_${sequence}`,
        });

      if (kind === "title") {
        reply("Yield cancellation recovery proof");
        return;
      }
      if (kind === "child") {
        childRequestCount += 1;
        if (childRequestCount > 1) {
          reply(CHILD_MARKER);
          return;
        }
        firstChildStarted.resolve();
        const closed = once(response, "close").then(() => {
          firstChildClosed.resolve();
        });
        await Promise.race([releaseFirstChild.promise, closed]);
        if (!response.destroyed) {
          reply(CHILD_MARKER);
        }
        return;
      }
      if (inputText.includes(FRESH_PROMPT)) {
        reply(FRESH_MARKER);
        return;
      }
      if (afterCancel) {
        reply(WAKE_MARKER);
        return;
      }
      const spawn = readToolOutput(body, "call_qa_yield_cancel_spawn");
      if (spawn) {
        spawnCompleted.resolve(spawn);
        await releaseYieldCall.promise;
        writeToolCall(response, "sessions_yield", "call_qa_yield_cancel_yield", {});
        return;
      }
      writeToolCall(response, "sessions_spawn", "call_qa_yield_cancel_spawn", {
        task: `Wait for release, then return exactly ${CHILD_MARKER}.`,
        label: CHILD_LABEL,
        mode: "run",
        model: CHILD_MODEL,
        expectsCompletionMessage: true,
      });
    })().catch((error: unknown) => {
      errors.push(error);
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
    throw new Error("yield cancellation proof provider did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    errors,
    requests,
    spawnCompleted: spawnCompleted.promise,
    firstChildStarted: firstChildStarted.promise,
    firstChildClosed: firstChildClosed.promise,
    releaseYieldCall: () => releaseYieldCall.resolve(),
    markCancelCommitted: () => {
      afterCancel = true;
    },
    get childRequestCount() {
      return childRequestCount;
    },
    stop: async () => {
      releaseYieldCall.resolve();
      releaseFirstChild.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function configureProof(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    logging: { ...config.logging, level: "debug" },
    tools: { ...config.tools, toolSearch: { enabled: false } },
    agents: {
      ...config.agents,
      defaults: { ...config.agents?.defaults, model: { primary: PARENT_MODEL } },
      entries: {
        ...config.agents?.entries,
        qa: { ...config.agents?.entries?.qa, model: { primary: PARENT_MODEL } },
      },
    },
  };
}

describe("yielded parent cancellation across Gateway restart", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "yield cancellation proof cleanup failed");
    }
  });

  it("keeps operator Stop terminal after the held child closes and the Gateway restarts", async () => {
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
      command: {
        executablePath: process.execPath,
        argsPrefix: ["dist/index.js"],
        cwd: REPO_ROOT,
        usePackagedPlugins: true,
      },
      providerBaseUrl: `${provider.baseUrl}/v1`,
      providerMode: "mock-openai",
      primaryModel: PARENT_MODEL,
      alternateModel: CHILD_MODEL,
      transport,
      transportBaseUrl: bus.baseUrl,
      controlUiEnabled: false,
      mutateConfig: configureProof,
    });
    await transport.waitReady({ gateway });
    const parentEnded = createDeferred<{ runId: string }>();
    const observer = await connectGatewayClient({
      url: gateway.wsUrl,
      token: gateway.token,
      scopes: ["operator.admin", "operator.read", "operator.write"],
      onEvent: (event) => {
        if (event.event !== "sessions.changed" || !event.payload) {
          return;
        }
        const payload = event.payload as {
          sessionKey?: unknown;
          phase?: unknown;
          runId?: unknown;
        };
        if (
          payload.sessionKey === PARENT_KEY &&
          payload.phase === "end" &&
          typeof payload.runId === "string"
        ) {
          parentEnded.resolve({ runId: payload.runId });
        }
      },
    });
    cleanups.push(() => disconnectGatewayClient(observer));
    await observer.request("sessions.subscribe", {});

    await transport.sendInbound({
      accountId: "default",
      conversation: CONVERSATION,
      senderId: CONVERSATION.id,
      text: INITIAL_PROMPT,
    });
    const spawn = await provider.spawnCompleted;
    await provider.firstChildStarted;
    expect(spawn).toMatchObject({ status: "accepted" });
    expect(spawn.runId).toBeTypeOf("string");

    provider.releaseYieldCall();
    const { runId: parentRunId } = await parentEnded.promise;
    const yielded = (await gateway.call(
      "agent.wait",
      { runId: parentRunId, timeoutMs: 30_000 },
      { timeoutMs: 35_000 },
    )) as { status?: string; livenessState?: string; stopReason?: string };
    expect(yielded).toMatchObject({ status: "ok", livenessState: "paused" });

    const stop = (await gateway.call("sessions.abort", {
      key: PARENT_KEY,
      clearQueued: true,
    })) as { ok?: boolean; status?: string; abortedRunId?: string | null };
    expect(stop).toMatchObject({ ok: true, status: "aborted", abortedRunId: null });
    provider.markCancelCommitted();
    await provider.firstChildClosed;

    const beforeRestartTasks = (await gateway.call("tasks.list", {
      agentId: "qa",
      limit: 100,
    })) as { tasks?: TaskRow[] };
    const cancelledTask = beforeRestartTasks.tasks?.find((task) => task.title === CHILD_LABEL);
    expect(cancelledTask).toMatchObject({ runId: spawn.runId, status: "cancelled" });

    await gateway.restartAfterStateMutation(async () => {});

    await transport.sendInbound({
      accountId: "default",
      conversation: CONVERSATION,
      senderId: CONVERSATION.id,
      text: FRESH_PROMPT,
    });
    await state.waitFor({
      kind: "message-text",
      direction: "outbound",
      textIncludes: FRESH_MARKER,
      timeoutMs: 60_000,
    });

    const afterRestartTasks = (await gateway.call("tasks.list", {
      agentId: "qa",
      limit: 100,
    })) as { tasks?: TaskRow[] };
    const retainedTask = afterRestartTasks.tasks?.find((task) => task.title === CHILD_LABEL);
    await gateway.stop();
    const outbound = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound" && !message.deleted);
    console.log(
      JSON.stringify({
        phase: "gateway-yielded-parent-cancel-restart",
        stop,
        yielded,
        cancelledTask,
        retainedTask,
        childRequestCount: provider.childRequestCount,
        requests: provider.requests,
        outbound: outbound.map((message) => message.text),
      }),
    );
    expect(provider.errors).toEqual([]);
    expect(provider.childRequestCount).toBe(1);
    expect(retainedTask).toMatchObject({ runId: spawn.runId, status: "cancelled" });
    expect(outbound.filter((message) => message.text.includes(FRESH_MARKER))).toHaveLength(1);
    expect(
      outbound.filter(
        (message) => message.text.includes(CHILD_MARKER) || message.text.includes(WAKE_MARKER),
      ),
    ).toHaveLength(0);
  }, 180_000);
});
