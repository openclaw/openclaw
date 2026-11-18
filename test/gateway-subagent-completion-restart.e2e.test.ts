import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { readTranscriptExportSnapshotReadOnlySync } from "../src/config/sessions/session-accessor.sqlite-export-read.js";
import type { GatewayClient } from "../src/gateway/client.js";
import {
  findSubagentRecords,
  findSubagentSpawnReceipt,
} from "../src/gateway/server.subagent-stop-settlement.product.test-support.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { openNodeSqliteDatabase } from "../src/infra/node-sqlite.js";
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

it
  .skipIf(process.platform === "win32")
  .for([
    "nested",
    "captured",
    "announcing",
    "announcing-crash",
    "private-announcing",
    "private-announcing-crash",
    "busy-requester",
    "retrying-requester",
    "unmarked-requester",
    "stale-settle-requester",
  ] as const)(
  "recovers session completion custody through a real Gateway restart (%s)",
  { timeout: 180_000 },
  async (kind, { signal, onTestFailed, onTestFinished }) => {
    const interruptAnnounce = kind.includes("announcing");
    const privateContinuation = kind.startsWith("private-announcing");
    const busyRequester = kind === "busy-requester";
    const retryingRequester = kind === "retrying-requester";
    const rootKey = "agent:main:dashboard:restart-hub";
    let childKey: string | undefined;
    let siblingKey: string | undefined;
    let leaf: { runId: string; childSessionKey: string } | undefined;
    let initialized: { runId: string; childSessionKey: string }[] = [];
    const failed = createDeferred<never>();
    void failed.promise.catch(() => {});
    let sequence = 0;
    let restarted = false;
    let leafStarted = false;
    let childStarted = false;
    let childRunId: string | undefined;
    let capturedRunId: string | undefined;
    let finishCaptured: (() => void) | undefined;
    let finishChild: (() => void) | undefined;
    let announcing = false;
    let completedReplies = 0;
    let rootReceivedRecovery = false;
    let resumedChildRequests = 0;
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
                  messageId: `msg_custody_${ordinal}`,
                  responseId: `resp_custody_${ordinal}`,
                });
          const call = (name: string, args: object) => {
            const wireName = tools.includes(name) ? name : "dispatch_action";
            expect(tools).toContain(wireName);
            writeRestartToolCall(
              response,
              "custody",
              wireName,
              wireName === name ? args : { id: name, args },
              ordinal,
            );
          };
          if (!tools.length) {
            reply("Synthetic restart custody session");
            return;
          }
          if (text.includes("CUSTODY_ROOT_TASK")) {
            rootReceivedRecovery ||= text.includes("Child runs do not resume independently.");
            const receipts = input.flatMap((item) =>
              isRecord(item) && item.type === "function_call_output"
                ? findSubagentRecords(
                    item.output,
                    (value) =>
                      value.status === "accepted" &&
                      typeof value.runId === "string" &&
                      typeof value.sessionKey === "string",
                  )
                : [],
            );
            const childReceipt = receipts.find((value) => value.sessionKey === childKey);
            const siblingReceipt = receipts.find((value) => value.sessionKey === siblingKey);
            if (typeof childReceipt?.runId === "string") {
              childRunId ??= childReceipt.runId;
            }
            if (typeof siblingReceipt?.runId === "string") {
              capturedRunId ??= siblingReceipt.runId;
            }
            if (
              text.includes("CAPTURED_CUSTODY_RESULT") &&
              (kind !== "nested" || text.includes("NESTED_CHILD_RECONCILED"))
            ) {
              if (retryingRequester && !restarted) {
                response.writeHead(400, { "content-type": "application/json" });
                response.end(
                  JSON.stringify({ error: { message: "Synthetic announce unavailable" } }),
                );
                return;
              }
              if (interruptAnnounce && !restarted) {
                announcing = true;
                return;
              }
              completedReplies++;
              reply("HUB_RECEIVED_RESTART_COMPLETION");
            } else if (!childRunId) {
              call("sessions_send", {
                sessionKey: childKey,
                message: "CUSTODY_CHILD_TASK",
                timeoutSeconds: 0,
              });
            } else if (!capturedRunId) {
              call("sessions_send", {
                sessionKey: siblingKey,
                message: "CUSTODY_SIBLING_TASK",
                timeoutSeconds: 0,
              });
            } else if (busyRequester || retryingRequester) {
              if (restarted || retryingRequester) {
                reply("HUB_WAITING_FOR_OWNED_RESULTS");
              }
            } else if (
              privateContinuation ||
              text.includes("already_pending") ||
              text.includes("nothing_pending")
            ) {
              reply("HUB_WAITING_FOR_OWNED_RESULTS");
            } else {
              call("sessions_yield", {});
            }
            return;
          }
          if (text.includes("CUSTODY_SETUP_TASK")) {
            initialized = input.flatMap((item) => {
              if (!isRecord(item) || item.type !== "function_call_output") {
                return [];
              }
              const receipt = findSubagentSpawnReceipt(item.output);
              return receipt ? [receipt] : [];
            });
            childKey = initialized[0]?.childSessionKey;
            siblingKey = initialized[1]?.childSessionKey;
            if (initialized.length < 2) {
              call("sessions_spawn", {
                task: "INITIALIZE_CUSTODY_SESSION",
                context: "isolated",
                visible: true,
                expectsCompletionMessage: false,
              });
            } else {
              reply("CUSTODY_SETUP_COMPLETE");
            }
            return;
          }
          if (text.includes("CUSTODY_CHILD_TASK")) {
            childStarted = true;
            if (restarted) {
              resumedChildRequests++;
              reply("NESTED_CHILD_RECONCILED");
              return;
            }
            if (kind !== "nested") {
              finishChild = () => reply("NESTED_CHILD_RECONCILED");
              return;
            }
            leaf ??= input.flatMap((item) => {
              const receipt =
                isRecord(item) && item.type === "function_call_output"
                  ? findSubagentSpawnReceipt(item.output)
                  : undefined;
              return receipt ? [receipt] : [];
            })[0];
            call(
              leaf ? "sessions_yield" : "sessions_spawn",
              leaf
                ? {}
                : {
                    task: "CUSTODY_LEAF_TASK",
                    context: "isolated",
                    expectsCompletionMessage: true,
                  },
            );
            return;
          }
          if (text.includes("CUSTODY_SIBLING_TASK")) {
            finishCaptured = () => reply("CAPTURED_CUSTODY_RESULT");
            return;
          }
          if (text.includes("INITIALIZE_CUSTODY_SESSION")) {
            reply("SESSION_READY");
            return;
          }
          assert(text.includes("CUSTODY_LEAF_TASK"), "Unexpected synthetic request");
          leafStarted = true;
        }),
    });
    const model = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${reservation.claim.port}/v1`);
    const base = restartResumeConfig(model);
    const instance = await createOpenClawTestInstance({
      name: "gateway-completion-restart",
      signal,
      config: {
        ...base,
        tools: { ...base.tools, allow: ["sessions_send", "sessions_spawn", "sessions_yield"] },
      },
      env: { ...restartEnv, OPENCLAW_NO_RESPAWN: "1" },
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", instance.stateDir);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const readRun = (runId: string) => {
      const db = openNodeSqliteDatabase(path.join(instance.stateDir, "state", "openclaw.sqlite"), {
        readOnly: true,
      });
      try {
        const row = db
          .prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
          .get(runId);
        assert(typeof row?.payload_json === "string");
        const stored: unknown = JSON.parse(row.payload_json);
        assert(isRecord(stored));
        return isRecord(stored.parentCompletion) ? stored.parentCompletion : stored;
      } finally {
        db.close();
      }
    };
    const readCapturedInputs = () => {
      const agentDir = instance.state.agentDir("main");
      const session = readRestartSession(agentDir, rootKey);
      assert(typeof session?.sessionId === "string");
      return readTranscriptExportSnapshotReadOnlySync({
        agentId: "main",
        sessionKey: rootKey,
        sessionId: session.sessionId,
        storePath: path.join(agentDir, "openclaw-agent.sqlite"),
      })?.events.filter((event) => {
        if (!isRecord(event)) {
          return false;
        }
        if (busyRequester || retryingRequester) {
          return (
            event.type === "message" &&
            isRecord(event.message) &&
            event.message.role === "user" &&
            isRecord(event.message.provenance) &&
            event.message.provenance.sourceSessionKey === siblingKey &&
            event.message.provenance.sourceTool === "subagent_announce"
          );
        }
        if (privateContinuation) {
          // Pending-result summaries repeat the text; only the completion event is delivery.
          return (
            event.type === "custom_message" &&
            isRecord(event.details) &&
            Array.isArray(event.details.fragments) &&
            event.details.fragments.some(
              (fragment) =>
                isRecord(fragment) &&
                fragment.kind === "conversation-data" &&
                typeof fragment.text === "string" &&
                fragment.text.startsWith("[Internal task completion event]\n") &&
                fragment.text.includes("CAPTURED_CUSTODY_RESULT"),
            )
          );
        }
        const message =
          event.type === "message" && isRecord(event.message) && event.message.role === "user"
            ? event.message
            : undefined;
        return message && JSON.stringify(message.content).includes("CAPTURED_CUSTODY_RESULT");
      });
    };
    let client: GatewayClient | undefined;
    let phase = "startup";
    onTestFailed(() => {
      process.stderr.write(`completion restart phase=${phase}\n${instance.logs()}\n`);
    });
    await runQaGatewayFixture(
      async () => {
        await instance.startGateway();
        client = await connectRestartClient(instance, {}, signal);
        await client.request("sessions.create", { key: rootKey, agentId: "main" });
        const setup = await client.request<{ runId: string }>("chat.send", {
          sessionKey: rootKey,
          message: "CUSTODY_SETUP_TASK",
          idempotencyKey: randomUUID(),
          deliver: false,
        });
        expect(
          await client.request("agent.wait", { runId: setup.runId, timeoutMs: 15_000 }),
        ).toMatchObject({ status: "ok" });
        expect(initialized).toHaveLength(2);
        for (const child of initialized) {
          expect(
            await client.request("agent.wait", { runId: child.runId, timeoutMs: 15_000 }),
          ).toMatchObject({ status: "ok" });
        }
        const root = await client.request<{ runId: string }>("chat.send", {
          sessionKey: rootKey,
          message: "CUSTODY_ROOT_TASK",
          idempotencyKey: randomUUID(),
          deliver: false,
        });
        phase = "delegation accepted";
        await vi.waitFor(
          async () => {
            await Promise.race([failed.promise, Promise.resolve()]);
            assert(childRunId);
            assert(capturedRunId);
            assert(finishCaptured);
            expect(childStarted).toBe(true);
          },
          { timeout: 30_000 },
        );
        assert(childRunId);
        assert(capturedRunId);
        assert(finishCaptured);
        expect(readRun(childRunId)).toMatchObject({
          spawnMode: "session",
          completionTarget: "parent",
          completion: { required: true },
        });
        if (kind === "nested") {
          expect(
            await client.request("agent.wait", { runId: childRunId, timeoutMs: 15_000 }),
          ).toMatchObject({ status: "ok", yielded: true });
          await vi.waitFor(() => expect(leafStarted).toBe(true), { timeout: 15_000 });
        }
        if (!busyRequester) {
          expect(
            await client.request("agent.wait", { runId: root.runId, timeoutMs: 15_000 }),
          ).toMatchObject({
            status: "ok",
            ...(privateContinuation || retryingRequester ? {} : { yielded: true }),
          });
        }
        if (privateContinuation) {
          assert(finishChild);
          finishChild();
          await vi.waitFor(
            () => expect(readRun(childRunId!)).toMatchObject({ delivery: { status: "delivered" } }),
            { timeout: 15_000 },
          );
        }
        phase = "captured result awaiting requester cohort";
        finishCaptured();
        if (busyRequester || retryingRequester) {
          assert(finishChild);
          finishChild();
        }
        await vi.waitFor(
          () =>
            expect(readRun(capturedRunId!)).toMatchObject({
              spawnMode: "session",
              completionTarget: "parent",
              completion: { required: true, resultText: "CAPTURED_CUSTODY_RESULT" },
              delivery: {
                status: retryingRequester ? expect.stringMatching(/pending|delivered/) : "pending",
              },
            }),
          { timeout: 15_000 },
        );
        const before = await client.request<{ messages: unknown[] }>("chat.history", {
          sessionKey: rootKey,
        });
        if (!privateContinuation && !retryingRequester) {
          expect(JSON.stringify(before.messages)).not.toContain("CAPTURED_CUSTODY_RESULT");
        }
        if (retryingRequester) {
          phase = "retry pending after requester settled";
          await vi.waitFor(
            () => {
              expect(readRun(capturedRunId!).delivery).toMatchObject({
                status: "delivered",
                requesterDelivery: { state: "consumed" },
              });
              expect(
                readRestartSession(instance.state.agentDir("main"), rootKey)?.lifecycleRunId,
              ).toBeUndefined();
            },
            { timeout: 30_000 },
          );
        }
        if (interruptAnnounce) {
          phase = "requester announce in flight";
          assert(finishChild);
          if (!privateContinuation) {
            finishChild();
          }
          await vi.waitFor(() => expect(announcing).toBe(true), { timeout: 15_000 });
          await vi.waitFor(
            () =>
              expect(readRun(capturedRunId!)).toMatchObject({
                delivery: {
                  status: "pending",
                  requesterDelivery: {
                    state: "consumed",
                    runId: expect.any(String),
                  },
                },
              }),
            { timeout: 15_000 },
          );
        }
        phase = "restart";
        if (retryingRequester) {
          const current = readRestartSession(instance.state.agentDir("main"), rootKey);
          expect(current?.resumeAfterRestart).toBeUndefined();
          expect(current?.mainRestartRecovery).toBeUndefined();
          expect(current?.lifecycleRunId).toBeUndefined();
        }
        if (kind === "nested") {
          expect(readRun(childRunId)).toMatchObject({ pauseReason: "sessions_yield" });
        }
        if (kind.endsWith("-crash") || retryingRequester) {
          await instance.crashGateway();
        } else {
          await instance.stopGateway();
        }
        await client.stopAndWait();
        client = undefined;
        expect(readRun(capturedRunId)).toMatchObject({
          completion: { resultText: "CAPTURED_CUSTODY_RESULT" },
          // Shutdown can checkpoint custody before terminal delivery settlement finishes.
          delivery: {
            status: interruptAnnounce
              ? expect.stringMatching(/^(pending|delivered)$/)
              : retryingRequester
                ? "delivered"
                : "pending",
          },
        });
        if (interruptAnnounce) {
          expect(readRun(capturedRunId)).toMatchObject({
            delivery: { requesterDelivery: { state: "consumed" } },
          });
        }
        if (kind === "captured") {
          expect(readRun(childRunId)).toMatchObject({
            execution: { outcome: { status: "error", error: "Gateway stopped" } },
          });
        }
        if (kind === "unmarked-requester" || kind === "stale-settle-requester") {
          // Recreate the persisted incident state: a settled, unmarked requester still owes
          // this real child result. Change only the stopped fixture's requester markers.
          const db = openNodeSqliteDatabase(
            path.join(instance.state.agentDir("main"), "openclaw-agent.sqlite"),
          );
          try {
            db.prepare(
              "UPDATE session_nodes SET entry_json = json_remove(entry_json, '$.lifecycleRunId', '$.resumeAfterRestart', '$.mainRestartRecovery') WHERE session_key = ?",
            ).run(rootKey);
            if (kind === "stale-settle-requester") {
              db.prepare(
                "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.lifecycleRunId', ?, '$.resumeAfterRestart', json(?)) WHERE session_key = ?",
              ).run(
                "announce:requester-settle:main:retired-cohort:yield-1",
                JSON.stringify({ queuedInputIds: [], operatorSource: { kind: "unavailable" } }),
                rootKey,
              );
            }
          } finally {
            db.close();
          }
          const current = readRestartSession(instance.state.agentDir("main"), rootKey);
          if (kind === "unmarked-requester") {
            expect(current?.lifecycleRunId).toBeUndefined();
            expect(current?.resumeAfterRestart).toBeUndefined();
          }
          expect(current?.mainRestartRecovery).toBeUndefined();
          expect(readCapturedInputs()).toHaveLength(0);
          expect(readRun(capturedRunId).delivery).toMatchObject({ status: "pending" });
        }
        restarted = true;
        await instance.startGateway();
        client = await connectRestartClient(instance, {}, signal);
        phase = "completion delivery after restart";
        await vi.waitFor(
          async () => {
            const history = await client!.request<{ messages: unknown[] }>("chat.history", {
              sessionKey: rootKey,
            });
            if (!retryingRequester) {
              expect(JSON.stringify(history.messages)).toContain("HUB_RECEIVED_RESTART_COMPLETION");
              expect(history.messages).not.toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ customType: "run-failed-before-reply" }),
                ]),
              );
            }
            expect(readRun(capturedRunId!)).toMatchObject({ delivery: { status: "delivered" } });
            if (busyRequester || retryingRequester) {
              expect(readRun(childRunId!)).toMatchObject({ delivery: { status: "delivered" } });
            }
            expect(readCapturedInputs()).toHaveLength(1);
            if (interruptAnnounce) {
              expect(completedReplies).toBe(1);
              expect(rootReceivedRecovery).toBe(true);
            }
          },
          { timeout: 30_000 },
        );
        phase = "delivered receipt survives another restart";
        await instance.stopGateway();
        await client.stopAndWait();
        client = undefined;
        await instance.startGateway();
        client = await connectRestartClient(instance, {}, signal);
        const after = await client.request<{ messages: unknown[] }>("chat.history", {
          sessionKey: rootKey,
        });
        if (!retryingRequester) {
          expect(JSON.stringify(after.messages)).toContain("HUB_RECEIVED_RESTART_COMPLETION");
        }
        expect(readRun(capturedRunId)).toMatchObject({ delivery: { status: "delivered" } });
        expect(instance.logs()).not.toContain("idempotency key conflicts");
        if (kind === "stale-settle-requester") {
          expect(
            readRestartSession(instance.state.agentDir("main"), rootKey)?.resumeAfterRestart,
          ).toBeUndefined();
          expect(instance.logs()).not.toContain("Queued operator authority cannot be recovered");
          expect(rootReceivedRecovery).toBe(false);
        }
        expect(readCapturedInputs()).toHaveLength(1);
        if (interruptAnnounce) {
          expect(completedReplies).toBe(1);
        } else if (kind === "captured") {
          expect(rootReceivedRecovery).toBe(true);
          expect(resumedChildRequests).toBe(0);
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
