import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { getAdmittedRunDelegatedAuthority } from "../agents/admitted-run-context.js";
import { prepareAgentCommandExecutionIdentity } from "../agents/agent-command-execution-identity.js";
import { resolveSessionWorkStartError } from "../config/sessions/lifecycle.js";
import type { SessionProviderReview } from "../config/sessions/provider-review.types.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { appendTranscriptMessageSync } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import {
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
} from "../infra/agent-run-registry.js";
import { captureAgentRunTerminalWriteContext } from "../infra/agent-run-terminal-writes.js";
import {
  captureAgentRunProviderReview,
  readAgentRunProviderReview,
} from "../sessions/provider-review-terminal.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionLifecyclePersistenceOwner } from "./session-lifecycle-persistence-owner.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

it("keeps embedded completion pending until its incognito pause fences the next admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const runId = "incognito-deferred-review";
    const target = {
      agentId: "main",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
      sessionKey: "agent:main:dashboard:incognito-deferred-review",
      sessionId: "incognito-deferred-session",
      lifecycleRevision: "generation-1",
    };
    const options = { agentId: "main", env, path: target.storePath };
    const database = openOpenClawAgentDatabase(options);
    const entry = {
      sessionId: target.sessionId,
      lifecycleRevision: target.lifecycleRevision,
      activeWriterRunId: runId,
      lifecycleRunId: runId,
      updatedAt: 1_000,
      startedAt: 1_000,
      status: "running" as const,
    };
    writeSessionEntry(database, target.sessionKey, entry);
    appendTranscriptMessageSync(
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
      const captured = captureAgentRunTerminalWriteContext(runId);
      if (!captured) {
        throw new Error("Embedded terminal persistence was not retained");
      }
      const entered = createDeferred();
      const release = createDeferred();
      const held = runOpenClawAgentWriteAdmission(options, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
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
          readExactSessionEntryRow(database, target.sessionKey)?.entry,
        );
      });
      try {
        await Promise.resolve();
        expect(finished).toBe(false);
        expect(
          readExactSessionEntryRow(database, target.sessionKey)?.entry.providerReview,
        ).toBeUndefined();
        release.resolve();
        await expect(nextAdmission).resolves.toContain("paused as a precaution");
        await persistence;
      } finally {
        release.resolve();
        await Promise.allSettled([held, persistence, nextAdmission]);
        await owner.drain();
      }
    } finally {
      admission.close();
    }
  });
});

it("records an incognito pause in its existing terminal entry write and fences stale facts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env,
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
    });
    for (const variant of [
      "ordinary",
      "current",
      "session",
      "revision",
      "writer",
      "newer-review",
      "old-event",
    ] as const) {
      const runId = `review-terminal-${variant}`;
      const target = {
        agentId: "main",
        storePath: database.path,
        sessionKey: `agent:main:dashboard:incognito-${variant}`,
        sessionId: `review-session-${variant}`,
        lifecycleRevision: "generation-1",
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
        lifecycleRevision:
          variant === "revision" ? "replacement-generation" : target.lifecycleRevision,
        activeWriterRunId: variant === "writer" ? "replacement-writer" : runId,
        lifecycleRunId: variant === "writer" ? "replacement-writer" : runId,
        updatedAt: 1_000,
        startedAt: 1_000,
        status: "running" as const,
        ...(variant === "newer-review"
          ? { providerReview: { ...review, id: "newer-review" } }
          : {}),
      };
      writeSessionEntry(database, target.sessionKey, entry, { providerReviewMutation: true });
      appendTranscriptMessageSync(
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
      const lifecycleGeneration = getAgentRunLifecycleGeneration();
      registerAgentRunContext(runId, {
        agentId: target.agentId,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        lifecycleGeneration,
        lifecycleStartedAt: 1_000,
      });
      try {
        if (variant !== "ordinary") {
          captureAgentRunProviderReview({
            runId,
            target,
            review,
            expectedWriterRunId: runId,
            assertCurrent() {},
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
        const statements = trackSqliteStatementExecutions(database.db, ["entryWrite"], (sql) =>
          /(?:insert into|update) "session_nodes"/i.test(sql) && /entry_json/i.test(sql)
            ? "entryWrite"
            : null,
        );
        try {
          await persistGatewaySessionLifecycleEvent({
            sessionKey: target.sessionKey,
            agentId: "main",
            event,
          });
          // The normal lifecycle write already owns entry serialization; a pause adds no second write.
          expect(statements.counts.entryWrite).toBeLessThanOrEqual(1);
          if (variant === "current" || variant === "ordinary") {
            expect(statements.counts.entryWrite).toBe(1);
          }
        } finally {
          statements.restore();
        }
        expect(readExactSessionEntryRow(database, target.sessionKey)?.entry.providerReview).toEqual(
          variant === "current" ? review : entry.providerReview,
        );
      } finally {
        clearAgentRunContext(runId, lifecycleGeneration);
      }
    }
  });
});

it("refuses an incognito terminal review when its source authority expires before commit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const runId = "review-terminal-revoked";
    const target = {
      agentId: "main",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
      sessionKey: "agent:main:dashboard:incognito-revoked",
      sessionId: "review-revoked",
      lifecycleRevision: "generation-1",
    };
    const database = openOpenClawAgentDatabase({ agentId: "main", env, path: target.storePath });
    writeSessionEntry(database, target.sessionKey, {
      sessionId: target.sessionId,
      lifecycleRevision: target.lifecycleRevision,
      activeWriterRunId: runId,
      lifecycleRunId: runId,
      updatedAt: 1_000,
      status: "running",
    });
    let current = true;
    const assertSourceCurrent = () => {
      if (!current) {
        throw new Error("Source authority expired");
      }
    };
    const lifecycleGeneration = getAgentRunLifecycleGeneration();
    registerAgentRunContext(runId, {
      agentId: "main",
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      lifecycleGeneration,
      assertSourceCurrent,
    });
    try {
      captureAgentRunProviderReview({
        runId,
        target,
        expectedWriterRunId: runId,
        assertCurrent: assertSourceCurrent,
        review: {
          id: "revoked-review",
          sessionId: target.sessionId,
          runId,
          provider: "openai",
          model: "test-model",
          runtimeId: "codex",
        },
      });
      await expect(
        persistGatewaySessionLifecycleEvent({
          sessionKey: target.sessionKey,
          agentId: "main",
          event: {
            runId,
            sessionId: target.sessionId,
            lifecycleGeneration,
            ts: Date.now(),
            data: { phase: "end", stopReason: "error" },
          },
          assertCommitAllowed: () => {
            current = false;
          },
        }),
      ).rejects.toThrow("Source authority expired");
      expect(readExactSessionEntryRow(database, target.sessionKey)?.entry).toMatchObject({
        status: "running",
      });
      expect(
        readExactSessionEntryRow(database, target.sessionKey)?.entry.providerReview,
      ).toBeUndefined();
    } finally {
      clearAgentRunContext(runId, lifecycleGeneration);
    }
  });
});
