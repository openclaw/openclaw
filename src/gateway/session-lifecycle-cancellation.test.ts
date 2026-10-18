import { assert, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { createAgentRunRestartAbortError } from "../agents/run-termination.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import * as sessionAccessor from "../config/sessions/session-accessor.sqlite-entry.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import {
  getAgentRunContext,
  registerAgentRunContext,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { abortChatRunById } from "./chat-abort.js";
import { captureRpcTargetForTest } from "./server-methods/rpc-source-fixtures.test-support.js";
import { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import {
  createSubscriptionTestFixture,
  registerSubscriptionChatRun,
} from "./server-runtime-subscriptions.test-support.js";
import { claimRpcSourceForTest } from "./test-helpers.rpc-source.js";

it.each([
  { cancellation: "restart", status: "interrupted", replacement: false },
  { cancellation: "user", status: "killed", replacement: false },
  { cancellation: "restart", status: "interrupted", replacement: true },
] as const)(
  "settles $cancellation cancellation only for its session generation (replacement: $replacement)",
  async ({ cancellation, status, replacement }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const target = {
        agentId: "main",
        sessionKey: "agent:main:cancelled",
        sessionId: "cancelled-session",
      };
      const runId = `cancelled-${cancellation}`;
      const fixture = createSubscriptionTestFixture();
      const params = fixture.createParams();
      const admission = prepareSystemAgentRunAdmission({}, runId, "main", "cancellation-test", () =>
        registration.controller.signal.throwIfAborted(),
      );
      const registration = registerSubscriptionChatRun(params, {
        ...target,
        target: captureRpcTargetForTest(target),
        runId,
        kind: "agent",
        operationalRunInstance: admission.operationalRunInstance,
      });
      await admission.admit("embedded");
      registerAgentRunContext(runId, target);
      const authority = getAgentRunContext(runId)?.delegatedAuthority;
      assert(authority);
      registration.bindAgentRunDelegatedAuthority(authority);
      const releaseClaim = await claimRpcSourceForTest(registration.entry);
      registration.markExecutionStarted();
      await replaceSessionEntry(target, {
        sessionId: target.sessionId,
        lifecycleRevision: "original",
        updatedAt: 1_000,
        startedAt: 1_000,
        lifecycleRunId: runId,
        activeWriterRunId: runId,
      });
      const writePrepared = createDeferred();
      const releaseWrite = createDeferred();
      const patch = sessionAccessor.applySessionEntryTargetOperation;
      const spy = vi
        .spyOn(sessionAccessor, "applySessionEntryTargetOperation")
        .mockImplementation(async (...args) => {
          if (args[0].target.canonicalKey === target.sessionKey) {
            writePrepared.resolve();
            await releaseWrite.promise;
          }
          return patch(...args);
        });
      const subscriptions = startGatewayEventSubscriptions(params);
      let persistence: Promise<void> | undefined;
      try {
        if (cancellation === "restart") {
          registration.controller.abort(createAgentRunRestartAbortError());
          emitAgentEvent({
            ...target,
            runId,
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
            stream: "lifecycle",
            data: {
              phase: "error",
              aborted: true,
              stopReason: "restart",
              startedAt: 1_000,
              endedAt: 2_000,
            },
          });
        } else {
          expect(
            abortChatRunById(
              {
                ...params,
                removeChatRun: () => undefined,
              },
              { runId, sessionKey: target.sessionKey, stopReason: "rpc" },
            ),
          ).toEqual({ aborted: true });
        }
        await writePrepared.promise;
        persistence = registration.entry.adapter.projectSessionTerminalPersistence;
        expect(persistence).toBeDefined();
        // Actual runtime cleanup closes tools immediately while the queued write is still pending.
        registration.cleanup();
        admission.close();
        expect(validateAgentRunDelegatedAuthority(authority)).toBe(false);
        if (replacement) {
          const current = loadSessionEntry(target);
          assert(current);
          await replaceSessionEntry(target, {
            ...current,
            sessionId: target.sessionId,
            lifecycleRevision: "successor",
          });
        }
        releaseWrite.resolve();
        await persistence;
        if (replacement) {
          expect(loadSessionEntry(target)).toMatchObject({ lifecycleRevision: "successor" });
          expect(loadSessionEntry(target)?.status).toBeUndefined();
          expect(loadSessionEntry(target)?.lastRunId).toBeUndefined();
        } else {
          expect(loadSessionEntry(target)).toMatchObject({
            status,
            lastRunId: runId,
            abortedLastRun: true,
          });
        }
        // The cancellation is not a provider failure and must not add a failure notice.
        expect(await loadTranscriptEvents(target)).not.toContainEqual(
          expect.objectContaining({ customType: "run-failed-before-reply" }),
        );
        expect(fixture.warn).not.toHaveBeenCalled();
      } finally {
        releaseWrite.resolve();
        await persistence?.catch(() => {});
        releaseClaim();
        registration.cleanup();
        admission.close();
        await subscriptions.agentUnsub();
        subscriptions.heartbeatUnsub();
        subscriptions.transcriptUnsub();
        subscriptions.lifecycleUnsub();
        await params.scheduler.stop();
        spy.mockRestore();
      }
    });
  },
);
