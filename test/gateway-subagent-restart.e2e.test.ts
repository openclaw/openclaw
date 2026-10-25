// Managed process replacement proves requester settlement after the child session was replaced.
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
import { extractAssistantPhaseText } from "../src/shared/chat-message-content.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import {
  connectRestartClient,
  restartProviderServer,
  restartToolNames,
  writeRestartToolCall,
} from "./gateway-restart.test-support.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import { GATEWAY_RESTART_TEST_KILL_MS } from "./helpers/gateway-restart-budget.js";
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
    arguments: JSON.stringify(name === "dispatch_action" ? { id: "sessions_spawn", args } : args),
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
  const checkpoint = createDeferred<{
    runId: string;
    prompt: string;
    sessionKey: string;
    sessionId: string;
  }>();
  const releaseCheckpoint = createDeferred();
  const releaseRecovery = createDeferred();
  const failed = createDeferred<never>();
  void failed.promise.catch(() => {});
  const calls: Array<{ kind: "parent" | "child" | "recovery"; input: string }> = [];
  const requests: string[] = [];
  let parentCalls = 0;
  const reservation = await reserveTestPortListener({
    // Keep the measured provider/Gateway block above 40000 and outside Linux's client-port pool.
    port: 64_864,
    offsets: [0, 1, 2, 3],
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
            expect(typeof body.sessionKey).toBe("string");
            expect(typeof body.sessionId).toBe("string");
            checkpoint.resolve({
              runId: String(body.runId),
              prompt: String(body.prompt),
              sessionKey: String(body.sessionKey),
              sessionId: String(body.sessionId),
            });
            await withinTest(releaseCheckpoint.promise, signal);
            response.writeHead(204).end();
            return;
          }
          expect(request.url).toBe("/v1/responses");
          requests.push(JSON.stringify(body.input));
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
            const tool = tools.includes("sessions_spawn") ? "sessions_spawn" : "dispatch_action";
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
    gatewayPort: reservation.claim.port + 2,
    calls,
    requests,
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

it
  .skipIf(process.platform === "win32")
  .for([{ outcome: "complete" }, { outcome: "reset" }, { outcome: "cancel" }] as const)(
  "keeps replaced-child restart settlement under parent authority: $outcome",
  { timeout: 180_000 },
  async ({ outcome }, { signal }) => {
    const provider = await startProvider(signal);
    const model = buildMockOpenAiResponsesProvider(provider.baseUrl, "gpt-5.4");
    const instance = await createOpenClawTestInstance({
      name: "gateway-quiet-subagent-restart",
      port: provider.gatewayPort,
      signal,
      startTimeoutMs: 120_000,
      stopTimeoutMs: 10_000,
      gracefulShutdownTimeoutMs: GATEWAY_RESTART_TEST_KILL_MS,
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
    let replacementChild: Record<string, unknown> | undefined;
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
          // Recovery needs the original profiled operator; backend probes are unprofiled.
          mode: "test",
          scopes: ["operator.admin", "operator.read", "operator.write"],
          deviceIdentity: loadOrCreateDeviceIdentity({
            path: instance.state.statePath(
              "proof-identities",
              "requester",
              "client",
              "credentials.sqlite",
            ),
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
    const restart = async (replaceChildAfterDrain = false) => {
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
      if (replaceChildAfterDrain) {
        // The owned Gateway has exited. Model an offline reset's new incarnation
        // while retaining the old task receipt that startup must settle.
        const childKey = String(observations.childKey);
        const originalChild = persisted(childKey);
        expect(originalChild).toMatchObject({
          sessionId: expect.any(String),
          lifecycleRevision: expect.any(String),
        });
        replacementChild = {
          ...originalChild,
          lifecycleRevision: "replacement-child-revision",
          lifecycleRunId: "replacement-child-run",
          status: "done",
          abortedLastRun: false,
        };
        delete replacementChild.lastRunError;
        const database = openNodeSqliteDatabase(
          path.join(instance.state.agentDir(), "openclaw-agent.sqlite"),
        );
        try {
          expect(
            database
              .prepare("UPDATE session_nodes SET entry_json=?, status='done' WHERE session_key=?")
              .run(JSON.stringify(replacementChild), childKey).changes,
          ).toBe(1);
        } finally {
          database.close();
        }
      }
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
                    body: JSON.stringify({
                      runId: ctx.runId,
                      prompt: event.prompt,
                      sessionKey: ctx.sessionKey,
                      sessionId: ctx.sessionId,
                    }),
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
              // Keep this synthetic restart fixture independent of remote catalog adoption.
              catalogRefresh: { enabled: false },
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
              expect(entry.operatorRecoverySource).toMatchObject({
                sessionKey: PARENT_KEY,
                sourceRunId: originalRunId,
              });
              return entry;
            },
            { timeout: 30_000 },
          );
          observations.childKey = child.key;
          observations.beforeShutdown = persistedChild({ runId: childRunId });
          const parentSession = persisted(PARENT_KEY);
          const parentSessionId = parentSession?.sessionId;
          expect(observations.beforeShutdown).toMatchObject({
            operatorRecoverySource: {
              version: 1,
              agentId: "main",
              sessionKey: PARENT_KEY,
              sessionId: parentSessionId,
              lifecycleRevision: parentSession?.lifecycleRevision,
              sourceRunId: originalRunId,
              snapshot: {
                profileId: expect.any(String),
                scopes: expect.arrayContaining([
                  "operator.admin",
                  "operator.read",
                  "operator.write",
                ]),
                localOperator: true,
              },
            },
          });
          expect(
            JSON.stringify(await client.request("chat.history", { sessionKey: PARENT_KEY })),
          ).toContain(PARENT_FINAL);
          observeRecovery = true;
          const recoveryStartedAt = Date.now();
          await restart(true);
          phase = "waiting-for-continuation";
          await client!.request("sessions.subscribe", { agentId: "main" });
          const checkpoint = await withinTest(
            Promise.race([provider.checkpoint, provider.failed]),
            AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
          );
          const recoveryMs = Date.now() - recoveryStartedAt;
          expect(checkpoint).toMatchObject({ sessionKey: PARENT_KEY, sessionId: parentSessionId });
          expect(checkpoint.prompt).toContain(child.key);
          expect(checkpoint.prompt).toContain(childRunId);
          expect(checkpoint.prompt).toContain("Reconcile every listed unfinished");
          expect(checkpoint.prompt).toContain("uncertain tool effects");
          expect(checkpoint.prompt).toContain("Process this result privately.");
          expect(persistedChild({ runId: childRunId })?.requesterSettleWake).toMatchObject({
            status: "dispatching",
          });
          expect(provider.calls.filter((call) => call.kind === "recovery")).toHaveLength(0);
          expect(checkpoint.prompt).toContain("original session incarnation changed");
          expect(persisted(child.key)).toEqual(replacementChild);
          expect(persistedChild({ runId: childRunId })?.execution).toMatchObject({
            status: "terminal",
            suppressSessionEffects: true,
            outcome: {
              status: "error",
              error: expect.stringContaining("original session incarnation changed"),
            },
          });
          let dispatchesAtRevocation: number | undefined;
          let requestsAtRevocation: number | undefined;
          if (outcome === "complete") {
            provider.releaseCheckpoint();
            await withinTest(Promise.race([provider.recovery, provider.failed]), signal);
            provider.release();
            await withinTest(Promise.race([recoveryEnded.promise, provider.failed]), signal);
            await vi.waitFor(
              () => {
                expect(persisted(PARENT_KEY)).toMatchObject({ status: "done" });
                const settled = persistedChild({ runId: childRunId });
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
            requestsAtRevocation = provider.requests.length;
            if (outcome === "reset") {
              await client!.request("sessions.reset", { key: PARENT_KEY, reason: "reset" });
            } else {
              // Parent cancellation succeeds but cannot cancel a replacement child.
              await expect(
                client!.request("chat.abort", {
                  sessionKey: PARENT_KEY,
                  runId: checkpoint.runId,
                }),
              ).rejects.toThrow(
                /Parent run stopped, but descendant cancellation was incomplete: .*original session incarnation is unresolved or changed/,
              );
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
          expect(persisted(child.key)).toEqual(replacementChild);
          if (outcome === "complete") {
            expect(persisted(PARENT_KEY)).toMatchObject({ status: "done" });
          }
          expect(provider.calls.filter((call) => call.kind === "child")).toHaveLength(1);
          expect(provider.calls.filter((call) => call.kind === "parent")).toHaveLength(2);
          const recoveryDispatches = provider.calls.filter(
            (call) => call.kind === "recovery",
          ).length;
          expect(recoveryDispatches).toBe(outcome === "complete" || outcome === "reset" ? 1 : 0);
          if (dispatchesAtRevocation !== undefined) {
            expect(recoveryDispatches - dispatchesAtRevocation).toBe(0);
          }
          if (requestsAtRevocation !== undefined) {
            expect(provider.requests.length - requestsAtRevocation).toBe(0);
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
                : {
                    dispatchesAfterRevocation: recoveryDispatches - dispatchesAtRevocation,
                    providerRequestsAfterRevocation:
                      provider.requests.length - (requestsAtRevocation ?? 0),
                  }),
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

it.skipIf(process.platform === "win32").for([
  { parentAgentId: "main", parentKey: "agent:main:main", followup: false },
  {
    parentAgentId: "requester",
    parentKey: "agent:requester:x:group:restart-fixture",
    followup: true,
  },
])(
  "resumes a drain-interrupted dashboard child once for $parentKey (follow-up: $followup)",
  { timeout: 240_000 },
  async ({ parentAgentId, parentKey, followup }, { signal }) => {
    const parentRequest = "DASHBOARD_RESTART_PARENT: start a visible child, then finish.";
    const childTask = "DASHBOARD_RESTART_CHILD: finish the retained assignment.";
    const childFinal = "DASHBOARD_CHILD_COMPLETED";
    const peerRequest = "DASHBOARD_PEER_SEND: continue the retained child.";
    const peerKey = `agent:${parentAgentId}:dashboard:restart-peer`;
    let childKey = "";
    let peerCalls = 0;
    const parentFinal = "DASHBOARD_PARENT_RECEIVED_RESULT";
    const failed = createDeferred<never>();
    void failed.promise.catch(() => {});
    const initialChild = createDeferred();
    const resumedChild = createDeferred<ServerResponse>();
    let parentCalls = 0;
    let childCalls = 0;
    const resumedCall = followup ? 4 : 3;
    const reservation = await reserveTestPortListener({
      port: 64_872,
      offsets: [0, 1, 2, 3],
      signal,
      createListener: () =>
        restartProviderServer(failed, async (_request, response, body) => {
          const input = JSON.stringify(body.input);
          const text = (value: string) =>
            writeOpenAiResponsesText(response, {
              text: value,
              messageId: `msg_dashboard_${parentCalls}_${childCalls}`,
              responseId: `resp_dashboard_${parentCalls}_${childCalls}`,
            });
          if (restartToolNames(body).length === 0) {
            const title = "Synthetic dashboard restart";
            if (body.stream === false) {
              response.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({
                  id: "resp_dashboard_title",
                  object: "response",
                  status: "completed",
                  output: [
                    {
                      type: "message",
                      id: "msg_dashboard_title",
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
          } else if (input.includes(peerRequest) && !input.includes(childTask)) {
            peerCalls += 1;
            if (peerCalls === 1) {
              writeRestartToolCall(
                response,
                "peer_send",
                "sessions_send",
                {
                  sessionKey: childKey,
                  message: "DASHBOARD_CONTINUE: inspect retained work and finish.",
                  mode: "followup",
                  timeoutSeconds: 0,
                  watch: false,
                },
                peerCalls,
              );
            } else {
              expect(input).not.toContain('"status":"forbidden"');
              text("DASHBOARD_PEER_ACKNOWLEDGED");
            }
          } else if (input.includes(parentRequest)) {
            parentCalls += 1;
            if (parentCalls === 1) {
              writeRestartToolCall(
                response,
                "dashboard_spawn",
                "sessions_spawn",
                {
                  task: childTask,
                  agentId: "main",
                  taskName: "dashboard_restart_child",
                  visible: true,
                  context: "isolated",
                },
                parentCalls,
              );
            } else {
              expect(input, "The visible child must be accepted before restart").toContain(
                "childSessionKey",
              );
              if (parentCalls > 2) {
                expect(input).toContain(childFinal);
              }
              text(parentCalls === 2 ? "DASHBOARD_CHILD_STARTED" : parentFinal);
            }
          } else {
            expect(input).toContain(childTask);
            childCalls += 1;
            expect(childCalls).toBeLessThanOrEqual(resumedCall + 1);
            if (childCalls === 1) {
              writeRestartToolCall(
                response,
                "dashboard_checkpoint",
                "subagents",
                { action: "list" },
                childCalls,
              );
            } else if (followup && childCalls === 2) {
              text(childFinal);
            } else if (childCalls === resumedCall - 1) {
              initialChild.resolve();
            } else if (childCalls === resumedCall) {
              resumedChild.resolve(response);
            } else {
              // A resumed agent must be able to inspect retained work before finishing.
              const output = asRecord(
                (Array.isArray(body.input) ? body.input : []).find(
                  (item) =>
                    isRecord(item) &&
                    item.type === "function_call_output" &&
                    item.call_id === `call_dashboard_recovered_history_${resumedCall}`,
                ),
              );
              expect(output.output).toBeTypeOf("string");
              const history = asRecord(JSON.parse(String(output.output)));
              expect(history).toMatchObject({ messages: expect.any(Array) });
              expect(history.error).toBeUndefined();
              expect(JSON.stringify(history.messages)).toContain("call_dashboard_checkpoint_1");
              text(childFinal);
            }
            // After recording a checkpoint, hold the next transport through the drain,
            // then hold the resumed transport until the parent is proven still waiting.
          }
        }),
    });
    const model = buildMockOpenAiResponsesProvider(
      `http://127.0.0.1:${reservation.claim.port}/v1`,
      "gpt-5.4",
    );
    const instance = await createOpenClawTestInstance({
      name: "gateway-dashboard-child-restart",
      port: reservation.claim.port + 2,
      signal,
      startTimeoutMs: 120_000,
      stopTimeoutMs: 10_000,
      gracefulShutdownTimeoutMs: GATEWAY_RESTART_TEST_KILL_MS,
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
    const connect = () => connectRestartClient(instance, { mode: "test" }, signal, 60_000);
    const wait = <T>(promise: Promise<T>) =>
      withinTest(Promise.race([promise, failed.promise]), signal);
    const restart = async () => {
      const process = instance.child;
      expect(process?.pid).toBeDefined();
      await client?.stopAndWait();
      client = undefined;
      const closed = once(process!, "close");
      expect(
        writeGatewayRestartIntentSync({
          env: instance.env,
          targetPid: process!.pid!,
          intent: { reason: "gateway.restart", force: true, waitMs: 100 },
        }),
      ).toBe(true);
      expect(process!.kill("SIGTERM")).toBe(true);
      expect(await wait(closed), instance.logs()).toEqual([0, null]);
      await instance.startGateway();
      client = await connect();
    };
    await runQaGatewayFixture(
      async () => {
        await instance.state.writeConfig({
          update: { checkOnStart: false },
          browser: { enabled: false },
          plugins: { enabled: false },
          models: {
            catalogRefresh: { enabled: false },
            mode: "replace",
            providers: {
              [model.providerId]: { ...model.config, request: { allowPrivateNetwork: true } },
            },
          },
          agents: {
            ownership: "explicit",
            defaults: {
              systemAgent: { agentId: "main" },
              subagents: { maxSpawnDepth: 2 },
              workspace: instance.state.workspaceDir,
              model: { primary: model.modelRef },
              modelPolicy: { allow: [model.modelRef] },
              models: {
                [model.modelRef]: {
                  agentRuntime: { id: "openclaw" },
                  params: { transport: "sse", openaiWsWarmup: false },
                },
              },
              skipBootstrap: true,
              skills: [],
              timeoutSeconds: 180,
            },
            entries: {
              main: {},
              requester: { subagents: { allowAgents: ["main"] } },
            },
          },
          tools: {
            sessions: { visibility: "all" },
            agentToAgent: { enabled: true },
            allow: ["read", "sessions_spawn", "sessions_send", "sessions_history", "subagents"],
            codeMode: { enabled: false },
            toolSearch: false,
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
        await client.request("sessions.create", { key: parentKey, agentId: parentAgentId });
        const accepted = await client.request<{ runId: string }>(
          "chat.send",
          { sessionKey: parentKey, message: parentRequest, idempotencyKey: "dashboard-original" },
          { expectFinal: false },
        );
        if (!followup) {
          await wait(initialChild.promise);
        }
        expect(
          await client.request("agent.wait", { runId: accepted.runId, timeoutMs: 60_000 }),
        ).toMatchObject({ status: "ok" });
        const rows = await client.request<SessionsListResult>("sessions.list", { agentId: "main" });
        const child = rows.sessions.find((row) => row.spawnedBy === parentKey);
        expect(child, instance.logs()).toBeDefined();
        if (!child) {
          throw new Error("Visible spawn did not publish its dashboard child");
        }
        if (followup) {
          await wait(
            vi.waitFor(
              async () => {
                const settled = await client!.request<SessionsListResult>("sessions.list", {});
                for (const key of [parentKey, child.key]) {
                  expect(settled.sessions.find((row) => row.key === key)).toMatchObject({
                    status: "done",
                    hasActiveRun: false,
                  });
                }
                expect(parentCalls).toBe(3);
              },
              { timeout: 60_000 },
            ),
          );
          // Peer follow-ups keep the original child task historical.
          childKey = child.key;
          await client.request("sessions.create", { key: peerKey, agentId: parentAgentId });
          const peerRun = await client.request<{ runId: string }>(
            "chat.send",
            {
              sessionKey: peerKey,
              message: peerRequest,
              idempotencyKey: "dashboard-peer-followup",
            },
            { expectFinal: false },
          );
          await wait(initialChild.promise);
          expect(
            await client.request("agent.wait", { runId: peerRun.runId, timeoutMs: 60_000 }),
          ).toMatchObject({ status: "ok" });
        }
        const beforeRestart = await client.request<SessionsListResult>("sessions.list", {
          agentId: "main",
        });
        expect(beforeRestart.sessions.find((row) => row.key === child.key)).toMatchObject({
          status: "running",
          hasActiveRun: true,
          ...(followup ? { subagentRunState: "historical" } : {}),
        });
        expect(parentCalls).toBe(followup ? 3 : 2);
        await restart();
        await wait(
          vi.waitFor(
            async () => {
              const state = await client!.request<SessionsListResult>("sessions.list", {
                agentId: "main",
              });
              expect(state.sessions.find((row) => row.key === child.key)).toMatchObject({
                status: "running",
                hasActiveRun: true,
              });
            },
            { timeout: 60_000 },
          ),
        );
        const resumedResponse = await wait(resumedChild.promise);
        expect(parentCalls, instance.logs()).toBe(followup ? 3 : 2);
        expect(childCalls).toBe(resumedCall);
        const running = await client!.request<SessionsListResult>("sessions.list", {
          agentId: "main",
        });
        expect(running.sessions.find((row) => row.key === child.key)).toMatchObject({
          status: "running",
          hasActiveRun: true,
        });
        writeRestartToolCall(
          resumedResponse,
          "dashboard_recovered_history",
          "sessions_history",
          { sessionKey: child.key, limit: 20 },
          childCalls,
        );
        const assertCompleted = async () => {
          const sessions = await client!.request<SessionsListResult>("sessions.list", {});
          for (const key of [parentKey, child.key]) {
            expect(
              sessions.sessions.find((row) => row.key === key),
              instance.logs(),
            ).toMatchObject({
              status: "done",
              hasActiveRun: false,
            });
          }
          const history = await client!.request<{ messages: unknown[] }>("chat.history", {
            sessionKey: parentKey,
          });
          expect(
            history.messages.map(extractAssistantPhaseText).filter((text) => text === parentFinal),
          ).toHaveLength(1);
          expect({ parentCalls, childCalls }).toEqual({
            parentCalls: 3,
            childCalls: resumedCall + 1,
          });
        };
        await wait(vi.waitFor(assertCompleted, { timeout: 60_000 }));
        const recoveryPasses = () =>
          (instance.logs().match(/startup trace: sidecars.subagent-recovery /g) ?? []).length;
        const completedPasses = recoveryPasses();
        await restart();
        await vi.waitFor(() => expect(recoveryPasses()).toBeGreaterThan(completedPasses), {
          timeout: 60_000,
        });
        await wait(vi.waitFor(assertCompleted, { timeout: 60_000 }));
      },
      async () => {
        if (signal.aborted) {
          console.error(instance.logs().replaceAll(instance.gatewayToken, "[fixture token]"));
        }
        await client?.stopAndWait();
      },
      () => instance.cleanup(),
      async () => {
        reservation.listener.closeAllConnections();
        await reservation.releaseListener();
        await reservation.claim.release();
      },
    );
  },
);
