import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import { findSubagentSpawnReceipt } from "../src/gateway/server.subagent-stop-settlement.product.test-support.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import { restartResumeConfig } from "./gateway-restart-resume.test-support.js";
import {
  connectRestartClient,
  readRestartSession,
  restartEnv,
  restartProviderServer,
  restartToolNames,
  writeRestartJsonText,
  writeRestartToolCall,
} from "./gateway-restart.test-support.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { createDeferred } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

it.skipIf(process.platform === "win32").for(["continue", "finish", "root-source-stopped"] as const)(
  "preserves yielded work through an actual Gateway restart (%s)",
  { timeout: 180_000 },
  async (action, { signal, onTestFailed }) => {
    const parkedRoot = action === "root-source-stopped";
    const rootKey = parkedRoot
      ? "agent:main:dashboard:yield-restart"
      : "agent:main:main:thread:yield-restart";
    const rootPrompt = "YIELD_RESTART_REQUESTER";
    const childPrompt = "YIELD_RESTART_CHILD";
    const failed = createDeferred<never>();
    void failed.promise.catch(() => {});
    let childKey: string | undefined;
    let childRunId: string | undefined;
    let childCalls = 0;
    let rootCalls = 0;
    let rootResumes = 0;
    let sequence = 0;
    let sentContinuation = false;
    let continueChild: (() => void) | undefined;
    let finishRequester: (() => void) | undefined;
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
            if (text.includes("CONTINUE_PARKED_CHILD")) {
              reply("PARKED_CHILD_COMPLETED");
              return;
            }
            if (action === "root-source-stopped") {
              // Shutdown interrupts this executing child, removing the root's wake source.
              return;
            }
            call("sessions_yield", {
              waitFor: "message",
              acknowledgment: "Waiting for the requester continuation.",
            });
            return;
          }
          assert(text.includes(rootPrompt), "Unexpected synthetic requester input");
          rootCalls++;
          const spawned = input.find(
            (item) => isRecord(item) && item.type === "function_call_output",
          );
          if (!spawned) {
            call("sessions_spawn", {
              taskName: "message_waiting_child",
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
          if (text.includes("The Gateway restarted while you were working.")) {
            rootResumes++;
          }
          if (parkedRoot) {
            call("sessions_yield", {});
            return;
          }
          if (text.includes("The Gateway restarted while you were working.")) {
            finishRequester = () => reply("REQUESTER_FINISHED_WITHOUT_CONTINUATION");
            if (text.includes("PARKED_CHILD_COMPLETED")) {
              reply("REQUESTER_RECEIVED_CHILD_COMPLETION");
              return;
            }
            if (sentContinuation) {
              call("sessions_yield", {});
              return;
            }
            continueChild = () => {
              sentContinuation = true;
              call("sessions_send", {
                sessionKey: childKey,
                message: "CONTINUE_PARKED_CHILD",
                timeoutSeconds: 0,
              });
            };
          }
          // The requester remains alive before and after restart. Only an explicit
          // continuation message should resume its parked child.
        }),
    });
    const model = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${reservation.claim.port}/v1`);
    const base = restartResumeConfig(model);
    const instance = await createOpenClawTestInstance({
      name: "gateway-yield-restart",
      signal,
      config: {
        ...base,
        tools: { ...base.tools, allow: ["sessions_spawn", "sessions_yield", "sessions_send"] },
      },
      env: { ...restartEnv, OPENCLAW_NO_RESPAWN: "1" },
    });
    let client: GatewayClient | undefined;
    let phase = "startup";
    onTestFailed(() => {
      process.stderr.write(`yield restart phase=${phase}\n${instance.logs()}\n`);
    });
    await runQaGatewayFixture(
      async () => {
        await instance.startGateway();
        client = await connectRestartClient(instance, {}, signal);
        if (parkedRoot) {
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
        if (action !== "root-source-stopped") {
          expect(
            await client.request("agent.wait", { runId: childRunId, timeoutMs: 30_000 }),
          ).toMatchObject({ status: "ok", yielded: true });
        } else {
          await vi.waitFor(() => expect(childCalls).toBe(1), { timeout: 30_000 });
        }
        if (parkedRoot) {
          expect(
            await client.request("agent.wait", { runId: root.runId, timeoutMs: 30_000 }),
          ).toMatchObject({ status: "ok", yielded: true });
          // agent.wait observes the yielded terminal before controller cleanup.
          // Restart only after the real root execution and terminal write have drained.
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
        const parkedKey = parkedRoot ? rootKey : childKey;
        const parked = readRestartSession(instance.state.agentDir("main"), parkedKey);
        expect(parked?.lifecycleRunId).toEqual(expect.any(String));
        expect(parked?.status).toBeUndefined();
        const callsBeforeRestart = childCalls;
        const rootCallsBeforeRestart = rootCalls;
        phase = "restart";
        await instance.stopGateway();
        await client.stopAndWait();
        client = undefined;
        expect
          .soft(readRestartSession(instance.state.agentDir("main"), parkedKey)?.resumeAfterRestart)
          .toBeDefined();
        await instance.startGateway();
        client = await connectRestartClient(instance, {}, signal);
        await vi.waitFor(
          () =>
            parkedRoot
              ? expect(
                  readRestartSession(instance.state.agentDir("main"), parkedKey)
                    ?.resumeAfterRestart,
                ).toBeUndefined()
              : expect(rootResumes).toBe(1),
          { timeout: 20_000 },
        );
        if (action === "root-source-stopped") {
          phase = "root wait lost its child execution";
          await vi.waitFor(
            async () => {
              const closed = readRestartSession(instance.state.agentDir("main"), rootKey);
              expect(closed?.status).toBe("failed");
              expect(closed?.lifecycleRunId).toBeUndefined();
              expect(closed?.lastRunError).toMatch(/wait|child|restart/i);
              const history = await client!.request<{ messages: unknown[] }>("chat.history", {
                sessionKey: rootKey,
              });
              const notices = history.messages.filter(
                (message) => isRecord(message) && message.customType === "run-failed-before-reply",
              );
              expect(notices).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    display: true,
                    content: expect.stringContaining(
                      "the child completion this run was waiting for can no longer arrive",
                    ),
                    openclawRunError: expect.objectContaining({ runId: root.runId }),
                  }),
                ]),
              );
            },
            { timeout: 15_000 },
          );
          expect(rootCalls).toBe(rootCallsBeforeRestart);
          expect(rootResumes).toBe(0);
          return;
        }
        phase = "restored parked child";
        const restored = readRestartSession(instance.state.agentDir("main"), parkedKey);
        process.stdout.write(
          `[yield-restart-proof] ${JSON.stringify({
            childKey,
            before: { lifecycleRunId: parked?.lifecycleRunId, status: parked?.status },
            after: { lifecycleRunId: restored?.lifecycleRunId, status: restored?.status },
            childCalls,
            rootResumes,
          })}\n`,
        );
        expect(restored?.status).toBeUndefined();
        expect(restored?.lifecycleRunId).toBe(parked?.lifecycleRunId);
        expect(restored?.resumeAfterRestart).toBeUndefined();
        expect(childCalls).toBe(callsBeforeRestart);
        if (action === "finish") {
          phase = "requester finishes without continuation";
          assert(finishRequester);
          finishRequester();
          await vi.waitFor(
            () => {
              const closed = readRestartSession(instance.state.agentDir("main"), childKey!);
              expect(closed?.status).toBe("failed");
              expect(closed?.lastRunError).toContain("Requester finished");
              expect(closed?.lifecycleRunId).toBeUndefined();
              expect(closed?.activeWriterRunId).toBe(parked?.activeWriterRunId);
            },
            { timeout: 15_000 },
          );
          expect(childCalls).toBe(callsBeforeRestart);
          return;
        }
        phase = "requester continues child";
        assert(continueChild);
        continueChild();
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
