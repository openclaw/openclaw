// Managed process replacement proves recovery of a child whose requester already finished.
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { asRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { openNodeSqliteDatabase } from "../src/infra/node-sqlite.js";
import { writeGatewayRestartIntentSync } from "../src/infra/restart-intent.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { createDeferred, withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const PARENT_KEY = "agent:main:quiet-child-restart";
const PARENT_REQUEST = "Start the quiet restart regression child, then finish immediately.";
const PARENT_FINAL = "QUIET_CHILD_STARTED";
const CHILD_TASK = "QUIET_CHILD_RESTART_CHECKPOINT: finish the retained assignment.";
const RECOVERY_FINAL = "QUIET_CHILD_RECOVERY_RECONCILED";

function writeSpawn(response: ServerResponse, name: string, ordinal: number) {
  const args = {
    taskName: "quiet_restart_child",
    task: CHILD_TASK,
    context: "isolated",
    cleanup: "delete",
    expectsCompletionMessage: false,
  };
  const item = {
    type: "function_call",
    id: `fc_spawn_${ordinal}`,
    call_id: `call_spawn_${ordinal}`,
    name,
    arguments: JSON.stringify(name === "tool_call" ? { id: "sessions_spawn", args } : args),
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_spawn_${ordinal}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

async function startProvider(signal: AbortSignal) {
  const childPending = createDeferred();
  const recovery = createDeferred<string>();
  const checkpoint = createDeferred<{ runId: string; prompt: string }>();
  const releaseCheckpoint = createDeferred();
  const releaseRecovery = createDeferred();
  const failed = createDeferred<never>();
  void failed.promise.catch(() => {});
  const calls: Array<{ kind: "parent" | "child" | "recovery"; input: string }> = [];
  let parentCalls = 0;
  const reservation = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          const body = asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          if (request.url === "/recovery-checkpoint") {
            expect(typeof body.runId).toBe("string");
            expect(typeof body.prompt).toBe("string");
            checkpoint.resolve({ runId: String(body.runId), prompt: String(body.prompt) });
            await withinTest(releaseCheckpoint.promise, signal);
            response.writeHead(204).end();
            return;
          }
          expect(request.url).toBe("/v1/responses");
          const tools = Array.isArray(body.tools)
            ? body.tools.flatMap((tool) =>
                isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
              )
            : [];
          const text = (value: string) =>
            writeOpenAiResponsesText(response, {
              text: value,
              messageId: `msg_${calls.length}_${parentCalls}`,
              responseId: `resp_${calls.length}_${parentCalls}`,
            });
          if (tools.length === 0) {
            const title = "Synthetic quiet child restart";
            if (body.stream === false) {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  id: "resp_title",
                  object: "response",
                  status: "completed",
                  output: [
                    {
                      type: "message",
                      id: "msg_title",
                      role: "assistant",
                      status: "completed",
                      content: [{ type: "output_text", text: title, annotations: [] }],
                    },
                  ],
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                }),
              );
            } else {
              text(title);
            }
            return;
          }
          const input = JSON.stringify(body.input);
          if (input.includes("You are running as a subagent")) {
            expect(input).toContain(CHILD_TASK);
            calls.push({ kind: "child", input });
            childPending.resolve();
            // The actual model transport remains pending until managed shutdown aborts it.
            return;
          }
          if (input.includes("Unfinished child sessions to reconcile:")) {
            calls.push({ kind: "recovery", input });
            recovery.resolve(input);
            await withinTest(releaseRecovery.promise, signal);
            text(RECOVERY_FINAL);
            return;
          }
          expect(input).toContain(PARENT_REQUEST);
          calls.push({ kind: "parent", input });
          parentCalls += 1;
          if (parentCalls === 1) {
            const tool = tools.includes("sessions_spawn") ? "sessions_spawn" : "tool_call";
            expect(tools).toContain(tool);
            writeSpawn(response, tool, calls.length);
          } else {
            expect(parentCalls).toBe(2);
            expect(input).toContain("accepted");
            text(PARENT_FINAL);
          }
        })().catch((error: unknown) => {
          failed.reject(error);
          response.destroy(error instanceof Error ? error : undefined);
        });
      }),
  });
  return {
    baseUrl: `http://127.0.0.1:${reservation.claim.port}/v1`,
    calls,
    childPending: childPending.promise,
    recovery: recovery.promise,
    checkpoint: checkpoint.promise,
    releaseCheckpoint: () => releaseCheckpoint.resolve(),
    failed: failed.promise,
    release: () => releaseRecovery.resolve(),
    close: () =>
      runQaGatewayFixture(
        async () => {
          releaseRecovery.resolve();
          releaseCheckpoint.resolve();
          reservation.listener.closeAllConnections();
        },
        reservation.releaseListener,
        reservation.claim.release,
      ),
  };
}

it.skipIf(process.platform === "win32").for(["complete", "reset", "cancel"] as const)(
  "keeps quiet-child restart continuation under parent authority: %s",
  { timeout: 180_000 },
  async (outcome, { signal }) => {
    const provider = await startProvider(signal);
    const model = buildMockOpenAiResponsesProvider(provider.baseUrl, "gpt-5.4");
    const instance = await createOpenClawTestInstance({
      name: "gateway-quiet-subagent-restart",
      signal,
      startTimeoutMs: 120_000,
      stopTimeoutMs: 10_000,
      env: {
        OPENAI_API_KEY: undefined,
        OPENAI_BASE_URL: undefined,
        OPENAI_API_BASE: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
      },
    });
    let client: GatewayClient | undefined;
    const recoveryEnded = createDeferred<Record<string, unknown>>();
    let originalRunId: string | undefined;
    let observeRecovery = false;
    let phase = "startup";
    const observations: Record<string, unknown> = {};
    const persisted = (sessionKey: string) => {
      const database = openNodeSqliteDatabase(
        path.join(instance.state.agentDir(), "openclaw-agent.sqlite"),
        { readOnly: true },
      );
      try {
        const row = database
          .prepare("SELECT entry_json FROM session_nodes WHERE session_key=?")
          .get(sessionKey);
        return typeof row?.entry_json === "string"
          ? asRecord(JSON.parse(row.entry_json))
          : undefined;
      } finally {
        database.close();
      }
    };
    const persistedChild = (
      identity: { runId: string } | { sessionKey: string },
    ): (Record<string, unknown> & { runId: string }) | undefined => {
      const database = openNodeSqliteDatabase(
        instance.state.statePath("state", "openclaw.sqlite"),
        { readOnly: true },
      );
      try {
        const row =
          "runId" in identity
            ? database
                .prepare("SELECT run_id, payload_json FROM subagent_runs WHERE run_id=?")
                .get(identity.runId)
            : database
                .prepare("SELECT run_id, payload_json FROM subagent_runs WHERE child_session_key=?")
                .get(identity.sessionKey);
        if (typeof row?.payload_json !== "string" || typeof row.run_id !== "string") {
          return undefined;
        }
        const payload = asRecord(JSON.parse(row.payload_json));
        const entry = isRecord(payload.parentCompletion) ? payload.parentCompletion : payload;
        return { ...entry, runId: row.run_id };
      } finally {
        database.close();
      }
    };
    const connect = () =>
      acquireGatewayTestClient(
        {
          url: instance.url,
          token: instance.gatewayToken,
          clientName: "gateway-client",
          mode: "backend",
          scopes: ["operator.admin", "operator.read", "operator.write"],
          deviceIdentity: loadOrCreateDeviceIdentity({
            path: instance.state.path("proof-device.sqlite"),
          }),
          onEvent: ({ event, payload }) => {
            if (
              observeRecovery &&
              event === "sessions.changed" &&
              isRecord(payload) &&
              payload.sessionKey === PARENT_KEY &&
              payload.phase === "end" &&
              payload.runId !== originalRunId
            ) {
              recoveryEnded.resolve(payload);
            }
          },
        },
        {
          timeoutMs: 30_000,
          timeoutMessage: "quiet child recovery client did not connect",
          closeMessage: "quiet child recovery client closed",
          signal,
        },
      );
    const restart = async () => {
      const child = instance.child;
      if (!child?.pid) {
        throw new Error("Owned Gateway process unavailable");
      }
      await client?.stopAndWait();
      client = undefined;
      const closed = once(child, "close");
      expect(
        writeGatewayRestartIntentSync({
          env: instance.env,
          targetPid: child.pid,
          intent: { reason: "gateway.restart", force: true, waitMs: 100 },
        }),
      ).toBe(true);
      expect(child.kill("SIGTERM")).toBe(true);
      expect(await withinTest(closed, signal), instance.logs()).toEqual([0, null]);
      phase = "after-shutdown";
      observations.afterShutdown = persistedChild({ sessionKey: String(observations.childKey) });
      await instance.startGateway();
      phase = "after-startup";
      observations.afterStartup = persistedChild({ sessionKey: String(observations.childKey) });
      expect(instance.child?.pid).not.toBe(child.pid);
      client = await connect();
    };
    await runQaGatewayFixture(
      async () => {
        try {
          const pluginId = "quiet-restart-checkpoint";
          const pluginDir = instance.state.path("checkpoint-plugin");
          await mkdir(pluginDir, { recursive: true });
          await writeFile(
            path.join(pluginDir, "openclaw.plugin.json"),
            JSON.stringify({
              id: pluginId,
              activation: { onStartup: true },
              configSchema: { type: "object", additionalProperties: false, properties: {} },
            }),
          );
          // The public prompt hook pauses real preparation before any model request.
          await writeFile(
            path.join(pluginDir, "index.mjs"),
            `export default {
              id: ${JSON.stringify(pluginId)},
              register(api) {
                api.on("before_prompt_build", async (event, ctx) => {
                  if (!event.prompt.includes("Unfinished child sessions to reconcile:")) return;
                  await fetch(${JSON.stringify(provider.baseUrl.replace("/v1", "/recovery-checkpoint"))}, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ runId: ctx.runId, prompt: event.prompt }),
                  });
                }, { timeoutMs: 60000 });
              },
            };`,
          );
          await instance.state.writeConfig({
            update: { checkOnStart: false },
            browser: { enabled: false },
            discovery: { mdns: { mode: "off" } },
            plugins: {
              enabled: true,
              allow: [pluginId],
              load: { paths: [pluginDir] },
              entries: { [pluginId]: { enabled: true, hooks: { allowConversationAccess: true } } },
              slots: { memory: "none" },
            },
            models: {
              mode: "replace",
              providers: {
                [model.providerId]: { ...model.config, request: { allowPrivateNetwork: true } },
              },
            },
            agents: {
              defaults: {
                workspace: instance.state.workspaceDir,
                model: { primary: model.modelRef },
                modelPolicy: { allow: [model.modelRef] },
                models: {
                  [model.modelRef]: {
                    agentRuntime: { id: "openclaw" },
                    params: { transport: "sse", openaiWsWarmup: false },
                  },
                },
                heartbeat: { every: "0m" },
                skipBootstrap: true,
                skills: [],
                timeoutSeconds: 120,
                subagents: { runTimeoutSeconds: 120 },
              },
              entries: { main: {} },
            },
            tools: {
              allow: ["sessions_spawn", "sessions_send", "sessions_history", "subagents"],
              codeMode: { enabled: false },
            },
            gateway: {
              mode: "local",
              controlUi: { enabled: false },
              bind: "loopback",
              port: instance.port,
              auth: { mode: "token", token: instance.gatewayToken },
            },
          });
          await instance.startGateway();
          client = await connect();
          await client.request("sessions.create", { key: PARENT_KEY, agentId: "main" });
          const accepted = await client.request<{ runId: string }>(
            "chat.send",
            {
              sessionKey: PARENT_KEY,
              message: PARENT_REQUEST,
              idempotencyKey: "quiet-child-original",
            },
            { expectFinal: false },
          );
          originalRunId = accepted.runId;
          await withinTest(Promise.race([provider.childPending, provider.failed]), signal);
          expect(
            await client.request("agent.wait", { runId: originalRunId, timeoutMs: 60_000 }),
          ).toMatchObject({ status: "ok" });
          const initial = await client.request<SessionsListResult>("sessions.list", {
            agentId: "main",
          });
          const child = initial.sessions.find((row) => row.key.includes(":subagent:"));
          expect(child).toMatchObject({ status: "running", hasActiveRun: true });
          if (!child) {
            throw new Error("sessions_spawn did not create its child session");
          }
          const { runId: childRunId } = await vi.waitFor(
            () => {
              expect(persisted(PARENT_KEY)).toMatchObject({
                status: "done",
                lastRunId: originalRunId,
              });
              const entry = persistedChild({ sessionKey: child.key });
              expect(entry).toMatchObject({ execution: { status: "running" } });
              if (!entry) {
                throw new Error("Child registry row is missing");
              }
              return entry;
            },
            { timeout: 30_000 },
          );
          observations.childKey = child.key;
          observations.beforeShutdown = persistedChild({ runId: childRunId });
          expect(
            JSON.stringify(await client.request("chat.history", { sessionKey: PARENT_KEY })),
          ).toContain(PARENT_FINAL);
          observeRecovery = true;
          const recoveryStartedAt = Date.now();
          await restart();
          phase = "waiting-for-continuation";
          await client!.request("sessions.subscribe", { agentId: "main" });
          const checkpoint = await withinTest(
            Promise.race([provider.checkpoint, provider.failed]),
            AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
          );
          const recoveryMs = Date.now() - recoveryStartedAt;
          expect(checkpoint.prompt).toContain(child.key);
          expect(checkpoint.prompt).toContain(childRunId);
          expect(checkpoint.prompt).toContain("Reconcile every listed unfinished");
          expect(checkpoint.prompt).toContain("uncertain tool effects");
          expect(checkpoint.prompt).toContain("Process this result privately.");
          expect(persistedChild({ runId: childRunId })?.requesterSettleWake).toMatchObject({
            status: "dispatching",
          });
          expect(provider.calls.filter((call) => call.kind === "recovery")).toHaveLength(0);
          let dispatchesAtRevocation: number | undefined;
          if (outcome === "complete") {
            provider.releaseCheckpoint();
            await withinTest(Promise.race([provider.recovery, provider.failed]), signal);
            provider.release();
            await withinTest(Promise.race([recoveryEnded.promise, provider.failed]), signal);
            await vi.waitFor(
              () => {
                expect(persisted(PARENT_KEY)).toMatchObject({ status: "done" });
                const settled = persistedChild({ runId: childRunId });
                expect(settled).toMatchObject({ expectsCompletionMessage: false, cleanup: "keep" });
                expect(settled?.requesterSettleWake).toBeUndefined();
              },
              { timeout: 30_000 },
            );
          } else {
            phase = `revoking-${outcome}`;
            if (outcome === "reset") {
              // Reset an executing continuation with its authorized model request pending.
              provider.releaseCheckpoint();
              await withinTest(Promise.race([provider.recovery, provider.failed]), signal);
            }
            dispatchesAtRevocation = provider.calls.filter(
              (call) => call.kind === "recovery",
            ).length;
            if (outcome === "reset") {
              await client!.request("sessions.reset", { key: PARENT_KEY, reason: "reset" });
            } else {
              // Cancellation acknowledges the stop before the held prompt hook returns.
              expect(
                await client!.request("chat.abort", {
                  sessionKey: PARENT_KEY,
                  runId: checkpoint.runId,
                }),
              ).toMatchObject({ aborted: true });
            }
            provider.releaseCheckpoint();
            provider.release();
            await vi.waitFor(
              () => {
                expect(persisted(PARENT_KEY)?.status).not.toBe("running");
                expect(persistedChild({ runId: childRunId })?.requesterSettleWake).toBeUndefined();
              },
              { timeout: 30_000 },
            );
          }
          if (outcome === "complete") {
            const history = await client!.request<{ messages: unknown[] }>("chat.history", {
              sessionKey: child.key,
            });
            expect(JSON.stringify(history.messages)).toContain(CHILD_TASK);
            expect(persisted(child.key)).toMatchObject({
              sessionId: child.sessionId,
              status: "interrupted",
            });
          }
          // Restart only after the durable handoff settles; it must stay consumed on the next boot.
          const recoveryPasses = () =>
            (instance.logs().match(/startup trace: sidecars.subagent-recovery /g) ?? []).length;
          const priorRecoveryPasses = recoveryPasses();
          await restart();
          await withinTest(
            Promise.race([
              vi.waitFor(
                async () => {
                  expect(recoveryPasses()).toBeGreaterThan(priorRecoveryPasses);
                  const sessions = await client!.request<SessionsListResult>("sessions.list", {
                    agentId: "main",
                  });
                  for (const row of sessions.sessions) {
                    if (row.key === PARENT_KEY || row.key === child.key) {
                      expect(row.hasActiveRun).toBe(false);
                    }
                  }
                },
                { timeout: 30_000 },
              ),
              provider.failed,
            ]),
            signal,
          );
          expect(persistedChild({ runId: childRunId })?.requesterSettleWake).toBeUndefined();
          if (outcome === "complete") {
            expect(persisted(PARENT_KEY)).toMatchObject({ status: "done" });
          }
          expect(provider.calls.filter((call) => call.kind === "child")).toHaveLength(1);
          expect(provider.calls.filter((call) => call.kind === "parent")).toHaveLength(2);
          const recoveryDispatches = provider.calls.filter(
            (call) => call.kind === "recovery",
          ).length;
          expect(recoveryDispatches).toBe(outcome === "cancel" ? 0 : 1);
          if (dispatchesAtRevocation !== undefined) {
            expect(recoveryDispatches - dispatchesAtRevocation).toBe(0);
          }
          console.log(
            JSON.stringify({
              proof: "quiet-subagent-managed-restart",
              recoveryMs,
              outcome,
              recoveryDispatches,
              originalParentDispatches: 2,
              ...(dispatchesAtRevocation === undefined
                ? {}
                : { dispatchesAfterRevocation: recoveryDispatches - dispatchesAtRevocation }),
              childDispatches: 1,
              subsequentRestarts: 1,
            }),
          );
        } catch (cause) {
          throw new Error(
            JSON.stringify({
              calls: provider.calls.map(({ kind }) => kind),
              phase,
              observations,
              logs: instance
                .logs()
                .split("\n")
                .filter((line) => !/startup trace:|startup phase:/.test(line))
                .slice(-90)
                .join("\n"),
            }).replaceAll(instance.gatewayToken, "[fixture token]"),
            { cause },
          );
        }
      },
      async () => {
        provider.release();
        provider.releaseCheckpoint();
        await client?.stopAndWait();
      },
      () => instance.cleanup(),
      () => provider.close(),
    );
  },
);
