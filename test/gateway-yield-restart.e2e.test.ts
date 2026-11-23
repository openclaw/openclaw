import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import type { OperatorScope } from "../src/gateway/operator-scopes.js";
import { findSubagentSpawnReceipt } from "../src/gateway/server.subagent-stop-settlement.product.test-support.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { openNodeSqliteDatabase } from "../src/infra/node-sqlite.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import { restartResumeConfig } from "./gateway-restart-resume.test-support.js";
import {
  connectRestartClient,
  connectProxiedRestartOperator,
  readRestartSession,
  restartEnv,
  restartProviderServer,
  restartToolNames,
  writeRestartJsonText,
  writeRestartToolCall,
  writeRestartPlugin,
} from "./gateway-restart.test-support.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { createDeferred } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

it
  .skipIf(process.platform === "win32")
  .for([
    "continue",
    "finish",
    "root-source-stopped",
    "root-background-stopped",
    "root-main-tool-stopped",
    "root-main-legacy-stopped",
    "other-agent",
    "parked-message",
    "completed-before",
    "policy-unavailable",
  ] as const)(
  "preserves yielded work through an actual Gateway restart (%s)",
  { timeout: 180_000 },
  async (action, { signal, onTestFailed }) => {
    const stoppedRoot = action.startsWith("root-");
    const legacyShutdown = action === "root-main-legacy-stopped";
    const mainTool = action === "root-main-tool-stopped" || legacyShutdown;
    const parkedRoot = action === "root-source-stopped" || action === "parked-message";
    const restartRoot = stoppedRoot || parkedRoot || action === "completed-before";
    const childAgent = action === "other-agent" ? "other" : "main";
    const rootKey =
      stoppedRoot || parkedRoot
        ? "agent:main:dashboard:yield-restart"
        : "agent:main:main:thread:yield-restart";
    const rootPrompt = "YIELD_RESTART_REQUESTER";
    const childPrompt = "YIELD_RESTART_CHILD";
    const failed = createDeferred<never>();
    void failed.promise.catch(() => {});
    let childKey: string | undefined;
    let childRunId: string | undefined;
    let childCalls = 0;
    let childRestartRequests = 0;
    let mainToolCalls = 0;
    let childCallsAfterStop: number | undefined;
    const childRequests: Array<{ phase: string; ordinal: number; execResult: boolean }> = [];
    let lastExecOrdinal: number | undefined;
    let rootResumes = 0;
    let sequence = 0;
    let sentContinuation = false;
    let yieldRoot: (() => void) | undefined;
    let continueChild: (() => void) | undefined;
    let finishRequester: (() => void) | undefined;
    let finishChild: (() => void) | undefined;
    let yieldRequester: (() => void) | undefined;
    let yieldedAfterOutage = false;
    let requesterFinished = false;
    let toolMarker = "";
    const reservation = await reserveTestPortListener({
      offsets: [0],
      signal,
      createListener: () =>
        restartProviderServer(failed, async (_request, response, body) => {
          const input = Array.isArray(body.input) ? body.input : [];
          const text = JSON.stringify(input);
          const tools = restartToolNames(body);
          const ordinal = ++sequence;
          const reply = (value: string) =>
            body.stream === false
              ? writeRestartJsonText(response, value, String(ordinal))
              : writeOpenAiResponsesText(response, {
                  text: value,
                  messageId: `msg_yield_${ordinal}`,
                  responseId: `resp_yield_${ordinal}`,
                });
          if (!tools.length) {
            reply("Synthetic yield restart session");
            return;
          }
          const call = (name: string, args: object) => {
            const wireName = tools.includes(name) ? name : "dispatch_action";
            expect(tools).toContain(wireName);
            if (name === "exec") {
              lastExecOrdinal = ordinal;
            }
            writeRestartToolCall(
              response,
              "yield",
              wireName,
              wireName === name ? args : { id: name, args },
              ordinal,
            );
          };
          if (text.includes(childPrompt) && !text.includes(rootPrompt)) {
            childCalls++;
            childRequests.push({
              phase,
              ordinal,
              execResult:
                lastExecOrdinal !== undefined &&
                input.some(
                  (item) =>
                    isRecord(item) &&
                    item.type === "function_call_output" &&
                    item.call_id === `call_yield_${lastExecOrdinal}`,
                ),
            });
            if (childRequests.length > 16) {
              childRequests.shift();
            }
            if (mainTool) {
              if (text.includes("The Gateway restarted while you were working.")) {
                childRestartRequests++;
                reply("CHILD_RECONCILED_RESTART");
                return;
              }
              if (text.includes("RUN_MAIN_LANE_TOOL")) {
                mainToolCalls++;
                call("exec", {
                  command: `printf ready > '${toolMarker.replaceAll("'", "'\\''")}' ; sleep 600`,
                  yieldMs: 120_000,
                  timeoutSeconds: 600,
                });
              } else {
                call("sessions_yield", { waitFor: "message" });
              }
              return;
            }
            if (action === "completed-before" || text.includes("CONTINUE_PARKED_CHILD")) {
              if (action === "policy-unavailable") {
                finishChild = () => reply("PARKED_CHILD_COMPLETED");
              } else {
                reply("PARKED_CHILD_COMPLETED");
              }
              return;
            }
            if (stoppedRoot) {
              // Shutdown interrupts this executing child; its root must reconcile the work.
              return;
            }
            call("sessions_yield", {
              waitFor: "message",
              acknowledgment: "Waiting for the requester continuation.",
            });
            return;
          }
          assert(text.includes(rootPrompt), "Unexpected synthetic requester input");
          const spawned = input.find(
            (item) => isRecord(item) && item.type === "function_call_output",
          );
          if (!spawned) {
            call("sessions_spawn", {
              taskName: "message_waiting_child",
              agentId: childAgent,
              task: childPrompt,
              context: "isolated",
              visible: true,
              expectsCompletionMessage: true,
            });
            return;
          }
          const receipt = findSubagentSpawnReceipt(spawned.output);
          assert(receipt, `Spawn did not return an accepted child: ${String(spawned.output)}`);
          childKey ??= receipt.childSessionKey;
          childRunId ??= receipt.runId;
          const recoveryInput =
            text.includes("The Gateway restarted while you were working.") ||
            text.includes("CONTINUE_RETAINED_CHILD");
          if (recoveryInput) {
            rootResumes++;
          }
          if (action === "parked-message" && rootResumes === 0) {
            if (text.includes("Waiting for the requester continuation.")) {
              // A retained pause notice must finish before the later user input can run.
              reply("REQUESTER_ACKNOWLEDGED_PAUSED_CHILD");
              return;
            }
            yieldRoot = () => call("sessions_yield", {});
            return;
          }
          if (stoppedRoot) {
            if (text.includes("Gateway stopped")) {
              reply("ROOT_RECONCILED_STOPPED_CHILD");
              return;
            }
            if (mainTool && phase === "child parked") {
              // Hold this requester turn while its child executes the long-running tool.
              return;
            }
            if (
              action === "root-background-stopped" ||
              (mainTool && text.includes("already_pending"))
            ) {
              reply("REQUESTER_WAITING_FOR_BACKGROUND_RESULT");
              return;
            }
            call("sessions_yield", {});
            return;
          }
          if (recoveryInput) {
            finishRequester = () => {
              requesterFinished = true;
              reply("REQUESTER_FINISHED_WITHOUT_CONTINUATION");
            };
            if (requesterFinished && !text.includes("CONTINUE_RETAINED_CHILD")) {
              // A retained pause notice can arrive after the restart turn finishes.
              reply("REQUESTER_ACKNOWLEDGED_PAUSED_CHILD");
              return;
            }
            if (text.includes("PARKED_CHILD_COMPLETED")) {
              reply("REQUESTER_RECEIVED_CHILD_COMPLETION");
              return;
            }
            if (sentContinuation) {
              if (action === "policy-unavailable" && !yieldedAfterOutage) {
                yieldRequester = () => {
                  yieldedAfterOutage = true;
                  call("sessions_yield", {});
                };
                return;
              }
              if (text.includes("already_pending") || text.includes("nothing_pending")) {
                reply("WAITING_FOR_CHILD_COMPLETION");
              } else {
                call("sessions_yield", {});
              }
              return;
            }
            continueChild = () => {
              if (action === "completed-before") {
                call("sessions_history", { sessionKey: childKey });
                return;
              }
              sentContinuation = true;
              call("sessions_send", {
                sessionKey: childKey,
                message: "CONTINUE_PARKED_CHILD",
                timeoutSeconds: 0,
              });
            };
          }
          // Hold the model response until the fixture chooses yield, restart, or continuation.
        }),
    });
    const model = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${reservation.claim.port}/v1`);
    const base = restartResumeConfig(model);
    const origin = "https://control.restart.example.test";
    const user = "person@restart.example.test";
    const scopes: OperatorScope[] = ["operator.admin", "operator.read", "operator.write"];
    if (action === "policy-unavailable") {
      base.gateway = {
        ...base.gateway,
        trustedProxies: ["127.0.0.1", "::1"],
        auth: {
          mode: "trusted-proxy",
          token: undefined,
          trustedProxy: {
            userHeader: "x-forwarded-user",
            requiredHeaders: ["x-forwarded-proto"],
            allowLoopback: true,
            deviceAutoApprove: { enabled: true, scopes },
          },
          identityScopes: { [user]: scopes },
        },
        controlUi: { enabled: false, allowedOrigins: [origin] },
      };
    }
    const instance = await createOpenClawTestInstance({
      name: "gateway-yield-restart",
      signal,
      config: {
        ...base,
        agents: {
          ...base.agents,
          entries: { main: { subagents: { allowAgents: ["main", "other"] } }, other: {} },
        },
        tools: {
          ...base.tools,
          allow: [
            "sessions_spawn",
            "sessions_yield",
            "sessions_send",
            "sessions_history",
            ...(mainTool ? ["exec"] : []),
          ],
        },
      },
      env: { ...restartEnv, OPENCLAW_NO_RESPAWN: "1" },
    });
    toolMarker = instance.state.path("long-tool-started");
    const readChildRun = () => {
      const db = openNodeSqliteDatabase(path.join(instance.stateDir, "state", "openclaw.sqlite"), {
        readOnly: true,
      });
      try {
        const row = db
          .prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
          .get(childRunId!);
        assert(
          typeof row?.payload_json === "string",
          `Child outcome disappeared before delivery: ${JSON.stringify(db.prepare("SELECT kind, occurred_at, payload_json FROM session_state_events WHERE run_id = ?").all(childRunId!))}`,
        );
        const stored: unknown = JSON.parse(row.payload_json);
        assert(isRecord(stored));
        return isRecord(stored.parentCompletion) ? stored.parentCompletion : stored;
      } finally {
        db.close();
      }
    };
    if (action === "policy-unavailable") {
      const pluginDir = instance.state.path("recovery-access");
      await writeRestartPlugin(
        pluginDir,
        {
          id: "recovery-access",
          activation: { onStartup: true },
          configSchema: { type: "object", properties: {} },
        },
        `import { existsSync, unlinkSync, writeFileSync } from "node:fs";
        export default { id: "recovery-access", register(api) {
          const marker = ${JSON.stringify(instance.state.path("policy-unavailable"))};
          const grant = (recovered) => ({ grantId: "recovery-proof-grant", signal: new AbortController().signal,
            assertCurrent() {
              if (recovered && existsSync(marker + ".ready")) {
                unlinkSync(marker + ".ready");
                api.logger.info("RECOVERY_POLICY_UNAVAILABLE_INJECTED");
                throw new Error("synthetic transient policy outage");
              }
            }
          });
          api.registerGatewayAccessPolicy({ authorize: () => grant(false), resume: () => grant(true) });
          api.on("subagent_delivery_target", () => {
            if (existsSync(marker)) {
              unlinkSync(marker);
              writeFileSync(marker + ".ready", "one unavailable evaluation");
            }
          });
        } };`,
      );
      await instance.state.writeConfig({
        ...JSON.parse(await readFile(instance.configPath, "utf8")),
        plugins: {
          enabled: true,
          load: { paths: [pluginDir] },
          allow: ["recovery-access", "openai"],
          slots: { memory: "none" },
          entries: {
            "recovery-access": { enabled: true, hooks: { allowConversationAccess: true } },
          },
        },
      });
    }
    const connect = async () => {
      if (action !== "policy-unavailable") {
        return connectRestartClient(instance, {}, signal);
      }
      const connection = await connectProxiedRestartOperator(instance, {
        user,
        origin,
        scopes,
        signal,
      });
      return { request: connection.call, stopAndWait: connection.close };
    };
    let client: Pick<GatewayClient, "request" | "stopAndWait"> | undefined;
    let phase = "startup";
    onTestFailed(() => {
      process.stderr.write(
        `yield restart ${JSON.stringify({ phase, childCallsAfterStop, childRestartRequests, mainToolCalls, childRequests })}\n${instance.logs()}\n`,
      );
    });
    await runQaGatewayFixture(
      async () => {
        await instance.startGateway();
        client = await connect();
        if (stoppedRoot || parkedRoot) {
          await client.request("sessions.create", { key: rootKey, agentId: "main" });
        }
        const root = await client.request<{ runId: string }>("chat.send", {
          sessionKey: rootKey,
          message: rootPrompt,
          idempotencyKey: randomUUID(),
          deliver: false,
        });
        phase = "child parked";
        await vi.waitFor(
          async () => {
            await Promise.race([failed.promise, Promise.resolve()]);
            assert(childKey, "Requester has not received its child receipt");
          },
          { timeout: 30_000 },
        );
        assert(childKey);
        assert(childRunId);
        if (mainTool) {
          expect(
            await client.request("agent.wait", { runId: childRunId, timeoutMs: 30_000 }),
          ).toMatchObject({ status: "ok", yielded: true });
          const continuation = await client.request<{ runId: string }>("chat.send", {
            sessionKey: childKey,
            message: "RUN_MAIN_LANE_TOOL",
            idempotencyKey: randomUUID(),
            deliver: false,
          });
          childRunId = continuation.runId;
          await vi.waitFor(() => expect(existsSync(toolMarker)).toBe(true), { timeout: 30_000 });
          expect(readChildRun()).toMatchObject({
            spawnMode: "run",
            expectsCompletionMessage: true,
            execution: { status: "running" },
          });
        } else if (!stoppedRoot) {
          expect(
            await client.request("agent.wait", { runId: childRunId, timeoutMs: 30_000 }),
          ).toMatchObject(
            action === "completed-before" ? { status: "ok" } : { status: "ok", yielded: true },
          );
        } else {
          await vi.waitFor(() => expect(childCalls).toBe(1), { timeout: 30_000 });
        }
        if (action === "parked-message") {
          assert(yieldRoot);
          yieldRoot();
        }
        if (parkedRoot) {
          expect(
            await client.request("agent.wait", { runId: root.runId, timeoutMs: 30_000 }),
          ).toMatchObject({ status: "ok", yielded: true });
          // agent.wait observes the yielded terminal before controller cleanup.
          // Restart only after the real root execution and terminal write have drained.
          if (action !== "parked-message") {
            await vi.waitFor(
              async () => {
                const history = await client!.request<{
                  sessionInfo: { hasActiveRun: boolean };
                }>("chat.history", { sessionKey: rootKey });
                expect(history.sessionInfo.hasActiveRun).toBe(false);
              },
              { timeout: 15_000 },
            );
          }
        }
        const parkedKey = restartRoot ? rootKey : childKey;
        const parked = readRestartSession(
          instance.state.agentDir(restartRoot ? "main" : childAgent),
          parkedKey,
        );
        if (action !== "root-background-stopped") {
          expect(parked?.lifecycleRunId).toEqual(expect.any(String));
          expect(parked?.status).toBeUndefined();
        }
        const callsBeforeRestart = childCalls;
        if (action === "root-background-stopped") {
          expect(
            await client.request("agent.wait", { runId: root.runId, timeoutMs: 15_000 }),
          ).toMatchObject({ status: "ok" });
        }
        phase = "shutdown";
        await instance.stopGateway();
        childCallsAfterStop = childCalls;
        phase = "stopped";
        await client.stopAndWait();
        client = undefined;
        if (mainTool) {
          expect(childCallsAfterStop).toBe(callsBeforeRestart);
          expect(readChildRun()).toMatchObject({
            execution: {
              status: "terminal",
              outcome: { status: "error", error: "Gateway stopped" },
            },
            completion: { required: true },
            delivery: { status: "pending" },
          });
        }
        if (legacyShutdown) {
          // Previous Gateways recorded this exact quiet-kill state during shutdown.
          // Reproduce the persisted upgrade input after the real main-lane tool is aborted.
          const legacy = readChildRun();
          assert(isRecord(legacy.execution));
          Object.assign(legacy, {
            endedReason: "subagent-killed",
            completion: { required: true },
            cleanupHandled: true,
            cleanupCompletedAt: legacy.execution.endedAt,
            suppressAnnounceReason: "killed",
            killReconciliation: { killedAt: legacy.execution.endedAt, suppressTaskDelivery: true },
          });
          const db = openNodeSqliteDatabase(
            path.join(instance.stateDir, "state", "openclaw.sqlite"),
          );
          try {
            db.prepare("UPDATE subagent_runs SET payload_json = ? WHERE run_id = ?").run(
              JSON.stringify(legacy),
              childRunId!,
            );
          } finally {
            db.close();
          }
        }
        if (action !== "root-background-stopped") {
          expect
            .soft(
              readRestartSession(
                instance.state.agentDir(restartRoot ? "main" : childAgent),
                parkedKey,
              )?.resumeAfterRestart,
            )
            .toBeDefined();
        }
        if (action === "parked-message") {
          expect(readRestartSession(instance.state.agentDir("main"), rootKey)?.lifecycleRunId).toBe(
            root.runId,
          );
        }
        phase = "restart startup";
        await instance.startGateway();
        phase = "restart recovery";
        client = await connect();
        await vi.waitFor(
          () =>
            stoppedRoot || action === "parked-message"
              ? expect(
                  readRestartSession(
                    instance.state.agentDir(restartRoot ? "main" : childAgent),
                    parkedKey,
                  )?.resumeAfterRestart,
                ).toBeUndefined()
              : expect(rootResumes).toBe(1),
          { timeout: 20_000 },
        );
        if (action === "parked-message") {
          expect(rootResumes).toBe(0);
          expect(readRestartSession(instance.state.agentDir("main"), rootKey)?.lifecycleRunId).toBe(
            root.runId,
          );
          await client.request("chat.send", {
            sessionKey: rootKey,
            message: "CONTINUE_RETAINED_CHILD",
            idempotencyKey: randomUUID(),
            deliver: false,
          });
          await vi.waitFor(() => expect(rootResumes).toBe(1), { timeout: 15_000 });
        }
        if (stoppedRoot) {
          phase = "root reconciles its stopped child execution";
          await vi.waitFor(
            async () => {
              const history = await client!.request<{ messages: unknown[] }>("chat.history", {
                sessionKey: rootKey,
              });
              expect(
                JSON.stringify(history.messages).includes("ROOT_RECONCILED_STOPPED_CHILD"),
              ).toBe(true);
              expect(history.messages).not.toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ customType: "run-failed-before-reply" }),
                ]),
              );
            },
            { timeout: 15_000 },
          );
          if (mainTool) {
            // The direct chat.send continuation owns its own restart, while the
            // stopped delegated run still owes its original parent a terminal notice.
            await vi.waitFor(
              async () => {
                const history = await client!.request<{
                  messages: unknown[];
                  sessionInfo: { hasActiveRun: boolean };
                }>("chat.history", { sessionKey: childKey });
                expect(JSON.stringify(history.messages)).toContain("CHILD_RECONCILED_RESTART");
                expect(history.sessionInfo.hasActiveRun).toBe(false);
              },
              { timeout: 15_000 },
            );
            expect(childRestartRequests).toBe(1);
            expect(mainToolCalls).toBe(1);
            expect(childCalls).toBe(callsBeforeRestart + 1);
            await vi.waitFor(
              () => {
                const db = openNodeSqliteDatabase(
                  path.join(instance.stateDir, "state", "openclaw.sqlite"),
                  { readOnly: true },
                );
                try {
                  const removals = db
                    .prepare(
                      "SELECT payload_json FROM session_state_events WHERE session_key = ? AND run_id = ? AND kind = 'child_delivery_removed'",
                    )
                    .all(rootKey, childRunId!);
                  if (removals.length === 0) {
                    expect(readChildRun().delivery).toMatchObject({ status: "delivered" });
                  }
                  for (const removal of removals) {
                    expect(JSON.parse(String(removal.payload_json))).toMatchObject({
                      outcome: "delivered",
                      previousStatus: "delivered",
                      deliveredAt: expect.any(Number),
                    });
                  }
                } finally {
                  db.close();
                }
              },
              { timeout: 15_000 },
            );
          } else {
            expect(childCalls).toBe(callsBeforeRestart);
          }
          return;
        }
        phase = "restored parked child";
        if (action === "parked-message") {
          const history = await client.request<{ messages: unknown[] }>("chat.history", {
            sessionKey: rootKey,
          });
          expect(JSON.stringify(history.messages)).not.toContain(
            "The Gateway restarted while you were working.",
          );
        }
        const restored = readRestartSession(instance.state.agentDir(childAgent), childKey);
        process.stdout.write(
          `[yield-restart-proof] ${JSON.stringify({
            childKey,
            before: { lifecycleRunId: parked?.lifecycleRunId, status: parked?.status },
            after: { lifecycleRunId: restored?.lifecycleRunId, status: restored?.status },
            childCalls,
            rootResumes,
          })}\n`,
        );
        if (action === "completed-before") {
          expect(restored).toMatchObject({ status: "done", lastRunId: childRunId });
        } else {
          expect(restored?.status).toBeUndefined();
          expect(restored?.lifecycleRunId).toBe(childRunId);
        }
        expect(restored?.resumeAfterRestart).toBeUndefined();
        expect(childCalls).toBe(callsBeforeRestart);
        if (action === "finish") {
          phase = "requester finishes without continuation";
          assert(finishRequester);
          finishRequester();
          await vi.waitFor(
            async () => {
              const history = await client!.request<{
                messages: unknown[];
                sessionInfo: { hasActiveRun: boolean };
              }>("chat.history", { sessionKey: rootKey });
              expect(JSON.stringify(history.messages)).toContain(
                "REQUESTER_FINISHED_WITHOUT_CONTINUATION",
              );
              expect(history.sessionInfo.hasActiveRun).toBe(false);
            },
            { timeout: 15_000 },
          );
          // An unclaimed restored wait survives this committed requester turn.
          const retained = readRestartSession(instance.state.agentDir(childAgent), childKey);
          expect(retained?.status).toBeUndefined();
          expect(retained?.lifecycleRunId).toBe(parked?.lifecycleRunId);
          expect(retained?.activeWriterRunId).toBe(parked?.activeWriterRunId);
          expect(childCalls).toBe(callsBeforeRestart);
          const requestsBeforeContinuation = rootResumes;
          await client.request("chat.send", {
            sessionKey: rootKey,
            message: "CONTINUE_RETAINED_CHILD",
            idempotencyKey: randomUUID(),
            deliver: false,
          });
          await vi.waitFor(() => expect(rootResumes).toBe(requestsBeforeContinuation + 1), {
            timeout: 15_000,
          });
        }
        phase = "requester continues child";
        if (action === "completed-before") {
          // Recovery may already see the durable result in the parent transcript.
          continueChild?.();
        } else {
          assert(continueChild);
          continueChild();
          if (action === "policy-unavailable") {
            await vi.waitFor(
              () => {
                expect(finishChild).toBeDefined();
                expect(yieldRequester).toBeDefined();
              },
              { timeout: 15_000 },
            );
            await writeFile(instance.state.path("policy-unavailable"), "one transient outage");
            finishChild!();
            // Completion admission waits behind this turn; release it before injecting failure.
            assert(yieldRequester);
            yieldRequester();
            await vi.waitFor(
              () => {
                expect(instance.logs()).toContain("RECOVERY_POLICY_UNAVAILABLE_INJECTED");
                expect(instance.logs()).toContain(
                  "Gateway access policy is unavailable; retry the operation.",
                );
              },
              { timeout: 15_000 },
            );
          }
        }
        await vi.waitFor(
          async () => {
            const history = await client!.request<{ messages: unknown[] }>("chat.history", {
              sessionKey: rootKey,
            });
            expect(JSON.stringify(history.messages)).toContain(
              "REQUESTER_RECEIVED_CHILD_COMPLETION",
            );
          },
          { timeout: 30_000 },
        );
        if (action === "completed-before") {
          expect(childCalls).toBe(callsBeforeRestart);
        }
        if (action === "policy-unavailable") {
          expect(instance.logs()).toContain("RECOVERY_POLICY_UNAVAILABLE_INJECTED");
          expect(instance.logs()).not.toContain("Restart recovery could not admit this input");
        }
      },
      async () => {
        await client?.stopAndWait();
      },
      instance.cleanup,
      async () => reservation.listener.closeAllConnections(),
      reservation.releaseListener,
      reservation.claim.release,
    );
  },
);
