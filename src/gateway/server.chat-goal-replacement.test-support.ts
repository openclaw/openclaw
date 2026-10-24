import { randomUUID } from "node:crypto";
import { expect, it, vi, type MockInstance } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { createDeferred } from "../../test/helpers/promise.js";
import * as runs from "../agents/embedded-agent-runner/runs.js";
import type { runEmbeddedAgent as executeEmbeddedAgent } from "../agents/embedded-agent.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as goalReads from "../config/sessions/goals-operations-read.js";
import * as goals from "../config/sessions/goals-operations.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../sessions/session-controller.lifecycle.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { ABORTED_PARTIAL_PERSISTENCE_WARNING } from "./server-methods/chat-aborted-partial.js";
import * as chatHandler from "./server-methods/chat-send-handler.js";
import * as partials from "./server-methods/chat-transcript-persistence.js";
import type { RespondFn, GatewayRequestContext, GatewayClient } from "./server-methods/types.js";
import { gatewayProfile } from "./server/client-fixtures.test-support.js";

export function registerGoalReplacementCases(
  scope: () => { agentId: string; sessionKey: string; sessionId: string; storePath: string },
  runEmbeddedAgent: MockInstance<typeof executeEmbeddedAgent>,
  rpc: (
    method: "chat.send" | "sessions.goal.update" | "users.setRole",
    params: Record<string, unknown>,
    onResponse?: RespondFn,
    client?: GatewayClient,
  ) => Promise<MockInstance<RespondFn>>,
  goalStart: (message: string) => Record<string, unknown>,
  getContext: () => GatewayRequestContext,
  client: GatewayClient,
) {
  it.each([
    "success",
    "pause-retry",
    "edit-retry",
    "resume-retry",
    "concurrent-edit",
    "abort-warning",
    "allowed-principal",
    "denied-session",
    "revoke-settlement",
    "revoke-pause",
    "revoke-edit",
    "revoke-resume",
    "revoke-recovery",
  ] as const)(
    "settles the exact executing turn before pause/edit/resume (%s)",
    async (mode) => {
      const secured =
        mode === "allowed-principal" || mode === "denied-session" || mode.startsWith("revoke-");
      const initialConfig = getContext().getRuntimeConfig();
      const profile = secured
        ? ensureProfileForEmail("replacement-" + mode + "-" + randomUUID() + "@example.test")
        : undefined;
      const requester: GatewayClient = profile
        ? {
            ...client,
            connect: { ...client.connect, scopes: ["operator.read", "operator.write"] },
            authenticatedUserProfile: gatewayProfile(profile.id),
          }
        : client;
      const originalRequester: GatewayClient = secured
        ? {
            ...client,
            authenticatedUserProfile: gatewayProfile(GATEWAY_OWNER_PROFILE_ID),
          }
        : client;
      const policy: OpenClawConfig = {
        ...initialConfig,
        gateway: {
          ...initialConfig.gateway,
          roles: {
            default: "replacement-role",
            definitions: {
              "replacement-role": {
                agents: ["main"],
                sessions: { others: "write" },
                scopes: ["operator.read", "operator.write"],
              },
              "replacement-denied": {
                agents: [],
                sessions: { others: "none" },
                scopes: ["operator.read", "operator.write"],
              },
            },
          },
        },
      };
      const revoke = async () => {
        if (!profile) {
          throw new Error("Revocation requires the synthetic requester profile");
        }
        const revoked = await rpc(
          "users.setRole",
          { profileId: profile.id, role: "replacement-denied" },
          undefined,
          originalRequester,
        );
        expect(revoked.mock.calls[0]?.[0]).toBe(true);
      };
      const updateGoal = (params: Record<string, unknown>) =>
        rpc("sessions.goal.update", params, undefined, requester);
      const started = createDeferred();
      const interrupted = createDeferred();
      const physicalRelease = createDeferred();
      const resumed = createDeferred();
      const resumedRelease = createDeferred();
      const order: string[] = [];
      let originalRun = "";
      let oldSettled = false;
      const mutate = goals.mutateSessionGoal;
      const persistence =
        mode === "abort-warning"
          ? vi
              .spyOn(partials, "persistAbortedPartials")
              .mockResolvedValue(ABORTED_PARTIAL_PERSISTENCE_WARNING)
          : undefined;
      let failStage =
        mode === "edit-retry" || mode === "revoke-recovery"
          ? "edit"
          : mode === "pause-retry"
            ? "pause"
            : undefined;
      let resumeReadObserved = false;
      let attemptedResume: (goals.SessionGoalOperation & { action: "resume" }) | undefined;
      const resume = chatHandler.handleSessionGoalResumeChat;
      const resumeSpy = vi.spyOn(chatHandler, "handleSessionGoalResumeChat");
      if (mode === "revoke-resume") {
        resumeSpy.mockImplementationOnce(async (options, operation) => {
          attemptedResume = operation;
          const lookup = goalReads.lookupSessionGoalOperation;
          const checkpoint = vi
            .spyOn(goalReads, "lookupSessionGoalOperation")
            .mockImplementationOnce(async (params) => {
              expect(params.operation.operationId).toBe(operation.operationId);
              const result = await lookup(params);
              resumeReadObserved = true;
              await revoke();
              return result;
            });
          try {
            await resume(options, operation);
          } finally {
            checkpoint.mockRestore();
          }
        });
      }
      if (mode === "resume-retry" || mode === "concurrent-edit") {
        resumeSpy.mockImplementationOnce(async (options, operation) => {
          if (mode === "resume-retry") {
            options.respond(false, undefined, {
              code: "UNAVAILABLE",
              message: "Admission unavailable",
            });
            return;
          }
          await patchSessionEntryCore(scope(), (entry) => ({
            goal: entry.goal && {
              ...entry.goal,
              objective: "A newer operator decision",
              updatedAt: Date.now() + 1,
            },
          }));
          await resume(options, operation);
        });
      }
      runEmbeddedAgent.mockImplementation(async (params) => {
        const first = runEmbeddedAgent.mock.calls.length === 1;
        if (first) {
          originalRun = params.runId!;
          const abort = new AbortController();
          const cancel = () => {
            order.push("interrupt");
            abort.abort();
            interrupted.resolve();
          };
          const backend = {
            kind: "embedded" as const,
            runId: params.runId,
            cancel,
            abort: cancel,
            isStreaming: () => !abort.signal.aborted,
            isAborted: () => abort.signal.aborted,
            isCompacting: () => false,
            queueMessage: async () => {},
          };
          params.replyOperation?.attachBackend(backend);
          runs.attachActiveEmbeddedRun(
            params.sessionId,
            backend,
            scope().sessionKey,
            params.sessionFile,
            "main",
            params.replyOperation,
          );
          started.resolve();
          try {
            await physicalRelease.promise;
          } finally {
            runs.detachActiveEmbeddedRun(
              params.sessionId,
              backend,
              scope().sessionKey,
              params.sessionFile,
            );
            params.replyOperation?.detachBackend(backend);
          }
          oldSettled = true;
          order.push("settled");
          await patchSessionEntryCore(scope(), () => ({
            lifecycleRunId: undefined,
            lastRunId: originalRun,
            abortedLastRun: true,
          }));
          return {
            payloads: [],
            meta: {
              durationMs: 0,
              aborted: true,
              stopReason: "aborted",
              agentMeta: {
                sessionId: params.sessionId,
                provider: "test",
                model: "test",
                usage: { input: 1, output: 1 },
              },
            },
          };
        }
        order.push("resumed");
        expect(oldSettled).toBe(true);
        resumed.resolve();
        await resumedRelease.promise;
        await patchSessionEntryCore(scope(), (entry) => ({
          goal: entry.goal && { ...entry.goal, status: "complete" },
        }));
        return {
          payloads: [{ text: "The updated checklist is complete." }],
          meta: {
            durationMs: 0,
            agentMeta: {
              sessionId: params.sessionId,
              provider: "test",
              model: "test",
              usage: { input: 1, output: 1 },
            },
          },
        };
      });
      let replace: Promise<MockInstance<RespondFn>> | undefined;
      try {
        if (mode === "allowed-principal") {
          setRuntimeConfigSnapshot(policy);
        }
        await patchSessionEntryCore(scope(), () => ({ totalTokens: 100, totalTokensFresh: true }));
        expect(
          (
            await rpc(
              "chat.send",
              goalStart("Finish the original checklist"),
              undefined,
              mode === "allowed-principal" ? requester : originalRequester,
            )
          ).mock.calls[0]?.[0],
        ).toBe(true);
        await started.promise;
        if (secured && mode !== "allowed-principal") {
          // The revoked replacement caller does not own the original turn. Role
          // retirement must not make the cancellation oracle abort that source.
          setRuntimeConfigSnapshot(policy);
        }
        vi.spyOn(goals, "mutateSessionGoal").mockImplementation(async (options) => {
          order.push(options.operation.action);
          expect(oldSettled, options.operation.action).toBe(true);
          if (options.operation.action === failStage) {
            failStage = undefined;
            throw new Error("Stage unavailable");
          }
          const committed = await mutate(options);
          if (
            (mode === "revoke-pause" && options.operation.action === "pause") ||
            (mode === "revoke-edit" && options.operation.action === "edit")
          ) {
            await revoke();
          }
          return committed;
        });
        const original = loadSessionEntry(scope())!.goal!;
        if (mode === "abort-warning") {
          getContext().chatRunState.getOrCreate(originalRun).buffer =
            "Checking the deployment checklist.";
        }
        const request = {
          sessionKey: scope().sessionKey,
          agentId: "main",
          sessionId: scope().sessionId,
          action: "replace",
          operationId: randomUUID(),
          issuedAtMs: Date.now(),
          goalId: original.id,
          expectedGoalUpdatedAt: original.updatedAt,
          expectedRunId: originalRun,
          objective: "Finish the replacement checklist",
        };
        if (mode === "denied-session") {
          await revoke();
          const denied = await updateGoal(request);
          expect(denied.mock.calls[0]?.[0]).toBe(false);
          expect(order).toEqual([]);
          expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
          expect(loadSessionEntry(scope())?.goal).toMatchObject(original);
          return;
        }
        if (mode === "success") {
          const target = captureSessionTarget({
            storeScope: scope().storePath,
            sessionKey: scope().sessionKey,
            incarnation: scope().sessionId,
          });
          const owner = Symbol("unrelated-admission");
          const first = await beginSessionEffect({ target, owner, serializeOwner: true });
          const unrelatedInterrupted = vi.fn();
          const pending = beginSessionEffect({
            target,
            owner,
            serializeOwner: true,
            onInterrupt: unrelatedInterrupted,
          });
          const owned = Promise.allSettled([pending]);
          try {
            for (const stale of [
              { expectedRunId: "a-newer-or-unrelated-turn" },
              { expectedGoalUpdatedAt: original.updatedAt + 1 },
            ]) {
              const rejected = await updateGoal({
                ...request,
                ...stale,
                operationId: randomUUID(),
              });
              expect(rejected.mock.calls[0]?.[0]).toBe(false);
              expect(order).toEqual([]);
              expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
              expect(unrelatedInterrupted).not.toHaveBeenCalled();
            }
          } finally {
            first.release();
            const [settled] = await owned;
            if (settled.status === "fulfilled") {
              settled.value.release();
            }
            expect(settled.status).toBe("fulfilled");
          }
        }
        replace = updateGoal(request);
        await Promise.race([
          interrupted.promise,
          replace.then((response) => {
            throw new Error(JSON.stringify(response.mock.calls));
          }),
        ]);
        expect(loadSessionEntry(scope())?.goal).toMatchObject({
          id: original.id,
          status: "active",
          objective: original.objective,
        });
        expect(order).toEqual(["interrupt"]);
        if (mode === "revoke-settlement") {
          await revoke();
        }
        physicalRelease.resolve();
        let response = await replace;
        if (mode !== "success" && mode !== "allowed-principal") {
          expect(response.mock.calls[0]).toMatchObject([false, undefined, { code: "UNAVAILABLE" }]);
          expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
          expect(loadSessionEntry(scope())?.goal).toMatchObject({
            id: original.id,
            status:
              mode === "pause-retry" || mode === "abort-warning" || mode === "revoke-settlement"
                ? "active"
                : "paused",
            objective:
              mode === "edit-retry" ||
              mode === "pause-retry" ||
              mode === "abort-warning" ||
              mode === "revoke-settlement" ||
              mode === "revoke-pause" ||
              mode === "revoke-recovery"
                ? original.objective
                : mode === "concurrent-edit"
                  ? "A newer operator decision"
                  : request.objective,
          });
          if (mode === "revoke-recovery") {
            const before = [...order];
            await revoke();
            const denied = await updateGoal(request);
            expect(denied.mock.calls[0]?.[0]).toBe(false);
            expect(order).toEqual(before);
            expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
            return;
          }
          if (mode === "revoke-resume") {
            expect(resumeReadObserved).toBe(true);
            if (!attemptedResume) {
              throw new Error("Normal Resume was not reached");
            }
            const target = scope();
            expect(
              await goalReads.lookupSessionGoalOperation({
                agentId: target.agentId,
                sessionKey: target.sessionKey,
                storePath: target.storePath,
                expectedSessionId: target.sessionId,
                operation: attemptedResume,
              }),
            ).toBeUndefined();
          }
          if (secured) {
            return;
          }
          if (mode === "abort-warning") {
            expect(response.mock.calls[0]?.[2]?.message).toContain("could not be saved to history");
            return;
          }
          if (mode === "concurrent-edit") {
            return;
          }
          response = await updateGoal(request);
        }
        expect(
          response.mock.calls[0]?.slice(0, 2),
          JSON.stringify(response.mock.calls),
        ).toMatchObject([true, { action: "replace", status: "started", goalId: original.id }]);
        await resumed.promise;
        const updated = loadSessionEntry(scope())!.goal!;
        expect(updated).toMatchObject({
          id: original.id,
          status: "active",
          objective: request.objective,
          tokenStart: original.tokenStart,
        });
        expect(updated.tokenBudget).toBe(original.tokenBudget);
        expect(order.indexOf("settled")).toBeLessThan(order.indexOf("pause"));
        expect(order.indexOf("pause")).toBeLessThan(order.indexOf("edit"));
        expect(order.indexOf("edit")).toBeLessThan(order.indexOf("resumed"));
        const replay = await updateGoal(request);
        expect(replay.mock.calls[0]?.slice(0, 2)).toMatchObject([
          true,
          { action: "replace", replayed: true },
        ]);
        expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
        expect(order.filter((stage) => stage === "interrupt")).toHaveLength(1);
      } finally {
        physicalRelease.resolve();
        resumedRelease.resolve();
        await replace;
        await patchSessionEntryCore(scope(), (entry) => ({
          goal: entry.goal && { ...entry.goal, status: "complete" },
        }));
        expect((await waitForGatewayActiveWork(30_000)).drained).toBe(true);
        vi.mocked(goals.mutateSessionGoal).mockRestore();
        resumeSpy.mockRestore();
        persistence?.mockRestore();
        if (profile) {
          setRuntimeConfigSnapshot(initialConfig);
          expect((await waitForGatewayActiveWork(30_000)).drained).toBe(true);
        }
        const resumes = [
          "success",
          "pause-retry",
          "edit-retry",
          "resume-retry",
          "allowed-principal",
        ].includes(mode);
        expect(runEmbeddedAgent).toHaveBeenCalledTimes(resumes ? 2 : 1);
      }
    },
    35_000,
  );
}
