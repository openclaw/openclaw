import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  cancelPendingAgentQuestionForSession,
  claimPendingAgentQuestionAnswer,
  runAgentHarnessGatewayQuestion,
} from "../../agents/harness/gateway-question.js";
import { withQuestionGateway } from "../../agents/harness/gateway-question.test-support.js";
import { createAdmittedHostCapabilityTestFixture } from "../../agents/harness/host-capability.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../agents/harness/tool-authority.runtime.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  createTestUserTurnTranscriptTarget,
  readTranscriptMessages,
} from "../../sessions/user-turn-transcript.test-support.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  replaceSessionEntry,
  rewriteTranscriptMessageAtAnchor,
  type TranscriptEntryAnchor,
  withTranscriptWriteLock,
} from "./session-accessor.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "question-transcript-append-");
const questions = [
  { id: "destination", header: "Destination", question: "Where?", isOther: true, options: [] },
  { id: "budget", header: "Budget", question: "Budget?", isOther: true, options: [] },
];

it.each([
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
    const dir = sessionDirs.make();
    const target = {
      ...createTestUserTurnTranscriptTarget({
        sessionId: "question-transcript",
        sessionKey: "agent:main:question-transcript",
        cwd: dir,
      }),
      storePath: path.join(dir, "sessions.sqlite"),
    };
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const recorder = (text: string, id: string) =>
      createUserTurnTranscriptRecorder({
        target,
        input: { text, idempotencyKey: `${id}:user` },
      });
    const original = recorder("Plan a trip", "original");
    const persisted = expectDefined(
      await original.persistApproved(),
      "original input did not persist",
    );
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
    const revokeAtCommit = vi.fn(() => host.closeHost());
    let commitAdmission: ReturnType<typeof sqliteWorkerOwnerProbe.admission> | undefined;
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
    const writer = await SessionManager.openAsync(target, dir);
    const runStarted = createDeferred();
    const releaseAppend = createDeferred();
    const run = withPreparedEmbeddedRunToolAuthority(
      { admittedRunContext: host.admittedRunContext },
      { ...attempt, hostCapabilities: host.hostCapabilities },
      undefined,
      async () => {
        runStarted.resolve();
        const answer =
          scenario === "foreign-registration" ? await foreignQuestion.promise : await askQuestion();
        await releaseAppend.promise;
        const entryId = await writer.appendMessageAsync({
          role: "toolResult",
          toolCallId: "trip-question",
          toolName: "ask_user",
          content: [{ type: "text", text: JSON.stringify(answer) }],
          isError: answer.status !== "answered",
          timestamp: 4,
        });
        return { entryId, answer };
      },
    );
    const outcome = run.then(
      (result) => ({ ...result, error: undefined }),
      (error: unknown) => ({ entryId: undefined, answer: undefined, error }),
    );
    let sourceAnchor: TranscriptEntryAnchor | undefined;
    const answer = async (text: string, id: string) => {
      const source = recorder(text, id);
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
      if (scenario === "foreign-registration") {
        await awaitGateBeforeSettlement(
          runStarted.promise,
          run,
          "Tool authority preparation ended before the waiting run started",
        );
        void askQuestion().then(foreignQuestion.resolve, foreignQuestion.reject);
      }
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
        await recorder("An unrelated new turn", "unrelated").persistApproved();
      } else if (scenario === "missing-generation") {
        const database = openOpenClawAgentDatabase({
          agentId: target.agentId,
          path: expectDefined(sourceAnchor, "question answer did not persist").storePath,
        });
        await withTranscriptWriteLock(target, async () => {
          database.db.exec("DELETE FROM transcript_rewrite_watermarks");
        });
      } else if (scenario === "closed-authority") {
        commitAdmission = sqliteWorkerOwnerProbe.admission(
          workerAdmission,
          (request, grant, admit) => {
            if (request.stage === "commit") {
              revokeAtCommit();
            }
            admit(request, grant);
          },
        );
      } else if (scenario === "rewritten-source") {
        expect(
          await rewriteTranscriptMessageAtAnchor(
            expectDefined(sourceAnchor, "question answer did not persist"),
            () => ({
              role: "user",
              content: "Changed answer",
              timestamp: 5,
            }),
          ),
        ).not.toBeNull();
      } else if (scenario === "changed-branch") {
        const other = SessionManager.open(target, dir);
        other.resetLeaf();
        other.appendMessage({ role: "user", content: "Another branch", timestamp: 5 });
      }
      releaseAppend.resolve();
      const result = await outcome;
      const messages = await readTranscriptMessages(target);
      const toolResults = messages.filter((message) => message.role === "toolResult");
      if (scenario === "foreign-registration" || scenario === "partial-then-complete") {
        expect(result.error).toBeUndefined();
        expect(result.entryId).toEqual(expect.any(String));
        expect(toolResults).toEqual([
          expect.objectContaining({
            toolCallId: "trip-question",
            isError: false,
            content: [{ type: "text", text: JSON.stringify(result.answer) }],
          }),
        ]);
        expect(result.answer).toMatchObject({
          status: "answered",
          answers: { answers: { destination: ["Lisbon"], budget: ["2000"] } },
        });
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
        if (scenario === "closed-authority") {
          expect(revokeAtCommit).toHaveBeenCalledOnce();
        }
        if (scenario === "missing-generation") {
          expect(messages.filter((message) => message.role === "user")).toHaveLength(2);
        }
      }
    } finally {
      commitAdmission?.mockRestore();
      controller.abort();
      releaseAppend.resolve();
      await outcome;
      host.closeHost();
      host.closeAdmission();
    }
  });
});
