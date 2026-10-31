import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createChatFixture, sendChatAndWait } from "./gateway-chat-fixture.test-support.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import { kernelGatewayTestStateOptions } from "./test-helpers.env.js";

// Real agent/tool admission, same-session idle handoff and durable cron outcome.
it.for([false, true])(
  "runs an authorized force request after its tool turn ends (caller scoped: %s)",
  { timeout: 120_000 },
  async (callerScoped, { signal }) => {
    await withOpenClawTestState(kernelGatewayTestStateOptions("cron-after-turn"), async () => {
      let sessionKey = "";
      let jobId = "";
      let calls = 0;
      let disposition = "settled";
      let finished = createDeferredCore<Record<string, unknown>>();
      let notice = createDeferredCore();
      const fixture = createChatFixture("cron-after-turn", {
        configure: (config) => ({
          ...config,
          agents: { ...config.agents, ownership: "explicit", entries: { main: {} } },
          plugins: { slots: { memory: "none" } },
          tools: {
            profile: "coding",
            codeMode: false,
            toolSearch: false,
            gatewayPolicy: callerScoped
              ? {
                  allow: ["automations"],
                  actions: { automations: ["add", "run"] },
                  automations: { scope: "caller" },
                }
              : undefined,
          },
          cron: { enabled: false, triggers: { enabled: false } },
        }),
        onEvent: ({ event, payload }) => {
          const value = asOptionalRecord(payload);
          if (event === "cron" && value?.action === "finished" && value.jobId === jobId) {
            finished.resolve(value);
          }
          if (event === "session.message" && JSON.stringify(value).includes("did not start:")) {
            notice.resolve();
          }
        },
        respond: async (body, _sessionId, response) => {
          if (body.includes("conversationLabelSource")) {
            return "Automation proof";
          }
          calls++;
          if (calls === 1) {
            writeToolCall(response, AUTOMATIONS_TOOL_NAME, {
              action: "add",
              job: {
                name: "After-turn proof",
                schedule: { kind: "every", everyMs: 86_400_000 },
                sessionTarget: `session:${sessionKey}`,
                wakeMode: "now",
                payload: {
                  kind: "agentTurn",
                  message: "Return AFTER_TURN_STARTED",
                  toolsAllow: [],
                },
                delivery: { mode: "none" },
              },
            });
          } else if (calls === 2) {
            const match = body.match(/\\?"id\\?"\s*:\s*\\?"([a-f0-9-]{36})/);
            expect(match, body).not.toBeNull();
            jobId = match![1]!;
            writeToolCall(response, AUTOMATIONS_TOOL_NAME, {
              action: "run",
              jobId,
              runMode: "force",
              timeoutMs: 1000,
            });
          } else if (calls === 3) {
            expect(body).toContain("enqueued");
            expect(body).toContain("starts after this turn");
            if (disposition === "disabled") {
              await fixture.client.request("cron.update", { id: jobId, patch: { enabled: false } });
            }
            if (disposition === "cancelled") {
              await expect(
                fixture.client.request("chat.abort", { sessionKey }),
              ).resolves.toMatchObject({ aborted: true });
            }
            return "Queued for after this turn.";
          } else {
            expect(body).toContain("Return AFTER_TURN_STARTED");
            return "AFTER_TURN_STARTED";
          }
          return undefined;
        },
      });
      await runQaGatewayFixture(
        async () => {
          await fixture.start();
          for (disposition of callerScoped
            ? ["settled", "disabled"]
            : ["settled", "disabled", "cancelled"]) {
            const skipped = disposition !== "settled";
            calls = 0;
            finished = createDeferredCore<Record<string, unknown>>();
            notice = createDeferredCore();
            sessionKey = (
              await fixture.client.request<{ key: string }>("sessions.create", { agentId: "main" })
            ).key;
            await fixture.client.request("sessions.messages.subscribe", { key: sessionKey });
            await sendChatAndWait(
              fixture.client,
              sessionKey,
              "Create a daily job, then run it now.",
              30_000,
              disposition === "cancelled"
                ? { status: "error", stopReason: "rpc" }
                : { status: "ok" },
            );
            const outcome = await withinTest(finished.promise, signal);
            const history = await fixture.client.request("cron.runs", { id: jobId, limit: 1 });
            const status = skipped ? "skipped" : "ok";
            expect(outcome, JSON.stringify({ outcome, history, calls })).toMatchObject({ status });
            expect(history).toMatchObject({ entries: [{ status }] });
            expect(calls).toBe(skipped ? 3 : 4);
            if (skipped) {
              expect(outcome.error).toContain(disposition === "disabled" ? "disabled" : "grant");
            }
            if (disposition === "disabled") {
              await withinTest(notice.promise, signal);
            }
            const transcript = await fixture.client.request<{ messages: unknown[] }>(
              "chat.history",
              { sessionKey },
            );
            expect(
              transcript.messages.filter((message) =>
                JSON.stringify(message).includes("did not start:"),
              ),
            ).toHaveLength(disposition === "disabled" ? 1 : 0);
            if (!skipped) {
              expect(JSON.stringify(transcript)).toContain('"text":"AFTER_TURN_STARTED"');
            }
          }
          expect(fixture.errors).toEqual([]);
        },
        () => fixture.close(),
      );
    });
  },
);
