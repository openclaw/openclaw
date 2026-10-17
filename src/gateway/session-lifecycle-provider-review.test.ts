import { afterEach, expect, it, vi } from "vitest";
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
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
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
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionLifecyclePersistenceOwner } from "./session-lifecycle-persistence-owner.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

afterEach(() => {
  vi.restoreAllMocks();
  memorySessionActorOwners.reset();
});

function reviewFixture(env: NodeJS.ProcessEnv, name: string) {
  const runId = `review-terminal-${name}`;
  const target = {
    agentId: "main",
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
    sessionKey: `agent:main:dashboard:incognito-${name}`,
    sessionId: `review-session-${name}`,
    lifecycleRevision: "generation-1",
  };
  const review: SessionProviderReview = {
    id: `review-${name}`,
    sessionId: target.sessionId,
    runId,
    provider: "openai",
    model: "test-model",
    runtimeId: "codex",
  };
  const entry: SessionEntry = {
    sessionId: target.sessionId,
    incognito: true,
    lifecycleRevision: target.lifecycleRevision,
    activeWriterRunId: runId,
    lifecycleRunId: runId,
    updatedAt: 1_000,
    startedAt: 1_000,
  };
  const scope = {
    agentId: target.agentId,
    storePath: target.storePath,
    sessionKey: target.sessionKey,
    env,
  };
  return {
    runId,
    target,
    review,
    entry,
    scope,
    capture: (assertCurrent: () => void) =>
      captureAgentRunProviderReview({
        runId,
        target,
        review,
        expectedWriterRunId: runId,
        assertCurrent,
      }),
    async seed() {
      await createSessionEntryWithTranscript(scope, () => ({ ok: true, entry }));
      if (entry.providerReview) {
        await sessionEntries.patchSessionEntryCore(
          scope,
          () => ({ providerReview: entry.providerReview }),
          { providerReviewMutation: true, skipMaintenance: true },
        );
      }
      await appendTranscriptMessage(
        { ...scope, sessionId: entry.sessionId },
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
    },
  };
}

it("keeps embedded completion pending until its incognito pause fences the next admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    setRuntimeConfigSnapshot({});
    const fixture = reviewFixture(env, "deferred-review");
    const { runId, target, entry } = fixture;
    await fixture.seed();
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
      fixture.capture(admission.assertSourceCurrent);
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
      const owner = createSessionLifecyclePersistenceOwner();
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
      const fixture = reviewFixture(env, variant);
      const { runId, target, review, scope } = fixture;
      review.review = { explanation: "The provider asks you to inspect this operation." };
      const entry = Object.assign(fixture.entry, {
        sessionId: variant === "session" ? "replacement-session" : target.sessionId,
        lifecycleRevision:
          variant === "revision" ? "replacement-generation" : target.lifecycleRevision,
        activeWriterRunId: variant === "writer" ? "replacement-writer" : runId,
        lifecycleRunId: variant === "writer" ? "replacement-writer" : runId,
        ...(variant === "newer-review"
          ? { providerReview: { ...review, id: "newer-review" } }
          : {}),
      });
      await fixture.seed();
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
          fixture.capture(assertSourceCurrent);
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
            expect(sessionEntries.loadSessionEntry(scope)?.status).toBeUndefined();
          } else {
            await persistence;
          }
          expect(statements.queries.filter(isSessionEntryDataSql)).toEqual([]);
          if (variant === "current" || variant === "ordinary") {
            expect(sessionEntries.loadSessionEntry(scope)?.status).toBe("failed");
          }
        } finally {
          statements.restore();
        }
        expect(sessionEntries.loadSessionEntry(scope)?.providerReview).toEqual(
          variant === "current" ? review : entry.providerReview,
        );
      } finally {
        clearAgentRunContext(runId, lifecycleGeneration);
      }
    }
  });
});
