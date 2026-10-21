// Managed process replacement proves recovery of a child whose requester already finished.
import { once } from "node:events";
import type { ServerResponse } from "node:http";
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
import {
  restartEnv,
  readRestartSession,
  writeRestartPlugin,
  connectRestartClient,
  restartProviderServer,
  restartToolNames,
  writeRestartTitle,
  restartModelConfig,
  writeRestartToolCall,
} from "./gateway-restart.test-support.js";
import { GATEWAY_RESTART_TEST_KILL_MS } from "./helpers/gateway-restart-budget.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
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
  writeRestartToolCall(
    response,
    "spawn",
    name,
    name === "dispatch_action" ? { id: "sessions_spawn", args } : args,
    ordinal,
  );
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
      restartProviderServer(failed, async (request, response, body) => {
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
        const tools = restartToolNames(body);
        const text = (value: string) =>
          writeOpenAiResponsesText(response, {
            text: value,
            messageId: `msg_${calls.length}_${parentCalls}`,
            responseId: `resp_${calls.length}_${parentCalls}`,
          });
        if (tools.length === 0) {
          const title = "Synthetic quiet child restart";
          if (body.stream === false) {
            writeRestartTitle(response, title);
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

it.skipIf(process.platform === "win32").for([
  { outcome: "complete", replaceChild: false },
  { outcome: "reset", replaceChild: false },
  { outcome: "complete", replaceChild: true },
  { outcome: "reset", replaceChild: true },
  { outcome: "cancel", replaceChild: true },
] as const)(
  "keeps quiet-child restart continuation under parent authority: $outcome (child replaced: $replaceChild)",
  { timeout: 180_000 },
  async ({ outcome, replaceChild }, context) => {
    const { signal } = context;
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
        ...restartEnv,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
      },
    });
    context.onTestFailed(() =>
      console.error(instance.logs().replaceAll(instance.gatewayToken, "[fixture token]")),
    );
    let client: GatewayClient | undefined;
    const recoveryEnded = createDeferred<Record<string, unknown>>();
    let originalRunId: string | undefined;
    let observeRecovery = false;
    let replacementChild: Record<string, unknown> | undefined;
    let childKey: string;
    const persisted = (sessionKey: string) =>
      readRestartSession(instance.state.agentDir(), sessionKey);
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
      connectRestartClient(
        instance,
        {
          mode: "test",
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
        signal,
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
      if (replaceChildAfterDrain) {
        // The owned Gateway has exited. Model an offline reset's new incarnation
        // while retaining the old task receipt that startup must settle.
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
      expect(instance.child?.pid).not.toBe(child.pid);
      client = await connect();
    };
    await runQaGatewayFixture(
      async () => {
        const pluginId = "quiet-restart-checkpoint";
        const pluginDir = instance.state.path("checkpoint-plugin");

        // Pause real prompt preparation before any recovery model request.
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
            entries: { [pluginId]: { enabled: true, hooks: { allowConversationAccess: true } } },
            slots: { memory: "none" },
          },
          ...restartModelConfig(
            model,
            instance.state.workspaceDir,
            { subagents: { runTimeoutSeconds: 120 } },
            { catalogRefresh: { enabled: false } },
          ),
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
        childKey = child.key;
        const parentSession = persisted(PARENT_KEY);
        const parentSessionId = parentSession?.sessionId;
        expect(persistedChild({ runId: childRunId })).toMatchObject({
          operatorRecoverySource: {
            version: 1,
            agentId: "main",
            sessionKey: PARENT_KEY,
            sessionId: parentSessionId,
            lifecycleRevision: parentSession?.lifecycleRevision,
            sourceRunId: originalRunId,
            snapshot: {
              profileId: expect.any(String),
              scopes: expect.arrayContaining(["operator.admin", "operator.read", "operator.write"]),
              localOperator: true,
            },
          },
        });
        expect(
          JSON.stringify(await client.request("chat.history", { sessionKey: PARENT_KEY })),
        ).toContain(PARENT_FINAL);
        observeRecovery = true;
        await restart(replaceChild);
        await client!.request("sessions.subscribe", { agentId: "main" });
        const checkpoint = await withinTest(
          Promise.race([provider.checkpoint, provider.failed]),
          AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        );
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
        if (replaceChild) {
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
        }
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
              if (!replaceChild) {
                expect(settled).toMatchObject({
                  expectsCompletionMessage: false,
                  cleanup: "keep",
                });
              }
              expect(settled?.requesterSettleWake).toBeUndefined();
            },
            { timeout: 30_000 },
          );
        } else {
          if (outcome === "reset") {
            // Reset an executing continuation with its authorized model request pending.
            provider.releaseCheckpoint();
            await withinTest(Promise.race([provider.recovery, provider.failed]), signal);
          }
          dispatchesAtRevocation = provider.calls.filter((call) => call.kind === "recovery").length;
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
        if (outcome === "complete" && !replaceChild) {
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
        if (replaceChild) {
          expect(persisted(child.key)).toEqual(replacementChild);
        }
        if (outcome === "complete") {
          expect(persisted(PARENT_KEY)).toMatchObject({ status: "done" });
        }
        expect(provider.calls.filter((call) => call.kind === "child")).toHaveLength(1);
        expect(provider.calls.filter((call) => call.kind === "parent")).toHaveLength(2);
        const recoveryDispatches = provider.calls.filter((call) => call.kind === "recovery").length;
        expect(recoveryDispatches).toBe(outcome === "complete" || outcome === "reset" ? 1 : 0);
        if (dispatchesAtRevocation !== undefined) {
          expect(recoveryDispatches - dispatchesAtRevocation).toBe(0);
        }
        if (requestsAtRevocation !== undefined) {
          expect(provider.requests.length - requestsAtRevocation).toBe(0);
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
