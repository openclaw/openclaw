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
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  retainGatewayRootWorkAdmissionContinuation,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createReplyOperation, type ReplyOperation } from "../../sessions/session-controller.js";
import {
  retireSessionControllerInput,
  type SessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { getRpcSource } from "../../sessions/session-controller.rpc-sources.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  captureGatewayDeviceRevocation,
  retainGatewayDeviceRevocation,
} from "../device-revocation.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import * as restartRecovery from "./chat-restart-recovery.js";
import { prepareChatAdmission } from "./chat-send-admission.test-support.js";
import {
  assertChatSendExclusiveAdmission,
  createChatSendWorkAdmission,
} from "./chat-send-work-admission.js";
import { registerRpcSourceForTest } from "./rpc-source-fixtures.test-support.js";

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

it.each(["active", "queued"] as const)(
  "keeps Goal admission scoped to its physical store with %s work",
  (kind) =>
    withOpenClawTestState({ label: "exclusive-store-scope" }, async () => {
      const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg, cfg);
      const sessionKey = "agent:main:exclusive-store-scope";
      const sessionId = "same-incarnation";
      replaceSessionEntrySync({ agentId: "main", sessionKey }, { sessionId, updatedAt: 1 });
      const { request, session } = await prepareChatAdmission({
        client: null,
        context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
        params: {
          sessionKey,
          message: "Complete the synthetic goal",
          idempotencyKey: "exclusive-store-goal",
          intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() },
        },
      });
      expect(request.goalOperation?.action).toBe("start");
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
        expect(() => assertChatSendExclusiveAdmission(request, session)).toThrow(
          "goal-session-busy",
        );
      } finally {
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
