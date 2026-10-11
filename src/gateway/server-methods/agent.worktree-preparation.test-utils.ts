// Imported by agent.test.ts to share its handler mocks and runtime fixture.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import type { InternalSessionEntry } from "../../config/sessions.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  describe0AfterEach0,
  getAgentTestMocks,
  invokeAgent,
  makeContext,
  mockCallArg,
} from "./agent.test-harness.js";
import * as sessionCreateProject from "./session-create-project.js";

const mocks = getAgentTestMocks();

describe("gateway agent worktree preparation", () => {
  afterEach(describe0AfterEach0);

  it.for(["ok", "error"] as const)(
    "settles routed recipient dedupe after worktree preparation returns %s",
    async (outcome, { signal }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const sessionKey = "agent:ops:whatsapp:direct:+15551234567";
      const runId = `recipient-worktree-${outcome}`;
      const entry: InternalSessionEntry = {
        sessionId: "recipient-session",
        updatedAt: 1,
        pendingWorktree: { workspace: "/tmp/project", titleSource: "Prepare workspace" },
      };
      const store = { [sessionKey]: entry };
      mocks.listAgentIds.mockReturnValue(["main", "ops"]);
      mocks.resolveAgentExplicitRecipientSession.mockResolvedValue({ sessionKey });
      mocks.loadSessionEntry.mockImplementation(() => ({
        cfg: {},
        storePath: "/tmp/sessions.json",
        entry: store[sessionKey],
        canonicalKey: sessionKey,
      }));
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => updater(store));
      mocks.agentCommand.mockResolvedValue({ payloads: [{ text: "ok" }] });
      const preparing = createDeferredCore();
      const prepared = createDeferredCore();
      using prepare = vi
        .spyOn(sessionCreateProject, "prepareSessionWorkspaceForRun")
        .mockImplementation(async () => {
          preparing.resolve();
          await prepared.promise;
          if (outcome === "error") {
            throw new Error("worktree preparation failed");
          }
        });
      const context = makeContext();
      const execution = new AsyncWorkScope();
      context.trackExecution = (run) => execution.track(run);
      const respond = vi.fn();
      const params = {
        message: "hi",
        agentId: "ops",
        channel: "whatsapp",
        to: "+15551234567",
        idempotencyKey: runId,
      };
      try {
        await invokeAgent(params, { context, respond, flushDispatch: false });
        expect(mockCallArg(respond)).toBe(true);
        expect(mockCallArg(respond, 0, 1)).toMatchObject({ runId, sessionKey, status: "accepted" });
        await vi.advanceTimersByTimeAsync(10);
        await withinTest(preparing.promise, signal);
        expect(context.chatAbortControllers.has(runId)).toBe(true);
        expect(context.dedupe.get(`agent:${runId}`)?.payload).toMatchObject({
          runId,
          sessionKey,
          status: "accepted",
        });
        expect(context.dedupe.get(`agent:${runId}`)?.payload).not.toHaveProperty("reservationId");
        expect(mocks.agentCommand).not.toHaveBeenCalled();

        const pendingRetry = await invokeAgent(params, { context, flushDispatch: false });
        expect(mockCallArg(pendingRetry, 0, 1)).toMatchObject({ runId, status: "in_flight" });
        expect(prepare).toHaveBeenCalledOnce();
      } finally {
        prepared.resolve();
        await vi.advanceTimersByTimeAsync(10);
        await withinTest(execution.drain(), signal);
      }
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      expect(context.dedupe.get(`agent:${runId}`)?.payload).toMatchObject({
        runId,
        status: outcome,
      });
      const completedRetry = await invokeAgent(params, { context, flushDispatch: false });
      expect(mockCallArg(completedRetry)).toBe(outcome === "ok");
      expect(mockCallArg(completedRetry, 0, 1)).toMatchObject({ runId, status: outcome });
      expect(prepare).toHaveBeenCalledOnce();
      expect(mocks.agentCommand).toHaveBeenCalledTimes(outcome === "ok" ? 1 : 0);
    },
  );
});
