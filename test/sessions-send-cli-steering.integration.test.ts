import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { CLAUDE_PROTOCOL_FIXTURE } from "../extensions/anthropic/cli-runtime.protocol.test-support.js";
import {
  collectClaudeCli,
  createCliTestHarness,
  resultDetail,
} from "../extensions/anthropic/cli-runtime.test-support.js";
import { createSteeredCliMessageInjection } from "../src/agents/cli-runner/execute-plugin.steered-transcript.js";
import {
  createSessionsSendTestCaller,
  setSessionsSendTestActiveRun,
} from "../src/agents/openclaw-tools.sessions-steering.test-support.js";
import { withGatewayToolCallerIdentity } from "../src/agents/tools/gateway-caller-context.js";
import { createSessionsSendTool } from "../src/agents/tools/sessions-send-tool.js";
import { setRuntimeConfigSnapshot } from "../src/config/runtime-snapshot.js";
import {
  readSessionSubmittedInput,
  upsertSessionEntryCore,
} from "../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  expectHistorySuccess,
  requestHistory,
} from "../src/gateway/server-methods/chat-history-fixtures.test-support.js";
import { createHistoryReadContext } from "../src/gateway/server-methods/chat-history.test-helpers.js";
import type { CliBackendMessageInjection } from "../src/plugins/cli-backend.types.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "./helpers/fixture-receipts.js";
import { withinTest } from "./helpers/promise.js";

it.for(["consumed", "withdrawn", "disconnected"] as const)(
  "returns a zero-wait CLI receipt and reconciles %s input without resending",
  { timeout: 55_000 },
  async (outcome, { signal }) => {
    await withOpenClawTestState(
      { scenario: "minimal", prepareProfileCatalog: true },
      async (state) => {
        const callerKey = "agent:main:main";
        const sessionKey = "agent:main:subagent:busy-child";
        const testConfig: OpenClawConfig = {
          tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
        };
        setRuntimeConfigSnapshot(testConfig);
        const scope = {
          agentId: "main",
          sessionId: "busy-child",
          sessionKey,
          storePath: path.join(state.sessionsDir(), "sessions.json"),
        };
        await upsertSessionEntryCore(
          { ...scope, sessionKey: callerKey },
          { sessionId: "parent", updatedAt: 1 },
        );
        await upsertSessionEntryCore(scope, {
          sessionId: scope.sessionId,
          updatedAt: 1,
          spawnedBy: callerKey,
        });
        const gateway = await createHistoryReadContext({ getRuntimeConfig: () => testConfig });
        const harness = createCliTestHarness();
        const receipts = await openFixtureReceiptChannel();
        let injection: CliBackendMessageInjection | undefined;
        const context = await harness.context(
          fixtureReceiptClientSource(receipts.endpoint) + "\n" + CLAUDE_PROTOCOL_FIXTURE,
          {
            abortSignal: signal,
            timeoutMs: 50_000,
            liveSession: harness.liveSession(),
            registerMessageInjection: (value) => {
              injection = value;
            },
          },
          { CLAUDE_FIXTURE_SCENARIO: "steer-delayed", CLAUDE_FIXTURE_STEER_OUTCOME: outcome },
        );
        const native = collectClaudeCli(context);
        void native.catch(() => {});
        let closeActive: (() => Promise<void>) | undefined;
        try {
          await withinTest(receipts.waitFor(path.join(context.cwd, "turn.ready"), "ready"), signal);
          const messageInjectionV2 = createSteeredCliMessageInjection({
            getInjection: () => injection,
            signal,
            context: {
              params: { workspaceDir: state.workspaceDir, config: testConfig },
              backendResolved: { id: "claude-cli" },
            },
          });
          closeActive = await setSessionsSendTestActiveRun(
            scope.sessionId,
            {
              runId: "busy-child-run",
              messageInjectionV2,
              queueMessage: async () => {
                throw new Error("Unexpected unguarded send");
              },
              isStreaming: () => true,
              isCompacting: () => false,
              abort() {},
            },
            sessionKey,
            callerKey,
            testConfig,
            scope.storePath,
          );
          const callGateway = vi.fn().mockImplementation(async ({ method }) => {
            if (method === "agent") {
              throw new Error("Unexpected fallback to a new turn");
            }
            return {};
          });
          const send = createSessionsSendTool({
            agentSessionKey: callerKey,
            agentChannel: "telegram",
            callGateway,
            config: testConfig,
          });
          const { details } = await withGatewayToolCallerIdentity(
            createSessionsSendTestCaller(callerKey),
            () =>
              send.execute("send-guide", {
                sessionKey,
                message: "Synthetic guidance",
                timeoutSeconds: 0,
              }),
          );
          const received = asOptionalRecord(details);
          if (typeof received?.runId !== "string" || typeof received.messageId !== "string") {
            throw new Error(
              `Missing steering receipt: ${String(received?.error ?? received?.status)}`,
            );
          }
          expect(received).toMatchObject({
            status: "submitted",
            consumption: "unconfirmed",
            sessionKey,
            messageId: expect.any(String),
          });
          await withinTest(
            receipts.waitFor(path.join(context.cwd, "input.queued"), "ready"),
            signal,
          );
          const { runId, messageId } = received;
          const readMessage = async () =>
            expectHistorySuccess(
              await requestHistory("chat.message.get", { sessionKey, messageId }, gateway),
            );
          const readReceipt = async () =>
            expectHistorySuccess(
              await requestHistory(
                "chat.history",
                { sessionKey, inputRunIds: [runId], limit: 1 },
                gateway,
              ),
            ).inputReceipts;
          expect(await readReceipt()).toEqual([{ runId, state: "pending" }]);
          expect(await readMessage()).toEqual({ ok: false, unavailableReason: "not_found" });
          if (outcome === "consumed" && process.env.OPENCLAW_TEST_CLI_DELAYED_STEER === "1") {
            await delay(31_000, undefined, { signal });
          }
          await writeFile(path.join(context.cwd, "input.release"), "go");
          if (outcome === "disconnected") {
            await expect(native).rejects.toThrow();
          } else {
            expect(resultDetail(await native).turn).toBe(2);
          }
          if (outcome === "consumed") {
            await expect.poll(readMessage).toMatchObject({
              ok: true,
              message: {
                role: "assistant",
                content: "Synthetic guidance",
                provenance: {
                  kind: "inter_session",
                  sourceTool: "sessions_send",
                  sourceSessionKey: callerKey,
                },
                __openclaw: { id: messageId },
              },
            });
          } else {
            await expect
              .poll(
                async () =>
                  (await readSessionSubmittedInput(scope, `${runId}:user`, { includeSource: true }))
                    ?.state,
              )
              .toBe(outcome === "withdrawn" ? "cancelled" : "interrupted");
            expect(await readReceipt()).toEqual([
              { runId, state: "pending", ...(outcome === "withdrawn" ? { cancelled: true } : {}) },
            ]);
            expect(await readMessage()).toEqual({ ok: false, unavailableReason: "not_found" });
          }
          expect(callGateway.mock.calls.some(([request]) => request.method === "agent")).toBe(
            false,
          );
        } finally {
          await writeFile(path.join(context.cwd, "input.release"), "go");
          await harness.cleanup();
          await native.catch(() => {});
          await receipts.close();
          await closeActive?.();
        }
      },
    );
  },
);
