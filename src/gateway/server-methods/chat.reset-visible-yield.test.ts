import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { settleSubagentRegistryPersistenceWork } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import * as sessionAdmission from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import * as agentJob from "../agent-turn/agent-job.js";
import { waitForGatewayDispatch } from "../server-in-process-dispatch.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../test-openai-responses-model.js";

type ResponseInput = {
  type?: string;
  role?: string;
  call_id?: string;
  output?: string;
  content?: string | Array<{ type: string; text?: string }>;
};
type SpawnReceipt = { status: string; runId: string; childSessionKey: string };
type WaitResult = Awaited<ReturnType<typeof agentJob.waitForAgentJob>>;
type ToolItem = {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: "completed";
};

function streamReply(
  response: ServerResponse,
  item:
    | ToolItem
    | {
        type: "message";
        id: string;
        role: "assistant";
        status: "completed";
        content: Array<{ type: "output_text"; text: string; annotations: never[] }>;
      },
) {
  const envelope = {
    id: randomUUID(),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: "gpt-5.4",
    output: [item],
    usage: { input_tokens: 64, output_tokens: 32, total_tokens: 96 },
  };
  const events: Array<{ type: string } & Record<string, unknown>> = [
    { type: "response.created", response: { ...envelope, status: "in_progress", output: [] } },
  ];
  if (item.type === "function_call") {
    events.push(
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
      {
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index: 0,
        delta: item.arguments,
      },
      {
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: 0,
        arguments: item.arguments,
      },
    );
  } else {
    events.push({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, content: [] },
    });
  }
  events.push(
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: envelope },
  );
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    events
      .map(
        (event, sequence_number) =>
          `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
      )
      .join(""),
  );
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("visible yielded session reset", () => {
  it(
    "preserves real chat yield metadata and cancels its held descendant without resuming inference",
    { timeout: 90_000 },
    async () => {
      const home = tempDirs.make("openclaw-visible-yield-reset-");
      const stateDir = path.join(home, ".openclaw");
      const workspace = path.join(home, "workspace");
      const configPath = path.join(stateDir, "openclaw.json");
      const pluginsDir = path.join(home, "bundled-plugins");
      const environment = {
        HOME: home,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_GATEWAY_TOKEN: "visible-yield-reset-test",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: pluginsDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      };
      const envSnapshot = captureEnv(Object.keys(environment));
      const fixtureAbort = new AbortController();
      const rootMarker = `fixture://reset/${randomUUID()}`;
      const requesterMarker = `fixture://reset/${randomUUID()}`;
      const childMarker = `fixture://reset/${randomUUID()}`;
      const sessionKey = `agent:main:reset-${randomUUID()}`;
      const rootCallId = "call_root";
      const childCallId = "call_child";
      const resetId = randomUUID();
      const rootFinished = createDeferred();
      const nestedOpen = createDeferred();
      const nestedClosed = createDeferred();
      const requesterWaitAttached = createDeferred();
      const requesterYielded = createDeferred();
      const requesterWaitFinished = createDeferred<WaitResult>();
      const resetAcknowledged = createDeferred<{ state?: string }>();
      const attachedChatRuns = new Set<string>();
      const handlers = new Set<Promise<void>>();
      const evidence: Array<Record<string, unknown>> = [];
      const failureTrace: Array<Record<string, unknown>> = [];
      const runAliases = new Map<string, number>();
      const fixtureStartedAt = Date.now();
      const fixtureErrors: string[] = [];
      let requester: SpawnReceipt | undefined;
      let child: SpawnReceipt | undefined;
      let requesterStep = 0;
      let rootStep = 0;
      let childRequests = 0;
      let providerRequests = 0;
      let yieldDispatched = false;
      let unexpectedInference = 0;
      let stopping = false;
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      const bound = <T>(promise: PromiseLike<T>, label: string) =>
        withTestTimeout(promise, 30_000, label);
      const snapshot = (): Array<Record<string, unknown>> =>
        [requester, child].flatMap<Record<string, unknown>>((receipt) => {
          if (!receipt) {
            return [];
          }
          const run = subagentRuns.get(receipt.runId);
          if (!run) {
            return [{ runId: receipt.runId, absent: true }];
          }
          return [
            structuredClone({
              runId: run.runId,
              taskRunId: run.taskRunId,
              generation: run.generation,
              childSessionKey: run.childSessionKey,
              requesterSessionKey: run.requesterSessionKey,
              controllerSessionKey: run.controllerSessionKey,
              requesterTurnRunId: run.requesterTurnRunId,
              requesterTurnYielded: run.requesterTurnYielded,
              execution: run.execution,
              pauseReason: run.pauseReason,
              killIntent: run.killIntent,
              killReconciliation: run.killReconciliation,
              suppressCompletionDelivery: run.suppressCompletionDelivery,
              requesterSettleWake: run.requesterSettleWake,
              cleanupHandled: run.cleanupHandled,
              cleanupCompletedAt: run.cleanupCompletedAt,
            }),
          ];
        });
      const record = (kind: string, facts: Record<string, unknown> = {}) => {
        evidence.push({ at: Date.now(), kind, ...facts, runs: snapshot() });
      };
      const originalWait = agentJob.waitForAgentJob;
      const waiterSpy = vi.spyOn(agentJob, "waitForAgentJob").mockImplementation((params) => {
        const pending = originalWait(params);
        if (params.source === "chat") {
          attachedChatRuns.add(params.runId);
          if (params.runId === requester?.runId) {
            requesterWaitAttached.resolve();
          }
        }
        record("wait-attached", { runId: params.runId, source: params.source });
        void pending.then(
          (result) => {
            record("wait-result", { runId: params.runId, source: params.source, result });
            if (params.source === "chat" && params.runId === requester?.runId) {
              requesterWaitFinished.resolve(result);
            }
          },
          (error: unknown) => {
            record("wait-rejected", { runId: params.runId, error: String(error) });
          },
        );
        return pending;
      });
      const originalInterrupt = sessionAdmission.interruptSessionWorkAdmissions;
      const admissionSpy = vi
        .spyOn(sessionAdmission, "interruptSessionWorkAdmissions")
        .mockImplementation((params) => {
          record("admission-interrupt-entry");
          const pending = originalInterrupt(params);
          void pending.then(
            (released) => {
              record("admission-interrupt-release", { released });
            },
            (error: unknown) => {
              record("admission-interrupt-rejected", { error: String(error) });
            },
          );
          return pending;
        });
      const unsubscribe = onAgentEvent((event) => {
        if (event.stream !== "lifecycle") {
          return;
        }
        record("lifecycle", {
          runId: event.runId,
          data: event.data,
        });
        if (!runAliases.has(event.runId)) {
          runAliases.set(event.runId, runAliases.size + 1);
        }
        const context = getAgentRunContext(event.runId);
        failureTrace.push({
          kind: "lifecycle",
          elapsedMs: Date.now() - fixtureStartedAt,
          run: runAliases.get(event.runId),
          owner:
            context?.sessionKey === sessionKey
              ? "root"
              : event.runId === requester?.runId
                ? "requester"
                : event.runId === child?.runId
                  ? "child"
                  : "other",
          phase:
            ["start", "finishing", "end", "error", "timeout"].find(
              (phase) => phase === event.data.phase,
            ) ?? "other",
          yielded: event.data.yielded === true,
          aborted: event.data.aborted === true,
          contextPresent: context !== undefined,
          isHeartbeat: context?.isHeartbeat,
        });
        if (event.runId === requester?.runId && event.data.yielded === true) {
          requesterYielded.resolve();
        }
      });

      function parseSpawnReceipt(input: ResponseInput[], callId: string): SpawnReceipt {
        const outputs = input.filter(
          (item) => item.type === "function_call_output" && item.call_id === callId,
        );
        expect(outputs, "one actual spawn receipt").toHaveLength(1);
        const output = expectDefined(outputs[0], "one actual spawn receipt");
        expect(output.output).toBeTypeOf("string");
        const result: SpawnReceipt = JSON.parse(
          expectDefined(output.output, "spawn receipt output"),
        );
        expect(result).toMatchObject({
          status: "accepted",
          runId: expect.any(String),
          childSessionKey: expect.any(String),
        });
        record("spawn-receipt", { callId, receipt: result });
        return result;
      }
      function tool(
        response: ServerResponse,
        callId: string,
        name: string,
        args: Record<string, unknown>,
        tools: Array<{ name: string }>,
      ) {
        expect(
          tools.some((candidate) => candidate.name === name),
          `available ${name}`,
        ).toBe(true);
        streamReply(response, {
          type: "function_call",
          id: `fc_${callId.slice(5)}`,
          call_id: callId,
          name,
          arguments: JSON.stringify(args),
          status: "completed",
        });
      }

      try {
        await Promise.all(
          [workspace, stateDir, pluginsDir].map((dir) => fs.mkdir(dir, { recursive: true })),
        );
        for (const [key, value] of Object.entries(environment)) {
          setTestEnvValue(key, value);
        }
        providerServer = createServer((request, response) => {
          const handler = (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
              chunks.push(Buffer.from(chunk));
            }
            const body: { input: ResponseInput[]; tools: Array<{ name: string }> } = JSON.parse(
              Buffer.concat(chunks).toString(),
            );
            record("provider-request", { body });
            expect(request.url).toBe("/v1/responses");
            failureTrace.push({
              kind: "provider-request",
              elapsedMs: Date.now() - fixtureStartedAt,
              request: ++providerRequests,
              rootStep,
              requesterStep,
              childRequests,
              yieldDispatched,
              resetAcknowledged: evidence.some((event) => event.kind === "reset-acknowledged"),
              stopping,
              input: body.input.map((item) => {
                const text =
                  typeof item.content === "string"
                    ? item.content
                    : item.content?.map((part) => part.text).join("\n");
                return {
                  type:
                    ["message", "function_call", "function_call_output", "reasoning"].find(
                      (type) => type === item.type,
                    ) ?? "other",
                  role:
                    ["system", "developer", "user", "assistant", "tool"].find(
                      (role) => role === item.role,
                    ) ?? "other",
                  form:
                    item.content === undefined
                      ? "absent"
                      : typeof item.content === "string"
                        ? "string"
                        : "parts",
                  textLength: text?.length,
                  markers: [
                    ...(text?.includes(rootMarker) ? ["root"] : []),
                    ...(text?.includes(requesterMarker) ? ["requester"] : []),
                    ...(text?.includes(childMarker) ? ["child"] : []),
                  ],
                };
              }),
            });
            const marked = body.input
              .filter((item) => item.role === "user")
              .map((item) => {
                const text =
                  typeof item.content === "string"
                    ? item.content
                    : item.content?.map((part) => part.text).join("\n");
                return [rootMarker, requesterMarker, childMarker].filter((marker) =>
                  text?.includes(marker),
                );
              })
              .findLast((markers) => markers.length > 0);
            expect(marked, "one fixture marker in latest marked user message").toHaveLength(1);
            const marker = marked![0];
            if (stopping) {
              throw new Error("provider called during fixture shutdown");
            }
            if (marker === requesterMarker && yieldDispatched) {
              unexpectedInference++;
              record("unexpected-requester-inference");
              response.writeHead(400, { "content-type": "application/json" }).end(
                JSON.stringify({
                  error: { message: "Fixture refuses requester inference after yield." },
                }),
              );
              return;
            }
            if (marker === rootMarker) {
              if (rootStep++ === 0) {
                tool(
                  response,
                  rootCallId,
                  "sessions_spawn",
                  {
                    task: requesterMarker,
                    label: "Yielded requester",
                    visible: true,
                    context: "isolated",
                    expectsCompletionMessage: false,
                  },
                  body.tools,
                );
                return;
              }
              expect(rootStep).toBe(2);
              requester = parseSpawnReceipt(body.input, rootCallId);
              if (attachedChatRuns.has(requester.runId)) {
                requesterWaitAttached.resolve();
              }
              streamReply(response, {
                type: "message",
                id: randomUUID(),
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "Requester started.", annotations: [] }],
              });
              return;
            }
            if (marker === requesterMarker) {
              if (requesterStep++ === 0) {
                tool(
                  response,
                  childCallId,
                  "sessions_spawn",
                  {
                    task: childMarker,
                    label: "Held child",
                    visible: true,
                    context: "isolated",
                    expectsCompletionMessage: true,
                  },
                  body.tools,
                );
                return;
              }
              expect(requesterStep).toBe(2);
              child = parseSpawnReceipt(body.input, childCallId);
              await waitForGatewayDispatch(
                "nested provider open",
                nestedOpen.promise,
                30_000,
                fixtureAbort.signal,
              );
              await waitForGatewayDispatch(
                "requester chat waiter attached",
                requesterWaitAttached.promise,
                30_000,
                fixtureAbort.signal,
              );
              yieldDispatched = true;
              tool(
                response,
                "call_yield",
                "sessions_yield",
                { message: "Wait for the nested child." },
                body.tools,
              );
              return;
            }
            expect(marker).toBe(childMarker);
            expect(++childRequests, "held nested request must not replay").toBe(1);
            response.once("close", () => {
              record("nested-stream-close", {
                writableEnded: response.writableEnded,
                fixtureStopping: stopping,
              });
              nestedClosed.resolve();
            });
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(
              `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: randomUUID(), object: "response", status: "in_progress", model: "gpt-5.4", output: [] } })}\n\n`,
            );
            record("nested-stream-open");
            nestedOpen.resolve();
          })().catch((error: unknown) => {
            if (!stopping) {
              fixtureErrors.push(String(error));
            }
            if (!response.headersSent) {
              response.writeHead(400, { "content-type": "application/json" });
            }
            response.end(JSON.stringify({ error: { message: "Fixture contract failed." } }));
          });
          handlers.add(handler);
          void handler.finally(() => handlers.delete(handler));
        });
        const server = providerServer;
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("provider did not bind loopback port");
        }
        const provider = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${address.port}/v1`);
        gateway = await startGatewayWithClient({
          configPath,
          token: environment.OPENCLAW_GATEWAY_TOKEN,
          cfg: {
            agents: {
              defaults: {
                workspace,
                skipBootstrap: true,
                heartbeat: { every: "0m" },
                model: { primary: provider.modelRef },
                models: {
                  [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
                },
                subagents: { maxSpawnDepth: 2, maxConcurrent: 4 },
              },
              entries: { main: { default: true } },
            },
            tools: {
              profile: "full",
              codeMode: false,
              allow: ["sessions_spawn", "sessions_yield"],
            },
            models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
            gateway: { auth: { mode: "token", token: environment.OPENCLAW_GATEWAY_TOKEN } },
          },
          onEvent: (event) => {
            if (event.event !== "chat") {
              return;
            }
            const payload = event.payload as {
              runId?: string;
              sessionKey?: string;
              state?: string;
            };
            if (payload.sessionKey !== sessionKey) {
              return;
            }
            if (
              payload.runId === resetId &&
              (payload.state === "final" || payload.state === "error")
            ) {
              resetAcknowledged.resolve(payload);
            } else if (payload.state === "final") {
              rootFinished.resolve();
            }
          },
        });
        const started = await gateway.client.request<{ status: string }>("chat.send", {
          sessionKey,
          message: rootMarker,
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        expect(started.status).toBe("started");
        await bound(rootFinished.promise, "root did not finish");
        await bound(
          requesterYielded.promise,
          "requester did not emit a real yield lifecycle event",
        );
        const waitResult = await bound(
          requesterWaitFinished.promise,
          "real requester chat waiter did not finish",
        );
        record("before-reset", { waitResult });
        expect
          .soft(waitResult, "chat waiter must retain actual yield metadata")
          .toMatchObject({ status: "ok", yielded: true });
        await gateway.client.request(
          "chat.send",
          { sessionKey, message: "/new", deliver: false, idempotencyKey: resetId },
          { timeoutMs: 30_000 },
        );
        const reset = await bound(resetAcknowledged.promise, "reset did not acknowledge");
        expect(reset.state).toBe("final");
        record("reset-acknowledged");
        await bound(nestedClosed.promise, "reset did not close nested provider stream");
        await bound(
          settleSubagentRegistryPersistenceWork(),
          "registry work did not settle after reset",
        );
        // The reported continuation arrived 127 ms after acknowledgement on 2026-09-10.
        // This window observes absence after synchronization with real cancellation.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1_000);
        });
        record("observation-complete");
        expect(fixtureErrors, `provider fixture failures: ${JSON.stringify(failureTrace)}`).toEqual(
          [],
        );
        expect(
          unexpectedInference,
          `requester must not reach inference after reset: ${JSON.stringify(failureTrace)}`,
        ).toBe(0);
        expect(evidence.find((event) => event.kind === "nested-stream-close")).toMatchObject({
          writableEnded: false,
          fixtureStopping: false,
        });
        const tasks = await gateway.client.request<{
          tasks: Array<{ runId: string; status: string }>;
        }>("tasks.list", { agentId: "main" });
        record("public-cancelled-tasks", { tasks });
        expect(tasks.tasks.find((task) => task.runId === requester?.runId)).toMatchObject({
          status: "cancelled",
        });
        expect(tasks.tasks.find((task) => task.runId === child?.runId)).toMatchObject({
          status: "cancelled",
        });
      } finally {
        record("fixture-cleanup-start", { fixtureErrors, unexpectedInference });
        stopping = true;
        fixtureAbort.abort();
        providerServer?.closeAllConnections();
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        if (providerServer?.listening) {
          const server = providerServer;
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
        }
        await Promise.allSettled(handlers);
        unsubscribe();
        waiterSpy.mockRestore();
        admissionSpy.mockRestore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        envSnapshot.restore();
      }
    },
  );
});
