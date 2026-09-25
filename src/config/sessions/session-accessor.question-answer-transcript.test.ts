import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  cancelPendingAgentQuestionForSession,
  claimPendingAgentQuestionAnswer,
  runAgentHarnessGatewayQuestion,
} from "../../agents/harness/gateway-question.js";
import { withQuestionGateway } from "../../agents/harness/gateway-question.test-support.js";
import { createAdmittedHostCapabilityTestFixture } from "../../agents/harness/host-capability.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../agents/harness/tool-authority.runtime.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  createTestUserTurnTranscriptTarget,
  readTranscriptMessages,
} from "../../sessions/user-turn-transcript.test-support.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  replaceSessionEntry,
  rewriteTranscriptMessageAtAnchor,
  type TranscriptEntryAnchor,
  withTranscriptWriteLock,
} from "./session-accessor.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const questions = [
  { id: "destination", header: "Destination", question: "Where?", isOther: true, options: [] },
  { id: "budget", header: "Budget", question: "Budget?", isOther: true, options: [] },
];

it.each([
  "complete",
  "foreign-registration",
  "partial-then-complete",
  "unrelated-user",
  "closed-authority",
  "changed-branch",
  "rewritten-source",
  "missing-generation",
  "cancelled",
] as const)("fences the waiting question's transcript append: %s", async (scenario) => {
  await withQuestionGateway(async (gateway) => {
    const dir = tempDirs.make("question-transcript-append-");
    const storePath = path.join(dir, "sessions.sqlite");
    const target = {
      ...createTestUserTurnTranscriptTarget({
        sessionId: "question-transcript",
        sessionKey: "agent:main:question-transcript",
        cwd: dir,
      }),
      storePath,
    };
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const original = createUserTurnTranscriptRecorder({
      target,
      input: { text: "Plan a trip", idempotencyKey: "original:user" },
    });
    const persisted = await original.persistApproved();
    if (!persisted) {
      throw new Error("original input did not persist");
    }
    const controller = new AbortController();
    const attempt = {
      agentId: target.agentId,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      sessionFile: persisted.sessionFile,
      runId: "question-run",
      workspaceDir: dir,
      config: {},
      provider: "fixture",
      modelId: "fixture",
      messageProvider: "webchat",
      senderIsOwner: true,
      userTurnTranscriptRecorder: original,
      abortSignal: controller.signal,
    };
    const host = await createAdmittedHostCapabilityTestFixture(attempt);
    const askQuestion = () =>
      runAgentHarnessGatewayQuestion({
        questions,
        sessionKey: target.sessionKey,
        runId: attempt.runId,
        agentId: target.agentId,
        timeoutMs: 60_000,
        signal: controller.signal,
        delivery: { hostCapabilities: host.hostCapabilities, onBlockReply: async () => {} },
      });
    const foreignQuestion = createDeferred<Awaited<ReturnType<typeof askQuestion>>>();
    const writer = SessionManager.open(target, dir);
    const releaseAppend = createDeferred();
    const providerResumed = vi.fn();
    const resolved = vi.fn();
    gateway.onResolved(resolved);
    const run = withPreparedEmbeddedRunToolAuthority(
      { admittedRunContext: host.admittedRunContext },
      { ...attempt, hostCapabilities: host.hostCapabilities },
      undefined,
      async () => {
        const answer =
          scenario === "foreign-registration" ? await foreignQuestion.promise : await askQuestion();
        await releaseAppend.promise;
        const entryId = writer.appendMessage({
          role: "toolResult",
          toolCallId: "trip-question",
          toolName: "ask_user",
          content: [{ type: "text", text: JSON.stringify(answer) }],
          isError: answer.status !== "answered",
          timestamp: 4,
        });
        providerResumed(answer);
        return entryId;
      },
    );
    const outcome = run.then(
      (entryId) => ({ entryId, error: undefined }),
      (error: unknown) => ({ entryId: undefined, error }),
    );
    if (scenario === "foreign-registration") {
      void askQuestion().then(foreignQuestion.resolve, foreignQuestion.reject);
    }
    let sourceAnchor: TranscriptEntryAnchor | undefined;
    const answer = async (text: string, id: string) => {
      const source = createUserTurnTranscriptRecorder({
        target,
        input: { text, idempotencyKey: `${id}:user` },
      });
      await source.stageApproved?.({ runId: id, assertCurrent: () => {} });
      const claimed = await claimPendingAgentQuestionAnswer({
        sessionKey: target.sessionKey,
        text,
        sourceRecorder: source,
        authority: { kind: "run", assertCurrent: () => controller.signal.throwIfAborted() },
      });
      sourceAnchor = source.getAdmissionReceipt();
      return claimed;
    };
    try {
      await gateway.waitStarted;
      if (scenario === "partial-then-complete" || scenario === "cancelled") {
        await expect(answer("Lisbon", "partial")).rejects.toThrow(/budget.*requires an answer/);
        expect(gateway.manager.list()).toHaveLength(1);
      }
      if (scenario === "cancelled") {
        await expect(
          cancelPendingAgentQuestionForSession({
            sessionKey: target.sessionKey,
            resolvedBy: "user-cancel",
          }),
        ).resolves.toBe(true);
        controller.abort(new Error("question run cancelled"));
      } else {
        await expect(answer("1: Lisbon\n2: 2000", "complete")).resolves.toBe(true);
      }
      if (scenario === "unrelated-user") {
        await createUserTurnTranscriptRecorder({
          target,
          input: { text: "An unrelated new turn", idempotencyKey: "unrelated:user" },
        }).persistApproved();
      } else if (scenario === "missing-generation") {
        if (!sourceAnchor) {
          throw new Error("question answer did not persist");
        }
        const database = openOpenClawAgentDatabase({
          agentId: target.agentId,
          path: sourceAnchor.storePath,
        });
        await withTranscriptWriteLock(target, async () => {
          database.db.exec("DELETE FROM transcript_rewrite_watermarks");
        });
      } else if (scenario === "closed-authority") {
        host.closeHost();
      } else if (scenario === "rewritten-source") {
        if (!sourceAnchor) {
          throw new Error("question answer did not persist");
        }
        expect(
          await rewriteTranscriptMessageAtAnchor(sourceAnchor, () => ({
            role: "user",
            content: "Changed answer",
            timestamp: 5,
          })),
        ).not.toBeNull();
      } else if (scenario === "changed-branch") {
        const other = SessionManager.open(target, dir);
        other.resetLeaf();
        other.appendMessage({ role: "user", content: "Another branch", timestamp: 5 });
      }
      releaseAppend.resolve();
      const result = await outcome;
      const messages = await readTranscriptMessages({
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        storePath,
      });
      const toolResults = messages.filter((message) => message.role === "toolResult");
      if (
        scenario === "complete" ||
        scenario === "foreign-registration" ||
        scenario === "partial-then-complete"
      ) {
        expect(result.error).toBeUndefined();
        expect(result.entryId).toEqual(expect.any(String));
        expect(toolResults).toEqual([
          expect.objectContaining({
            toolCallId: "trip-question",
            isError: false,
            content: [{ type: "text", text: JSON.stringify(providerResumed.mock.calls[0]?.[0]) }],
          }),
        ]);
        expect(resolved).toHaveBeenCalledOnce();
        expect(providerResumed).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            status: "answered",
            answers: { answers: { destination: ["Lisbon"], budget: ["2000"] } },
          }),
        );
        expect(messages.filter((message) => message.role === "user")).toHaveLength(
          scenario === "partial-then-complete" ? 3 : 2,
        );
      } else {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error).toMatchObject({
          message: expect.stringMatching(
            scenario === "closed-authority" || scenario === "cancelled"
              ? /no longer active|SQLite transcript changed while preparing rewrite/
              : /SQLite transcript changed while preparing rewrite/,
          ),
        });
        expect(toolResults).toHaveLength(0);
        expect(providerResumed).not.toHaveBeenCalled();
        if (scenario === "missing-generation") {
          expect(messages.filter((message) => message.role === "user")).toHaveLength(2);
        }
      }
    } finally {
      controller.abort();
      releaseAppend.resolve();
      await outcome;
      host.closeHost();
      host.closeAdmission();
    }
  });
});
