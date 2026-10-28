import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { observeRecoveryRoots } from "../agents/main-session-recovery/main-session-recovery-runtime.test-support.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { recoverTerminalSessionEntryForVisibleTurn } from "../config/sessions/terminal-status.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createChatFixture } from "./gateway-chat-fixture.test-support.js";
import { createRestartSafeChatRequest } from "./server-methods/chat-restart-recovery.js";

it("preserves interrupted recovery custody when reusing a failed session", () => {
  const entry = {
    sessionId: "interrupted-session",
    updatedAt: 1,
    status: "failed" as const,
    abortedLastRun: true,
    mainRestartRecovery: { cycleId: "unfinished-cycle", revision: 7, chargedAttempts: 1 },
    restartRecoveryRuns: [{ runId: "interrupted-run", lifecycleGeneration: "previous-gateway" }],
    restartRecoveryDeliveryRunId: "interrupted-run",
    restartRecoveryDeliverySourceRunId: "accepted-input",
  };

  expect(recoverTerminalSessionEntryForVisibleTurn(entry)).toEqual(entry);
});

it("chat.send recovers failed and statusless work for new messages and retained retries exactly once", async ({
  signal,
}) => {
  const priorMessage = "Finish the interrupted recovery task.";
  const nextMessage = "Then verify the new request.";
  let cfg: OpenClawConfig = {};
  const fixture = createChatFixture("orphaned-recovery", {
    configure(config) {
      cfg = {
        ...config,
        agents: {
          ...config.agents,
          defaults: { ...config.agents?.defaults, maxConcurrent: 1 },
          entries: { main: {} },
        },
        messages: { queue: { mode: "followup", debounceMsByChannel: { webchat: 0 } } },
        plugins: { slots: { memory: "none" } },
      };
      return cfg;
    },
    respond: async () => "RECOVERY_OK",
  });
  await runQaGatewayFixture(
    async () => {
      const startup = observeRecoveryRoots("main-session:startup-recovery", 1);
      try {
        await fixture.start();
        // Seed request-owned orphans only after the startup recovery attempt settles.
        await withinTest(startup.completed, signal);
      } finally {
        startup.restore();
      }
      const client = fixture.client;
      const workspace = cfg.agents?.defaults?.workspace;
      assert(workspace, "Expected fixture workspace");
      for (const { status, retry } of [
        { status: "failed", retry: false },
        { status: undefined, retry: false },
        { status: "failed", retry: true },
        { status: undefined, retry: true },
      ] as const) {
        const caseId = `${status ?? "statusless"}-${retry ? "retry" : "new"}`;
        const sessionKey = `agent:main:dashboard:orphaned-chat-${caseId}`;
        const sessionId = `orphaned-chat-session-${caseId}`;
        const sourceRunId = `rejected-input-${caseId}`;
        fixture.requests.length = 0;
        const target = { agentId: "main", sessionKey };
        const send = (
          idempotencyKey: string,
          message: string,
          overrides: Record<string, unknown> = {},
        ) =>
          client.request("chat.send", {
            sessionKey,
            sessionId,
            message,
            idempotencyKey,
            deliver: false,
            ...overrides,
          });
        await replaceSessionEntry(target, {
          sessionId,
          displayName: "Interrupted chat",
          updatedAt: Date.now(),
          status,
          ...(status === undefined ? {} : { abortedLastRun: false }),
          activeWriterRunId: "dead-writer",
          lastRunId: sourceRunId,
          mainRestartRecovery: { cycleId: "unfinished-cycle", revision: 7, chargedAttempts: 1 },
          restartRecoveryRuns: [
            { runId: "interrupted-run", lifecycleGeneration: "previous-gateway" },
            { runId: "interrupted-announcement", lifecycleGeneration: "older-gateway" },
          ],
          restartRecoveryDeliveryRunId: sourceRunId,
          restartRecoveryDeliverySourceRunId: sourceRunId,
          restartRecoveryDeliveryRequestFingerprint: (
            await createRestartSafeChatRequest({
              cfg,
              eligible: true,
              message: priorMessage,
              senderIsOwner: true,
            })
          )?.fingerprint,
          restartRecoverySourceIngress: "control-ui",
        });
        await appendTranscriptMessage(
          { ...target, sessionId },
          {
            cwd: workspace,
            message: { role: "user", content: priorMessage, idempotencyKey: `${sourceRunId}:user` },
          },
        );
        const stranded = loadSessionEntry(target);
        if (retry) {
          await expect(send(sourceRunId, nextMessage)).rejects.toThrow(/different input/);
          expect(loadSessionEntry(target)).toEqual(stranded);
        }
        for (const [reason, stale] of [
          ["session", { sessionId: "replaced-session" }],
          ["permissions", { expectedPermissionMode: "guarded" }],
          ["tools", { expectedToolOverrides: { webSearch: false } }],
        ] as const) {
          await expect(send(`stale-${caseId}-${reason}`, nextMessage, stale)).rejects.toThrow(
            /changed/,
          );
          expect(loadSessionEntry(target)).toEqual(stranded);
        }
        const runId = retry ? sourceRunId : `new-input-after-stranded-recovery-${caseId}`;
        await expect(send(runId, retry ? priorMessage : nextMessage)).resolves.toMatchObject({
          runId,
          status: retry ? "ok" : "started",
        });
        await vi.waitFor(
          async () => {
            if (!retry) {
              const outcome = await client.request("agent.wait", { runId, timeoutMs: 30_000 });
              expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "ok" });
            }
            expect(loadSessionEntry(target)?.status).toBe("done");
          },
          { timeout: 30_000 },
        );
        const targetRequests = fixture.requests.filter((body) => body.includes(priorMessage));
        expect(targetRequests).toHaveLength(retry ? 1 : 2);
        expect(targetRequests[0]).not.toContain(nextMessage);
        if (!retry) {
          expect(targetRequests[1]).toContain(nextMessage);
        }
        const recovered = loadSessionEntry(target);
        expect(recovered?.sessionId).toBe(sessionId);
        expect(recovered?.archivedAt).toBeUndefined();
        expect(recovered?.mainRestartRecovery).toBeUndefined();
        expect(recovered?.restartRecoveryRuns).toBeUndefined();
        // Captured model-prompt metadata can repeat text without creating another user turn.
        const transcript = JSON.stringify(
          (await loadTranscriptEvents({ ...target, sessionId })).flatMap((event) =>
            isRecord(event) && event.type === "message" && isRecord(event.message)
              ? [event.message.content]
              : [],
          ),
        );
        expect(transcript.split(priorMessage)).toHaveLength(2);
        expect(transcript.split(nextMessage)).toHaveLength(retry ? 1 : 2);
      }
    },
    () => fixture.close(),
  );
}, 90_000);
