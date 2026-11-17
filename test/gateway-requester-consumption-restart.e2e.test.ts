// Real Gateway crash/restart; local model transport, lifecycle-produced receipts, no seeded rows.
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

it.skipIf(process.platform === "win32")(
  "settles a consumed cohort after a Gateway crash without redispatching it",
  { timeout: 180_000 },
  async ({ signal, onTestFailed, onTestFinished }) => {
    const rootKey = "agent:main:dashboard:restart-hub";
    let childKey: string | undefined;
    let siblingKey: string | undefined;
    let childRunId: string | undefined;
    let capturedRunId: string | undefined;
    let initialized: { runId: string; childSessionKey: string }[] = [];
    let finishChild: (() => void) | undefined;
    let finishCaptured: (() => void) | undefined;
    let completionRequests = 0;
    let sequence = 0;
    let phase = "startup";
    let diagnostics: unknown;
    const failed = createDeferred<never>();
    void failed.promise.catch(() => {});
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
                  messageId: "msg_custody_" + ordinal,
                  responseId: "resp_custody_" + ordinal,
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
          } else if (text.includes("EXPLICIT_FOLLOWUP_AFTER_RESTART")) {
            reply("EXPLICIT_FOLLOWUP_OK");
          } else if (text.includes("CUSTODY_ROOT_TASK")) {
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
            const child = receipts.find((value) => value.sessionKey === childKey);
            const sibling = receipts.find((value) => value.sessionKey === siblingKey);
            if (typeof child?.runId === "string") {
              childRunId ??= child.runId;
            }
            if (typeof sibling?.runId === "string") {
              capturedRunId ??= sibling.runId;
            }
            if (text.includes("CAPTURED_CUSTODY_RESULT")) {
              // Hold the real request after its input receipt has been persisted, then crash.
              completionRequests++;
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
            } else {
              call("sessions_yield", {});
            }
          } else if (text.includes("CUSTODY_SETUP_TASK")) {
            initialized = input.flatMap((item) => {
              const receipt =
                isRecord(item) && item.type === "function_call_output"
                  ? findSubagentSpawnReceipt(item.output)
                  : undefined;
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
          } else if (text.includes("CUSTODY_CHILD_TASK")) {
            finishChild = () => reply("NESTED_CHILD_RECONCILED");
          } else if (text.includes("CUSTODY_SIBLING_TASK")) {
            finishCaptured = () => reply("CAPTURED_CUSTODY_RESULT");
          } else {
            assert(text.includes("INITIALIZE_CUSTODY_SESSION"), "Unexpected synthetic request");
            reply("SESSION_READY");
          }
        }),
    });
    const model = buildMockOpenAiResponsesProvider(
      "http://127.0.0.1:" + reservation.claim.port + "/v1",
    );
    const base = restartResumeConfig(model);
    const noProxy = [process.env.no_proxy ?? process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"]
      .filter(Boolean)
      .join(",");
    const instance = await createOpenClawTestInstance({
      name: "gateway-consumed-cohort-restart",
      signal,
      config: {
        ...base,
        // This fixture owns one agent; unrelated empty stores are not recovery inputs.
        agents: { ...base.agents, entries: { main: {} } },
        tools: { ...base.tools, allow: ["sessions_send", "sessions_spawn", "sessions_yield"] },
      },
      env: {
        ...restartEnv,
        OPENCLAW_NO_RESPAWN: "1",
        // Preserve external proxy routing; only the owned loopback fixture is direct.
        NO_PROXY: noProxy,
        no_proxy: noProxy,
      },
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", instance.stateDir);
    onTestFinished(() => vi.unstubAllEnvs());
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
      })?.events.filter(
        (event) =>
          isRecord(event) &&
          event.type === "message" &&
          isRecord(event.message) &&
          event.message.role === "user" &&
          JSON.stringify(event.message.content).includes("CAPTURED_CUSTODY_RESULT"),
      );
    };
    let client: GatewayClient | undefined;
    onTestFailed(() => {
      // Cleanup has already removed the private databases; retain only pre-cleanup facts.
      process.stderr.write(
        `Consumed cohort restart ${JSON.stringify({ phase, diagnostics, completionRequests })}\n`,
      );
      process.stderr.write(instance.logs());
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
            assert(finishChild);
            assert(finishCaptured);
          },
          { timeout: 30_000 },
        );
        assert(childRunId);
        assert(capturedRunId);
        assert(finishChild);
        assert(finishCaptured);
        expect(
          await client.request("agent.wait", { runId: root.runId, timeoutMs: 15_000 }),
        ).toMatchObject({ status: "ok", yielded: true });
        finishCaptured();
        await vi.waitFor(
          () =>
            expect(readRun(capturedRunId!)).toMatchObject({
              completion: { resultText: "CAPTURED_CUSTODY_RESULT" },
              delivery: { status: "pending" },
            }),
          { timeout: 15_000 },
        );
        finishChild();
        phase = "cohort consumed before crash";
        await vi.waitFor(
          () => {
            expect(completionRequests).toBe(1);
            for (const runId of [childRunId!, capturedRunId!]) {
              expect(readRun(runId)).toMatchObject({
                delivery: {
                  status: "pending",
                  requesterDelivery: { state: "consumed", runId: expect.any(String) },
                },
              });
            }
          },
          { timeout: 15_000 },
        );
        const consumed = [readRun(childRunId), readRun(capturedRunId)].map((entry) =>
          isRecord(entry.delivery) ? entry.delivery.requesterDelivery : undefined,
        );
        await instance.crashGateway();
        await client.stopAndWait();
        client = undefined;
        phase = "consumed cohort settlement after crash";
        await instance.startGateway();
        client = await connectRestartClient(instance, {}, signal);
        await vi.waitFor(
          () => {
            const rows = [readRun(childRunId!), readRun(capturedRunId!)];
            diagnostics = rows.map((row) => ({
              delivery: row.delivery,
              wake: row.requesterSettleWake,
            }));
            for (const [index, row] of rows.entries()) {
              expect(row).toMatchObject({
                delivery: { status: "delivered", requesterDelivery: consumed[index] },
              });
            }
          },
          { timeout: 30_000 },
        );
        // Excludes copied-history recovery: no invented final or second completion input.
        const barrier = await client.request(
          "agent",
          {
            sessionKey: rootKey,
            message: "EXPLICIT_FOLLOWUP_AFTER_RESTART",
            deliver: false,
            idempotencyKey: randomUUID(),
          },
          { expectFinal: true, timeoutMs: 30_000 },
        );
        expect(barrier).toMatchObject({ status: "ok" });
        expect(completionRequests).toBe(1);
        expect(readCapturedInputs()).toHaveLength(1);
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
