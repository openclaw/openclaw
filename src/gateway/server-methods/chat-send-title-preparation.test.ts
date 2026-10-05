import { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  beginSessionWorkAdmission,
  getSessionWorkAdmissionRelease,
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { scheduleChatDashboardSessionTitle } from "./chat-send-background.js";

const generate = vi.hoisted(() =>
  vi.fn<
    typeof import("../../auto-reply/reply/conversation-label-generator.js").generateConversationLabelWithFallback
  >(),
);
vi.mock("../../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback: generate,
}));

const settledTurn = () => ({ released: Promise.resolve(false), settled: Promise.resolve() });

it("does not hold worker dispatch admission while waiting for the first reply", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } } };
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:dispatch-title",
      sessionId: "dispatch-title-session",
      storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const firstReply = createDeferredCore<boolean>();
    const titleStarted = createDeferredCore();
    const titleResult = createDeferredCore<string>();
    const failure = createDeferredCore<never>();
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    context.logGateway.warn = (message) => failure.reject(new Error(message));
    generate.mockReset().mockImplementation(async () => {
      titleStarted.resolve();
      return await titleResult.promise;
    });
    scheduleChatDashboardSessionTitle(
      {
        ...scope,
        admittedSessionId: scope.sessionId,
        cfg,
        context,
        request: { rawMessage: "Continue the accepted repository work", normalizedAttachments: [] },
      },
      { released: firstReply.promise, settled: Promise.resolve() },
    );
    // This canonical admission queues behind any title lease already acquiring the same identities.
    const turn = await beginSessionWorkAdmission({
      scope: scope.storePath,
      identities: [scope.sessionKey, scope.sessionId],
      assertAllowed: () => {},
    });
    let drained: boolean | undefined;
    try {
      vi.useFakeTimers();
      const dispatch = turn.run(() =>
        runExclusiveSessionLifecycleMutation("placement-dispatch", {
          scope: scope.storePath,
          identities: [scope.sessionKey, scope.sessionId],
          prepare: async () => {
            drained = await interruptSessionWorkAdmissions({
              scope: scope.storePath,
              identities: [scope.sessionKey, scope.sessionId],
              timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
            });
          },
          run: async () => {},
        }),
      );
      await vi.advanceTimersByTimeAsync(SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS);
      await dispatch;
      expect(drained).toBe(true);
      expect(generate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      turn.release();
      firstReply.resolve(false);
      await Promise.race([titleStarted.promise, failure.promise]);
      const released = getSessionWorkAdmissionRelease({
        scope: scope.storePath,
        identities: [scope.sessionKey],
      });
      titleResult.resolve("Accepted repository work");
      await released;
    }
    expect(generate).toHaveBeenCalledOnce();
    expect(loadSessionEntry(scope)?.displayName).toBe("Accepted repository work");
  });
});

it.each([
  { titleSource: undefined, expectedSource: "Original release plan" },
  { titleSource: "Accepted worktree intent", expectedSource: "Accepted worktree intent" },
])(
  "prepares one detached title entry from $expectedSource",
  async ({ titleSource, expectedSource }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } },
      };
      await state.writeConfig(cfg);
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:detached-title",
        sessionId: "detached-title-session",
        storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
      };
      await replaceSessionEntry(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        ...(titleSource ? { pendingWorktree: { titleSource } } : {}),
      });
      await appendTranscriptMessage(scope, {
        cwd: state.workspaceDir,
        message: { role: "user", content: "Original release plan", timestamp: 1 },
      });
      const started = createDeferredCore();
      const generation = createDeferredCore<string>();
      const failed = createDeferredCore<never>();
      generate.mockReset().mockImplementation(async () => {
        started.resolve();
        return await generation.promise;
      });
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      context.logGateway.warn = (message) => failed.reject(new Error(message));
      const reads = observeSqliteReadSql(StatementSync.prototype);
      let released: Promise<void> | undefined;
      try {
        scheduleChatDashboardSessionTitle(
          {
            ...scope,
            admittedSessionId: scope.sessionId,
            cfg,
            context,
            request: { rawMessage: "A later follow-up", normalizedAttachments: [] },
          },
          settledTurn(),
        );
        await Promise.race([started.promise, failed.promise]);
        released = getSessionWorkAdmissionRelease({
          scope: scope.storePath,
          identities: [scope.sessionKey, scope.sessionId],
        });
        expect(released).toBeDefined();
        expect(
          reads.queries.filter((sql) => /\b(?:from|join)\s+"?session_nodes\b/u.test(sql)).length,
        ).toBeLessThanOrEqual(1);
        expect(generate).toHaveBeenCalledOnce();
        expect(generate.mock.calls[0]?.[0].userMessage).toBe(expectedSource);
      } finally {
        reads.restore();
        generation.resolve("Original release plan");
        await released;
      }
      expect(loadSessionEntry(scope)?.displayName).toBe("Original release plan");
    });
  },
);

it("falls back after one label attempt when naming starts after its turn settled", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {
      agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } },
    };
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:settled-title",
      sessionId: "settled-title-session",
      storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const started = createDeferredCore();
    const label = createDeferredCore<string>();
    generate.mockReset().mockImplementation(async () => {
      started.resolve();
      return await label.promise;
    });
    scheduleChatDashboardSessionTitle(
      {
        ...scope,
        admittedSessionId: scope.sessionId,
        cfg,
        context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
        request: { rawMessage: "Plan the release", normalizedAttachments: [] },
      },
      settledTurn(),
    );
    await started.promise;
    const released = getSessionWorkAdmissionRelease({
      scope: scope.storePath,
      identities: [scope.sessionKey, scope.sessionId],
    });
    expect(released).toBeDefined();
    label.reject(new Error("conversation label generation failed (primary fallback)"));
    await released;
    expect(generate).toHaveBeenCalledOnce();
    expect(loadSessionEntry(scope)?.displayName).toMatch(/^[a-z]+-[a-z]+$/);
  });
});

it("does not hold session admission across an unresolved dashboard title gate", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = {
      agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } },
    };
    await state.writeConfig(cfg);
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:rollover-title-gate",
      sessionId: "rollover-title-gate-session",
      storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
    };
    await replaceSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    await appendTranscriptMessage(scope, {
      cwd: state.workspaceDir,
      message: { role: "user", content: "Original release plan", timestamp: 1 },
    });
    const ready = createDeferredCore<boolean>();
    const started = createDeferredCore();
    const generation = createDeferredCore<string>();
    const failed = createDeferredCore<never>();
    generate.mockReset().mockImplementation(async () => {
      started.resolve();
      return await generation.promise;
    });
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    context.logGateway.warn = (message) => failed.reject(new Error(message));
    const admissionQuery = {
      scope: scope.storePath,
      identities: [scope.sessionKey, scope.sessionId],
    };
    let released: Promise<void> | undefined;
    let competing: { release: () => void } | undefined;
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      scheduleChatDashboardSessionTitle(
        {
          ...scope,
          admittedSessionId: scope.sessionId,
          cfg,
          context,
          request: { rawMessage: "A later follow-up", normalizedAttachments: [] },
        },
        { released: ready.promise, settled: Promise.resolve() },
      );
      for (let step = 0; step < 8; step += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(getSessionWorkAdmissionRelease(admissionQuery)).toBeUndefined();
      const titleDrain = interruptSessionWorkAdmissions({ ...admissionQuery, timeoutMs: 0 });
      await vi.advanceTimersByTimeAsync(0);
      await expect(titleDrain).resolves.toBe(true);

      competing = await beginSessionWorkAdmission({
        scope: scope.storePath,
        identities: ["agent:main:dashboard:competing-title-lease"],
        assertAllowed: () => {},
      });
      const competingDrain = interruptSessionWorkAdmissions({
        scope: scope.storePath,
        identities: ["agent:main:dashboard:competing-title-lease"],
        timeoutMs: 0,
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(competingDrain).resolves.toBe(false);

      ready.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.race([started.promise, failed.promise]);
      released = getSessionWorkAdmissionRelease(admissionQuery);
      expect(released).toBeDefined();
      expect(generate).toHaveBeenCalledOnce();
    } finally {
      competing?.release();
      ready.resolve(true);
      generation.resolve("Original release plan");
      await released;
      vi.useRealTimers();
    }
    expect(loadSessionEntry(scope)?.displayName).toBe("Original release plan");
  });
});
