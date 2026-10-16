import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { getAdmittedRunDelegatedAuthority } from "../agents/admitted-run-context.js";
import { prepareAgentCommandExecutionIdentity } from "../agents/agent-command-execution-identity.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionWorkStartError } from "../config/sessions/lifecycle.js";
import type { SessionProviderReview } from "../config/sessions/provider-review.types.js";
import { createSessionEntryWithTranscript } from "../config/sessions/session-accessor.entry-mutation.js";
import * as sessionEntries from "../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.transcript.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import {
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
} from "../infra/agent-run-registry.js";
import { captureAgentRunTerminalPersistence } from "../infra/agent-run-terminal-writes.js";
import {
  captureAgentRunProviderReview,
  readAgentRunProviderReview,
} from "../sessions/provider-review-terminal.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionLifecyclePersistenceOwner } from "./session-lifecycle-persistence-owner.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

afterEach(() => {
  vi.restoreAllMocks();
  memorySessionActorOwners.reset();
});

it("keeps embedded completion pending until its incognito pause fences the next admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    setRuntimeConfigSnapshot({});
    const runId = "incognito-deferred-review";
    const target = {
      agentId: "main",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
      sessionKey: "agent:main:dashboard:incognito-deferred-review",
      sessionId: "incognito-deferred-session",
      lifecycleRevision: "generation-1",
    };
    const entry = {
      sessionId: target.sessionId,
      incognito: true as const,
      lifecycleRevision: target.lifecycleRevision,
      activeWriterRunId: runId,
      lifecycleRunId: runId,
      updatedAt: 1_000,
      startedAt: 1_000,
    };
    await createSessionEntryWithTranscript({ ...target, env }, () => ({ ok: true, entry }));
    await appendTranscriptMessage(
      { ...target, env },
      {
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Provider pause",
          __openclaw: { runId },
        },
      },
    );
    const lifecycleGeneration = getAgentRunLifecycleGeneration();
    const admission = prepareAgentCommandExecutionIdentity({
      opts: { message: "Inspect this operation." },
      prepared: {
        cfg: {},
        runId,
        sessionAgentId: "main",
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionEntry: entry,
        storePath: target.storePath,
      },
      ingress: { kind: "system", boundary: "provider-review-test", state: "present" },
      lifecycleGeneration,
    });
    try {
      const context = await admission.admit("embedded");
      const authority = getAdmittedRunDelegatedAuthority(context);
      if (!authority) {
        throw new Error("Expected the real embedded admission authority");
      }
      registerAgentRunContext(runId, {
        agentId: "main",
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        lifecycleGeneration,
        lifecycleStartedAt: 1_000,
      });
      captureAgentRunProviderReview({
        runId,
        target,
        expectedWriterRunId: runId,
        assertCurrent: admission.assertSourceCurrent,
        review: {
          id: "deferred-review",
          sessionId: target.sessionId,
          runId,
          provider: "openai",
          model: "test-model",
          runtimeId: "codex",
        },
      });
      // This is the production capture path, with no CLI-specific context binding.
      const captured = captureAgentRunTerminalPersistence(runId).writeContext;
      if (!captured) {
        throw new Error("Embedded terminal persistence was not retained");
      }
      const entered = createDeferred();
      const release = createDeferred();
      const patchEntry = sessionEntries.applySessionEntryTargetOperation;
      vi.spyOn(sessionEntries, "applySessionEntryTargetOperation").mockImplementationOnce(
        async (...args) => {
          entered.resolve();
          await release.promise;
          return patchEntry(...args);
        },
      );
      const scheduler = createTestGatewayScheduler();
      onTestFinished(() => scheduler.stop());
      const owner = createSessionLifecyclePersistenceOwner(scheduler);
      const persistence = owner.observe({
        sessionKey: target.sessionKey,
        agentId: "main",
        writeContext: captured,
        authority: { runId, claimId: authority.claimId, lifecycleGeneration },
        event: {
          runId,
          sessionId: target.sessionId,
          lifecycleGeneration,
          contextClaimId: authority.claimId,
          seq: 1,
          stream: "lifecycle",
          ts: Date.now(),
          data: { phase: "end", stopReason: "error", startedAt: 1_000, endedAt: 2_000 },
        },
      });
      captured.track(persistence);
      let finished = false;
      const nextAdmission = admission.finish().then(() => {
        finished = true;
        return resolveSessionWorkStartError(
          target.sessionKey,
          sessionEntries.loadSessionEntry(target),
        );
      });
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          persistence,
          "Lifecycle persistence did not reach the memory entry write",
        );
        expect(finished).toBe(false);
        expect(sessionEntries.loadSessionEntry(target)?.providerReview).toBeUndefined();
        release.resolve();
        await expect(nextAdmission).resolves.toContain("paused as a precaution");
        await persistence;
      } finally {
        release.resolve();
        await Promise.allSettled([persistence, nextAdmission]);
        await owner.drain();
      }
    } finally {
      admission.close();
    }
  });
});

it("records an incognito pause in actor state without SQL and rejects stale facts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    setRuntimeConfigSnapshot({});
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
    for (const variant of [
      "ordinary",
      "current",
      "session",
      "revision",
      "writer",
      "newer-review",
      "old-event",
      "revoked",
    ] as const) {
      const runId = `review-terminal-${variant}`;
      const target = {
        agentId: "main",
        storePath,
        sessionKey: `agent:main:dashboard:incognito-${variant}`,
        sessionId: `review-session-${variant}`,
        lifecycleRevision: "generation-1",
      };
      const entryScope = {
        agentId: target.agentId,
        storePath,
        sessionKey: target.sessionKey,
        env,
      };
      const review: SessionProviderReview = {
        id: `review-${variant}`,
        sessionId: target.sessionId,
        runId,
        provider: "openai",
        model: "test-model",
        runtimeId: "codex",
        review: { explanation: "The provider asks you to inspect this operation." },
      };
      const entry = {
        sessionId: variant === "session" ? "replacement-session" : target.sessionId,
        incognito: true as const,
        lifecycleRevision:
          variant === "revision" ? "replacement-generation" : target.lifecycleRevision,
        activeWriterRunId: variant === "writer" ? "replacement-writer" : runId,
        lifecycleRunId: variant === "writer" ? "replacement-writer" : runId,
        updatedAt: 1_000,
        startedAt: 1_000,
        ...(variant === "newer-review"
          ? { providerReview: { ...review, id: "newer-review" } }
          : {}),
      };
      await createSessionEntryWithTranscript(entryScope, () => ({ ok: true, entry }));
      if (entry.providerReview) {
        await sessionEntries.patchSessionEntryCore(
          entryScope,
          () => ({ providerReview: entry.providerReview }),
          { providerReviewMutation: true, skipMaintenance: true },
        );
      }
      await appendTranscriptMessage(
        { ...target, env, sessionId: entry.sessionId },
        {
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "Provider pause",
            __openclaw: { runId },
          },
        },
      );
      let current = true;
      const assertSourceCurrent = () => {
        if (!current) {
          throw new Error("Source authority expired");
        }
      };
      const lifecycleGeneration = getAgentRunLifecycleGeneration();
      registerAgentRunContext(runId, {
        agentId: target.agentId,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        lifecycleGeneration,
        lifecycleStartedAt: 1_000,
        assertSourceCurrent,
      });
      try {
        if (variant !== "ordinary") {
          captureAgentRunProviderReview({
            runId,
            target,
            review,
            expectedWriterRunId: runId,
            assertCurrent: assertSourceCurrent,
          });
        }
        const fact = readAgentRunProviderReview(runId);
        const event = {
          runId,
          sessionId: target.sessionId,
          lifecycleGeneration,
          ts: variant === "old-event" ? (fact?.capturedAtMs ?? 0) - 1 : Date.now(),
          // A refusal fact is trusted runtime state; event payload alone cannot author it.
          data: {
            phase: "end",
            stopReason: "error",
            startedAt: 1_000,
            endedAt: 2_000,
            providerReview: review,
          },
        };
        const statements = observeHostDataSql();
        try {
          const persistence = persistGatewaySessionLifecycleEvent({
            sessionKey: target.sessionKey,
            agentId: "main",
            event,
            ...(variant === "revoked"
              ? {
                  assertCommitAllowed: () => {
                    current = false;
                  },
                }
              : {}),
          });
          if (variant === "revoked") {
            await expect(persistence).rejects.toThrow("Source authority expired");
            expect(sessionEntries.loadSessionEntry(entryScope)?.status).toBeUndefined();
          } else {
            await persistence;
          }
          expect(statements.queries.filter(isSessionEntryDataSql)).toEqual([]);
          if (variant === "current" || variant === "ordinary") {
            expect(sessionEntries.loadSessionEntry(entryScope)?.status).toBe("failed");
          }
        } finally {
          statements.restore();
        }
        expect(sessionEntries.loadSessionEntry(entryScope)?.providerReview).toEqual(
          variant === "current" ? review : entry.providerReview,
        );
      } finally {
        clearAgentRunContext(runId, lifecycleGeneration);
      }
    }
  });
});
