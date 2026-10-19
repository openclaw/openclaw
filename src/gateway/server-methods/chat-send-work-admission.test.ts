import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createQueueSettings,
  createQueueTestRun,
} from "../../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  retainGatewayRootWorkAdmissionContinuation,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import {
  issueProviderReviewAcknowledgment,
  recordSessionProviderReview,
  retireProviderReviewAcknowledgment,
} from "../../sessions/provider-review.js";
import { createReplyOperation, type ReplyOperation } from "../../sessions/session-controller.js";
import {
  retireSessionControllerInput,
  type SessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { getRpcSource } from "../../sessions/session-controller.rpc-sources.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseInspectionRefusal,
} from "../../state/agent-database-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  captureGatewayDeviceRevocation,
  retainGatewayDeviceRevocation,
} from "../device-revocation.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import * as restartRecovery from "./chat-restart-recovery.js";
import { respondChatSendAdmissionError } from "./chat-send-admission-errors.js";
import { admitChatSend } from "./chat-send-admission.js";
import { prepareChatAdmission } from "./chat-send-admission.test-support.js";
import {
  assertChatSendExclusiveAdmission,
  createChatSendWorkAdmission,
} from "./chat-send-work-admission.js";
import { registerRpcSourceForTest } from "./rpc-source-fixtures.test-support.js";

it.each([
  new AgentDatabaseAdmissionError(
    createAgentDatabaseInspectionRefusal({
      agentId: "main",
      paths: ["/isolated/main.sqlite"],
      reason: "Inspection pending.",
      pending: true,
    }),
  ),
  new AgentDatabaseAdmissionError(
    createAgentDatabaseInspectionRefusal({
      agentId: "main",
      paths: ["/isolated/main.sqlite"],
      reason: "Inspection refused.",
      pending: false,
    }),
  ),
  new SessionMutationAuthorizationChangedError({ code: "FORBIDDEN", message: "Access changed." }),
  new Error("Unclassified admission failure"),
  Object.assign(new Error("Validation failed"), { retryable: false }),
  Object.assign(new Error("Not a canonical worker outcome"), { code: "outcome-unknown" }),
])("keeps non-storage admission failures RPC-only: %s", (error) => {
  const respond = vi.fn();
  const terminal = vi.fn();
  respondChatSendAdmissionError(error, respond, terminal);
  expect(respond).toHaveBeenCalledExactlyOnceWith(
    false,
    undefined,
    expect.objectContaining({
      code: error instanceof AgentDatabaseAdmissionError ? "UNAVAILABLE" : "INVALID_REQUEST",
    }),
  );
  expect(terminal).not.toHaveBeenCalled();
});

it.each([
  Object.assign(new Error("database or disk is full"), { errcode: 13 }),
  Object.assign(new Error("No space left on device"), { code: "ENOSPC" }),
  Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" }),
  new SqliteWorkerError("Persistence outcome is unknown", "outcome-unknown"),
  new AggregateError([new SqliteWorkerError("Persistence outcome is unknown", "outcome-unknown")]),
])("publishes classified storage admission failures: %s", (error) => {
  const respond = vi.fn();
  const terminal = vi.fn();
  respondChatSendAdmissionError(error, respond, terminal);
  expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, expect.anything());
  expect(terminal).toHaveBeenCalledOnce();
});

describe("retained chat work admission", () => {
  afterEach(resetGatewayWorkAdmission);
  it.each(["retained", "replaced", "released"] as const)(
    "keeps terminal settlement custody after cancellation cleanup with a %s admission",
    async (change) => {
      const release = vi.fn();
      const resume = createDeferred();
      const key = "agent:main:terminal";
      const storePath = "/isolated/terminal.sqlite";
      const identity = {
        runId: "terminal-run",
        sessionId: "terminal-session",
        sessionKey: key,
        agentId: "main",
        storeScope: storePath,
      };
      const registration = registerRpcSourceForTest(identity);
      const sourceRef = expectDefined(registration.entry, "terminal source registration");
      let active = true;
      let guard: (() => void) | undefined;
      const terminal = vi
        .spyOn(restartRecovery, "terminalizeRestartSafeChatAdmission")
        .mockImplementation(async (params) => {
          guard = params.assertCurrent;
          await resume.promise;
          params.assertCurrent();
          return true;
        });
      const work = createChatSendWorkAdmission({
        admission: { release },
        logGateway: { warn: vi.fn() },
        terminal: {
          target: {
            keyFormat: "agent-qualified",
            agentId: "main",
            canonicalKey: key,
            requestedKey: key,
            storeKey: key,
            storeKeys: [key],
            storePath,
            readSource: { agentId: "main", path: storePath, databaseIdentity: "original-source" },
          },
          storePath,
          sourceRef,
          admittedSessionId: identity.sessionId,
          runId: identity.runId,
          lifecycleRevision: "original-lifecycle",
          isActive: () => active,
          currentRegistration: () => getRpcSource(identity.runId),
        },
      });
      const settling = work.settleTerminal({ startedAt: 1, status: "killed", retryable: false });
      const observed = settling.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        expect(guard).toBeTypeOf("function");
        work.release();
        registration.cleanup();
        expect(getRpcSource(identity.runId)).toBeUndefined();
        guard?.();
        expect(release).not.toHaveBeenCalled();
        if (change === "replaced") {
          const replacement = registerRpcSourceForTest(identity);
          expect(replacement.entry).not.toBe(sourceRef);
        } else if (change === "released") {
          active = false;
        }
        resume.resolve();
        expect(await observed).toEqual(
          change === "retained"
            ? { value: true }
            : {
                error: expect.objectContaining({
                  message: "Chat terminal settlement no longer owns its admission",
                }),
              },
        );
        expect(release).toHaveBeenCalledOnce();
        expect(guard).toThrow("Chat settlement admission was released");
      } finally {
        resume.resolve();
        await observed;
        work.release();
        terminal.mockRestore();
      }
    },
  );
  it.each([
    { deferred: false, failCleanup: false },
    { deferred: false, failCleanup: true },
    { deferred: true, failCleanup: false },
    { deferred: true, failCleanup: true },
  ])(
    "keeps caller and root custody through collected work (deferred=$deferred, cleanup failure=$failCleanup)",
    async ({ deferred, failCleanup }) => {
      const caller = captureGatewayDeviceRevocation(
        {},
        { deviceId: "device", role: "operator" },
        () => true,
      );
      const released = createDeferred();
      const cleanup = createDeferred();
      const releaseAdmission = vi.fn(() => released.resolve());
      const warn = vi.fn();
      const root = tryBeginGatewayRootWorkAdmission("chat.send");
      if (!root) {
        throw new Error("Expected root admission");
      }
      const work = await root.run(async () =>
        createChatSendWorkAdmission({
          admission: { release: releaseAdmission },
          releaseCallerAuthority: retainGatewayDeviceRevocation(caller.isCurrent),
          releaseGatewayRootContinuation: retainGatewayRootWorkAdmissionContinuation() ?? undefined,
          logGateway: { warn },
        }),
      );
      root.release();
      const finishPendingInput = vi.fn(() => {
        if (deferred) {
          return cleanup.promise;
        }
        if (failCleanup) {
          throw new Error("pending input write failed");
        }
        return undefined;
      });
      work.setPendingInputCleanup(finishPendingInput);
      const releaseCollectedTurn = work.retain();
      caller.release();
      work.release();
      work.release();

      expect(work.isActive()).toBe(true);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(caller.isCurrent()).toBe(true);
      expect(finishPendingInput).not.toHaveBeenCalled();
      expect(releaseAdmission).not.toHaveBeenCalled();

      releaseCollectedTurn();
      releaseCollectedTurn();
      expect(work.isActive()).toBe(false);
      if (deferred) {
        expect(caller.isCurrent()).toBe(true);
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        expect(releaseAdmission).not.toHaveBeenCalled();
        if (failCleanup) {
          cleanup.reject(new Error("pending input write failed"));
        } else {
          cleanup.resolve();
        }
      }
      await released.promise;
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(caller.isCurrent()).toBe(false);
      expect(finishPendingInput).toHaveBeenCalledOnce();
      expect(releaseAdmission).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledTimes(failCleanup ? 1 : 0);
      expect(() => work.retain()).toThrow("cannot retain a released chat work admission");
    },
  );
});

it.each([
  { kind: "active", review: false },
  { kind: "queued", review: false },
  { kind: "active", review: true },
  { kind: "queued", review: true },
] as const)(
  "refuses exclusive admission without a terminal for $kind work (provider review=$review)",
  ({ kind, review }) =>
    withOpenClawTestState({ label: "exclusive-store-scope" }, async () => {
      const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg, cfg);
      const sessionKey = "agent:main:exclusive-store-scope";
      const sessionId = "same-incarnation";
      replaceSessionEntrySync({ agentId: "main", sessionKey }, { sessionId, updatedAt: 1 });
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      const prepared = await prepareChatAdmission({
        client: null,
        context,
        params: {
          sessionKey,
          message: "Complete the synthetic goal",
          idempotencyKey: "exclusive-store-goal",
          ...(!review && {
            intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() },
          }),
        },
      });
      const { request, session } = prepared;
      const target = {
        agentId: "main",
        sessionKey,
        sessionId,
        storePath: session.storePath,
        lifecycleRevision: session.entry?.lifecycleRevision,
      };
      const providerReview = review
        ? await recordSessionProviderReview({
            target,
            refusal: {
              runId: "failed-run",
              provider: "openai",
              model: "gpt-5.6-sol",
              runtimeId: "openclaw",
              api: "openai-chatgpt-responses",
              review: {
                explanation: "Review the operation.",
                continuation: { message: "Continue" },
              },
            },
            assertCurrent: () => {},
          })
        : undefined;
      const acknowledgment = providerReview
        ? await issueProviderReviewAcknowledgment({
            target,
            reviewId: providerReview.id,
            nextRunId: session.clientRunId,
            assertCurrent: () => {},
          })
        : undefined;
      request.providerReviewAcknowledgment = acknowledgment;
      const operations: ReplyOperation[] = [];
      const inputs: SessionControllerInput[] = [];
      const occupy = (storePath: string) => {
        if (kind === "active") {
          const operation = createReplyOperation({
            sessionKey,
            sessionId,
            resetTriggered: false,
            target: captureSessionTarget({ storeScope: storePath, sessionKey, agentId: "main" }),
          });
          operations.push(operation);
          return;
        }
        const source = createQueueTestRun({ prompt: "Waiting input" });
        source.run = {
          ...source.run,
          agentId: "main",
          sessionKey,
          sessionId,
          config: { ...cfg, session: { store: storePath } },
        };
        expect(
          enqueueFollowupRun(sessionKey, source, createQueueSettings(), "none", undefined, false),
        ).toBe(true);
        inputs.push(expectDefined(source.controllerInput, "queued source"));
      };
      try {
        occupy(`${session.storePath}.foreign`);
        expect(() => assertChatSendExclusiveAdmission(request, session)).not.toThrow();
        occupy(session.storePath);
        const respond = vi.fn();
        await expect(admitChatSend({ ...prepared, respond })).resolves.toEqual({ ok: false });
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: review ? "INVALID_REQUEST" : "UNAVAILABLE",
            message: expect.stringContaining(review ? "active work" : "active or queued work"),
          }),
        );
        expect(context.broadcast).not.toHaveBeenCalled();
      } finally {
        if (acknowledgment) {
          retireProviderReviewAcknowledgment(acknowledgment);
        }
        for (const input of inputs) {
          retireSessionControllerInput(input);
        }
        for (const operation of operations) {
          operation.complete();
        }
        await Promise.all([
          ...inputs.map((input) => input.settlement.promise),
          ...operations.map((operation) => operation.ownerSettlement),
        ]);
        session.releaseSessionStorage?.();
      }
    }),
);
