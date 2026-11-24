import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
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
  "collects all children after the waiting parent restarts",
  { timeout: 180_000 },
  async ({ signal, onTestFailed }) => {
    const rootKey = "agent:main:dashboard:collector-restart";
    const failed = createDeferred<never>();
    void failed.promise.catch(() => {});
    let sequence = 0;
    let waiting = false;
    let restarted = false;
    const children = new Set<string>();
    let ids: string[] = [];
    const reservation = await reserveTestPortListener({
      offsets: [0],
      signal,
      createListener: () =>
        restartProviderServer(
          failed,
          async (_request, response, body) => {
            const input = Array.isArray(body.input) ? body.input : [];
            const text = JSON.stringify(input);
            const tools = restartToolNames(body);
            const ordinal = ++sequence;
            const reply = (value: string) =>
              body.stream === false
                ? writeRestartJsonText(response, value, String(ordinal))
                : writeOpenAiResponsesText(response, {
                    text: value,
                    messageId: `msg_collector_${ordinal}`,
                    responseId: `resp_collector_${ordinal}`,
                  });
            const call = (name: string, args: object) => {
              const wireName = tools.includes(name) ? name : "dispatch_action";
              expect(tools).toContain(wireName);
              writeRestartToolCall(
                response,
                "collector",
                wireName,
                wireName === name ? args : { id: name, args },
                ordinal,
              );
            };
            if (!tools.length) {
              reply("Synthetic collector restart");
              return;
            }
            if (text.includes("COLLECTOR_PARENT_TASK")) {
              const receipts = input.flatMap((item) =>
                isRecord(item) && item.type === "function_call_output"
                  ? [findSubagentSpawnReceipt(item.output)].filter(
                      (receipt) => receipt !== undefined,
                    )
                  : [],
              );
              ids = receipts.map((receipt) => receipt!.runId);
              if (
                findSubagentRecords(
                  input,
                  (record) =>
                    Array.isArray(record.pending) &&
                    record.pending.length === 0 &&
                    Array.isArray(record.completed) &&
                    record.completed.length === 3,
                ).length > 0
              ) {
                reply("ALL_RESTART_RESULTS_COLLECTED");
                return;
              }
              if (ids.length < 3) {
                call("sessions_spawn", {
                  task: `COLLECTOR_CHILD_${ids.length}`,
                  context: "isolated",
                  collect: true,
                });
                return;
              }
              waiting = true;
              call("agents_wait", { ids, awaitResults: true });
              return;
            }
            const child = text.match(/COLLECTOR_CHILD_[0-2]/)?.[0];
            assert(child, "Unexpected provider input");
            children.add(child);
            assert(!restarted, "Interrupted child execution must not restart");
            if (child === "COLLECTOR_CHILD_0") {
              reply("CAPTURED_COLLECTOR_RESULT");
            }
          },
          { ignoreAborted: true },
        ),
    });
    const base = restartResumeConfig(
      buildMockOpenAiResponsesProvider(`http://127.0.0.1:${reservation.claim.port}/v1`),
    );
    const instance = await createOpenClawTestInstance({
      name: "collector-restart",
      signal,
      config: {
        ...base,
        tools: { ...base.tools, swarm: true, allow: ["sessions_spawn", "agents_wait"] },
      },
      env: { ...restartEnv, OPENCLAW_NO_RESPAWN: "1" },
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
        return JSON.parse(row.payload_json);
      } finally {
        db.close();
      }
    };
    let client: GatewayClient | undefined;
    onTestFailed(() => {
      process.stderr.write(instance.logs());
    });
    await runQaGatewayFixture(
      async () => {
        await instance.startGateway();
        client = await connectRestartClient(instance, {}, signal);
        await client.request("sessions.create", { key: rootKey, agentId: "main" });
        await client.request("chat.send", {
          sessionKey: rootKey,
          message: "COLLECTOR_PARENT_TASK",
          idempotencyKey: randomUUID(),
          deliver: false,
        });
        await vi.waitFor(
          async () => {
            await Promise.race([failed.promise, Promise.resolve()]);
            expect(waiting).toBe(true);
            expect(children.size).toBe(3);
            expect(readRun(ids[0]!)).toMatchObject({ collectorCompletion: { status: "done" } });
          },
          { timeout: 30_000 },
        );
        await instance.stopGateway();
        await client.stopAndWait();
        client = undefined;
        restarted = true;
        await instance.startGateway();
        client = await connectRestartClient(instance, {}, signal);
        await vi.waitFor(
          async () => {
            const history = await client!.request<{ messages: unknown[] }>("chat.history", {
              sessionKey: rootKey,
            });
            expect(JSON.stringify(history.messages)).toContain("ALL_RESTART_RESULTS_COLLECTED");
            expect(readRun(ids[0]!)).toMatchObject({
              collectorCompletion: { status: "done" },
              completion: { resultText: "CAPTURED_COLLECTOR_RESULT" },
            });
            for (const id of ids.slice(1)) {
              expect(readRun(id)).toMatchObject({
                collectorCompletion: { status: expect.stringMatching(/failed|killed/) },
              });
            }
          },
          { timeout: 12_000 },
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
