// Real process death is required: an in-process abort cannot prove durable startup custody.
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { asRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { writeGatewayRestartIntentSync } from "../src/infra/restart-intent.js";
import { extractTextFromChatContent } from "../src/shared/chat-content.js";
import { extractAssistantPhaseText } from "../src/shared/chat-message-content.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import {
  restartEnv,
  readRestartSession,
  writeRestartPlugin,
  connectRestartClient,
  writeRestartTitle,
  restartModelConfig,
  writeRestartToolCall,
} from "./gateway-restart.test-support.js";
import { GATEWAY_RESTART_TEST_KILL_MS } from "./helpers/gateway-restart-budget.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { createDeferred, withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

type Phase = "initial" | "recovery" | "held-recovery" | "cancelled";

function createScenario(name: string) {
  return {
    name,
    key: `agent:main:shutdown-${name}`,
    request: `SHUTDOWN_TASK_${name}: complete this synthetic assignment.`,
    partial: `SHUTDOWN_PARTIAL_${name}`,
    final: `SHUTDOWN_COMPLETE_${name}`,
    phase: "initial" as Phase,
    sessionId: "",
    runId: "",
    calls: [] as Array<{ phase: Phase; input: string }>,
    partialSeen: createDeferred(),
    recoverySeen: createDeferred(),
    releaseResponse: createDeferred(),
    completed: createDeferred(),
  };
}

type Scenario = ReturnType<typeof createScenario>;

function writePartial(response: ServerResponse, scenario: Scenario, ordinal: number) {
  const id = `msg_${scenario.name}_${ordinal}`;
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  for (const event of [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id, role: "assistant", status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: id,
      output_index: 0,
      content_index: 0,
      delta: scenario.partial,
    },
  ]) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  // No EOF: only the owning Gateway's cancellation can end this generation.
}

function nodeCommand(source: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  // This fixture owns one tool process; descendant-tree cleanup has separate coverage.
  return `exec ${quote(process.execPath)} -e ${quote(source)}`;
}

function writeExec(response: ServerResponse, command: string, ordinal: number) {
  writeRestartToolCall(
    response,
    "shutdown",
    "exec",
    { command, awaitResults: true, timeoutSeconds: 120 },
    ordinal,
  );
}

async function startProvider(scenarios: Scenario[], signal: AbortSignal) {
  const toolStarted = createDeferred();
  const toolCheckpoint = createDeferred();
  const toolCancelled = createDeferred();
  const releaseToolCheckpoint = createDeferred();
  const failed = createDeferred<never>();
  const fourRecoveriesSeen = createDeferred();
  const recoveryStarts = new Set<Scenario>();
  const activeRecoveryResponses = new Map<ServerResponse, Scenario>();
  let peakRecoveryConcurrency = 0;
  void failed.promise.catch(() => {});
  let effects = 0;
  let forbiddenEffects = 0;
  let ordinal = 0;
  let origin = "";
  const reservation = await reserveTestPortListener({
    signal,
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          if (request.url === "/effect") {
            effects += 1;
            toolStarted.resolve();
            // The effect has happened, but its tool result stays unknown across shutdown.
            return;
          }
          if (request.url === "/effect-status") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ effects }));
            return;
          }
          if (request.url === "/forbidden-effect") {
            forbiddenEffects += 1;
            response.writeHead(204).end();
            return;
          }
          if (request.url === "/tool-checkpoint") {
            toolCheckpoint.resolve();
            await withinTest(releaseToolCheckpoint.promise, signal);
            response.writeHead(204).end();
            return;
          }
          if (request.url === "/tool-cancelled") {
            toolCancelled.resolve();
            response.writeHead(204).end();
            return;
          }
          expect(request.url).toBe("/v1/responses");
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          const body = asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          const tools = Array.isArray(body.tools)
            ? body.tools.flatMap((tool) =>
                isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
              )
            : [];
          if (tools.length === 0) {
            if (body.stream === false) {
              writeRestartTitle(response, "Synthetic shutdown task");
            } else {
              writeOpenAiResponsesText(response, {
                text: "Synthetic shutdown task",
                messageId: "msg_title",
                responseId: "resp_title",
              });
            }
            return;
          }
          const input = JSON.stringify(body.input);
          const scenario = scenarios.find((entry) => input.includes(entry.request));
          if (!scenario) {
            throw new Error("Provider received a task outside the synthetic shutdown scenarios");
          }
          scenario.calls.push({ phase: scenario.phase, input });
          ordinal += 1;
          expect(scenario.phase).not.toBe("cancelled");
          if (scenario.phase === "initial") {
            expect(scenario.calls).toHaveLength(1);
            if (scenario.name === "raw-tool") {
              expect(tools).toContain("exec");
              writeExec(
                response,
                nodeCommand(
                  `fetch(${JSON.stringify(`${origin}/effect`)}, {method:"POST"}).then(r=>r.text()).then(console.log)`,
                ),
                ordinal,
              );
            } else {
              writePartial(response, scenario, ordinal);
            }
            return;
          }
          expect(input).toContain("interrupted by a gateway restart");
          activeRecoveryResponses.set(response, scenario);
          response.once("close", () => activeRecoveryResponses.delete(response));
          const activeRecoveries = new Set(activeRecoveryResponses.values()).size;
          peakRecoveryConcurrency = Math.max(peakRecoveryConcurrency, activeRecoveries);
          expect(activeRecoveries).toBeLessThanOrEqual(4);
          recoveryStarts.add(scenario);
          if (recoveryStarts.size === 4) {
            fourRecoveriesSeen.resolve();
          }
          scenario.recoverySeen.resolve();
          if (scenario.phase === "held-recovery") {
            writePartial(response, scenario, ordinal);
            return;
          }
          if (scenario.name === "reset") {
            writeExec(
              response,
              nodeCommand(
                `fetch(${JSON.stringify(`${origin}/forbidden-effect`)}, {method:"POST"})`,
              ),
              ordinal,
            );
            return;
          }
          await withinTest(scenario.releaseResponse.promise, signal);
          if (scenario.name === "raw-tool") {
            const recoveryCalls = scenario.calls.filter((call) => call.phase === "recovery");
            if (recoveryCalls.length === 1) {
              expect(input).toContain("unknown outcome");
              expect(tools).toContain("exec");
              writeExec(
                response,
                nodeCommand(
                  `fetch(${JSON.stringify(`${origin}/effect-status`)}).then(r=>r.json()).then(v=>console.log("INSPECTED_EFFECTS="+v.effects))`,
                ),
                ordinal,
              );
              return;
            }
            expect(recoveryCalls).toHaveLength(2);
            expect(input).toContain("INSPECTED_EFFECTS=1");
          } else {
            // Provider replay replaces aborted partial output; custody retains the user's task.
            expect(input).toContain(scenario.request);
          }
          writeOpenAiResponsesText(response, {
            text: scenario.final,
            messageId: `msg_final_${ordinal}`,
            responseId: `resp_final_${ordinal}`,
          });
        })().catch((error: unknown) => {
          failed.reject(error);
          response.destroy(error instanceof Error ? error : undefined);
        });
      }),
  });
  origin = `http://127.0.0.1:${reservation.claim.port}`;
  return {
    baseUrl: `${origin}/v1`,
    failed: failed.promise,
    fourRecoveriesSeen: fourRecoveriesSeen.promise,
    recoveryStarts: () => [...recoveryStarts],
    peakRecoveryConcurrency: () => peakRecoveryConcurrency,
    toolStarted: toolStarted.promise,
    toolCheckpoint: toolCheckpoint.promise,
    toolCancelled: toolCancelled.promise,
    releaseToolCheckpoint: () => releaseToolCheckpoint.resolve(),
    effects: () => effects,
    forbiddenEffects: () => forbiddenEffects,
    close: () =>
      runQaGatewayFixture(
        async () => {
          releaseToolCheckpoint.resolve();
          for (const scenario of scenarios) {
            scenario.releaseResponse.resolve();
          }
          reservation.listener.closeAllConnections();
        },
        reservation.releaseListener,
        reservation.claim.release,
      ),
  };
}

it(
  "preserves unfinished task custody across process shutdown, but respects Stop and reset",
  { timeout: 180_000 },
  async (context) => {
    const { signal } = context;
    const stream = createScenario("raw-stream");
    const tool = createScenario("raw-tool");
    const stopped = createScenario("stop");
    const reset = createScenario("reset");
    const parallelA = createScenario("parallel-a");
    const parallelB = createScenario("parallel-b");
    const rawRecoveries = [stream, tool, reset, parallelA, parallelB];
    const managed = createScenario("managed");
    const killed = createScenario("killed");
    const scenarios = [...rawRecoveries, stopped, managed, killed];
    const provider = await startProvider(scenarios, signal);
    const model = buildMockOpenAiResponsesProvider(provider.baseUrl);
    const instance = await createOpenClawTestInstance({
      name: "gateway-process-shutdown-recovery",
      entrypoint: ["dist/index.js"],
      signal,
      startTimeoutMs: 120_000,
      stopTimeoutMs: 10_000,
      gracefulShutdownTimeoutMs: GATEWAY_RESTART_TEST_KILL_MS,
      env: {
        ...restartEnv,
        OPENCLAW_NO_RESPAWN: "1",
      },
    });
    context.onTestFailed(() =>
      console.error(instance.logs().replaceAll(instance.gatewayToken, "[fixture token]")),
    );
    let client: GatewayClient | undefined;
    const gate = <T>(promise: Promise<T>) =>
      withinTest(Promise.race([promise, provider.failed]), signal);
    const connect = async () => {
      client = await connectRestartClient(
        instance,
        {
          mode: "test",
          onEvent: ({ event, payload }) => {
            if (!isRecord(payload)) {
              return;
            }
            const scenario = scenarios.find((entry) => entry.key === payload.sessionKey);
            if (
              (event === "chat" && payload.state === "delta") ||
              (event === "agent" && payload.stream === "assistant")
            ) {
              scenario?.partialSeen.resolve();
            }
            if (
              event === "sessions.changed" &&
              payload.phase === "end" &&
              scenario &&
              payload.runId !== scenario.runId
            ) {
              scenario.completed.resolve();
            }
          },
        },
        signal,
      );
      await client.request("sessions.subscribe", { agentId: "main" });
    };
    const start = async (scenario: Scenario) => {
      const created = await client!.request<{ sessionId: string }>("sessions.create", {
        key: scenario.key,
        agentId: "main",
        model: model.modelRef,
        permissionMode: "full",
      });
      scenario.sessionId = created.sessionId;
      const accepted = await client!.request<{ runId: string }>(
        "agent",
        {
          agentId: "main",
          sessionKey: scenario.key,
          message: scenario.request,
          idempotencyKey: scenario.name,
          deliver: false,
          timeout: 120,
        },
        { expectFinal: false },
      );
      scenario.runId = accepted.runId;
      await gate(scenario === tool ? provider.toolStarted : scenario.partialSeen.promise);
    };
    const stopProcess = async (mode: "raw" | "managed" | "kill") => {
      const child = instance.child;
      if (!child?.pid) {
        throw new Error("Owned Gateway process unavailable");
      }
      await client?.stopAndWait();
      client = undefined;
      const closed = once(child, "close");
      if (mode === "managed") {
        expect(
          writeGatewayRestartIntentSync({
            env: instance.env,
            targetPid: child.pid,
            intent: { reason: "gateway.restart", force: true, waitMs: 100 },
          }),
        ).toBe(true);
      }
      expect(child.kill(mode === "kill" ? "SIGKILL" : "SIGTERM")).toBe(true);
      const outcome = await gate(closed);
      expect(outcome, instance.logs()).toEqual(mode === "kill" ? [null, "SIGKILL"] : [0, null]);
      return child.pid;
    };
    const readStoppedEntry = (scenario: Scenario) =>
      asRecord(readRestartSession(instance.state.agentDir(), scenario.key));
    const finish = async (scenario: Scenario) => {
      scenario.releaseResponse.resolve();
      await gate(scenario.completed.promise);
      const listed = await client!.request<SessionsListResult>("sessions.list", {
        agentId: "main",
      });
      expect(listed.sessions.find((row) => row.key === scenario.key)).toMatchObject({
        sessionId: scenario.sessionId,
        status: "done",
        hasActiveRun: false,
      });
      const history = await client!.request<{
        messages: Array<{ role: string; content?: unknown }>;
      }>("chat.history", { sessionKey: scenario.key });
      expect(
        history.messages.filter(
          (message) =>
            message.role === "user" &&
            extractTextFromChatContent(message.content)?.includes(scenario.request),
        ),
      ).toHaveLength(1);
      expect(
        history.messages.filter(
          (message) =>
            message.role === "assistant" && extractAssistantPhaseText(message) === scenario.final,
        ),
      ).toHaveLength(1);
    };
    await runQaGatewayFixture(
      async () => {
        const pluginId = "shutdown-tool-checkpoint";
        const pluginDir = instance.state.path("checkpoint-plugin");

        // The policy hook waits through cancellation; reset must revoke before its tool effect.
        await writeRestartPlugin(
          pluginDir,
          {
            id: pluginId,
            activation: { onStartup: true },
            configSchema: { type: "object", additionalProperties: false, properties: {} },
          },
          `export default {
              id: ${JSON.stringify(pluginId)},
              register(api) {
                api.on("before_tool_call", async (event, ctx) => {
                  if (ctx.sessionKey !== ${JSON.stringify(reset.key)}) return;
                  const onAbort = () => {
                    void fetch(${JSON.stringify(provider.baseUrl.replace("/v1", "/tool-cancelled"))}, {
                      method: "POST",
                    }).catch(() => {});
                  };
                  ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });
                  try {
                    if (ctx.abortSignal?.aborted) onAbort();
                    await fetch(${JSON.stringify(provider.baseUrl.replace("/v1", "/tool-checkpoint"))}, {
                      method: "POST",
                    });
                  } finally {
                    ctx.abortSignal?.removeEventListener("abort", onAbort);
                  }
                }, { matcher: ["exec"] });
              },
            };`,
          "index.mjs",
        );
        await instance.state.writeConfig({
          update: { checkOnStart: false },
          browser: { enabled: false },
          discovery: { mdns: { mode: "off" } },
          plugins: {
            enabled: true,
            allow: [pluginId],
            load: { paths: [pluginDir] },
            entries: { [pluginId]: { enabled: true } },
            slots: { memory: "none" },
          },
          ...restartModelConfig(
            model,
            instance.state.workspaceDir,
            { maxConcurrent: 8 },
            { catalogRefresh: { enabled: false } },
          ),
          tools: {
            allow: ["exec", "process"],
            exec: { mode: "full", host: "gateway" },
            codeMode: { enabled: false },
          },
          gateway: {
            mode: "local",
            bind: "loopback",
            port: instance.port,
            auth: { mode: "token", token: instance.gatewayToken },
            controlUi: { enabled: false },
          },
        });
        await instance.startGateway();
        await connect();
        await start(stream);
        await start(tool);
        await start(stopped);
        expect(await client!.request("sessions.abort", { key: stopped.key })).toMatchObject({
          status: "aborted",
        });
        expect(
          await client!.request("agent.wait", { runId: stopped.runId, timeoutMs: 60_000 }),
        ).toMatchObject({ status: "error" });
        stopped.phase = "cancelled";
        await start(reset);
        await start(parallelA);
        await start(parallelB);
        const predecessor = await stopProcess("raw");
        for (const scenario of rawRecoveries) {
          const entry = readStoppedEntry(scenario);
          expect(entry).toMatchObject({
            sessionId: scenario.sessionId,
            status: "interrupted",
            mainRestartRecovery: expect.any(Object),
          });
          expect(entry.restartRecoveryTerminalRunIds ?? []).not.toContain(scenario.runId);
          scenario.phase = "recovery";
        }
        expect(readStoppedEntry(stopped)).toMatchObject({ status: "killed" });
        const resetRevision = readStoppedEntry(reset).lifecycleRevision;
        expect(resetRevision).toBeTypeOf("string");
        await instance.startGateway();
        expect(instance.child?.pid).not.toBe(predecessor);
        await connect();
        // Four distinct turns must reach the provider while every response is held.
        await gate(provider.fourRecoveriesSeen);
        const firstRecoveries = provider.recoveryStarts();
        expect(firstRecoveries).toHaveLength(4);
        expect(provider.peakRecoveryConcurrency()).toBe(4);
        const firstFinished = firstRecoveries.find((scenario) => scenario !== reset);
        if (!firstFinished) {
          throw new Error("Expected a started recovery that is not being reset");
        }
        await finish(firstFinished);
        await gate(Promise.all(rawRecoveries.map((scenario) => scenario.recoverySeen.promise)));
        const finishing = Promise.all(
          rawRecoveries
            .filter((scenario) => scenario !== reset && scenario !== firstFinished)
            .map(finish),
        );
        void finishing.catch(() => {});
        await gate(reset.recoverySeen.promise);
        await gate(provider.toolCheckpoint);
        const resetting = client!.request<{
          ok: boolean;
          entry: { sessionId: string; lifecycleRevision: string };
        }>("sessions.reset", { key: reset.key, reason: "reset" });
        void resetting.catch(() => {});
        await gate(provider.toolCancelled);
        provider.releaseToolCheckpoint();
        const resetResult = await gate(resetting);
        expect(resetResult).toMatchObject({
          ok: true,
          entry: { sessionId: reset.sessionId, lifecycleRevision: expect.any(String) },
        });
        expect(resetResult.entry.lifecycleRevision).not.toBe(resetRevision);
        expect(resetResult.entry).not.toHaveProperty("mainRestartRecovery");
        reset.phase = "cancelled";
        await gate(finishing);
        const afterReset = await client!.request<SessionsListResult>("sessions.list", {
          agentId: "main",
        });
        const replacement = afterReset.sessions.find((row) => row.key === reset.key);
        expect(replacement).toMatchObject({ sessionId: reset.sessionId, hasActiveRun: false });
        expect(afterReset.sessions.find((row) => row.key === stopped.key)).toMatchObject({
          status: "killed",
          hasActiveRun: false,
        });
        expect(provider.effects()).toBe(1);
        expect(provider.forbiddenEffects()).toBe(0);
        await start(managed);
        await stopProcess("managed");
        expect(readStoppedEntry(managed)).toMatchObject({
          status: "interrupted",
          sessionId: managed.sessionId,
        });
        managed.phase = "held-recovery";
        await instance.startGateway();
        await connect();
        await gate(managed.recoverySeen.promise);
        // Kill both an admitted original turn and a turn already recovering from restart.
        await start(killed);
        await stopProcess("kill");
        managed.phase = "recovery";
        killed.phase = "recovery";
        await instance.startGateway();
        await connect();
        await gate(Promise.all([finish(managed), finish(killed)]));
        expect(stopped.calls).toHaveLength(1);
        expect(reset.calls).toHaveLength(2);
        expect(managed.calls.map((call) => call.phase)).toEqual([
          "initial",
          "held-recovery",
          "recovery",
        ]);
        expect(killed.calls.map((call) => call.phase)).toEqual(["initial", "recovery"]);
        for (const scenario of [parallelA, parallelB]) {
          expect(scenario.calls.map((call) => call.phase)).toEqual(["initial", "recovery"]);
        }
        expect(provider.peakRecoveryConcurrency()).toBe(4);
        expect(provider.effects()).toBe(1);
        expect(provider.forbiddenEffects()).toBe(0);
      },
      async () => {
        provider.releaseToolCheckpoint();
        for (const scenario of scenarios) {
          scenario.releaseResponse.resolve();
        }
        await client?.stopAndWait();
      },
      () => instance.cleanup(),
      () => provider.close(),
    );
  },
);
