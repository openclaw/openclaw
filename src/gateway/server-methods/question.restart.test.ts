import { expect, it, vi } from "vitest";
import { formatRestartedQuestionResult } from "../../agents/tools/ask-user-tool-normalization.js";
import * as sessionEvents from "../../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { QuestionManager } from "../question-manager.js";
import { createContext } from "../server-plugin-in-process-dispatch.test-support.js";
import {
  persistRunningSessionsForRestart,
  resumeMarkedSessions,
} from "../session-restart-resume.js";
import * as systemTurnAuthority from "../session-system-turn-authority.js";
import * as support from "./question.test-support.js";
import type { GatewayClient } from "./types.js";

support.installQuestionTestHooks();
const cfg = { agents: { entries: { main: {} } } };
const { agentId, sessionKey, runId } = support.requestParams;

/** Graceful shutdown writes the session restart marker; the next Gateway consumes it. */
async function restartGateway() {
  await persistRunningSessionsForRestart({ cfg, questions: support.manager.listResumable() });
  support.replaceQuestionManager(new QuestionManager(createTestGatewayScheduler()));
  const context = createContext([], () => cfg);
  context.questionManager = support.manager;
  context.broadcast = support.broadcast;
  await resumeMarkedSessions({ context, signal: new AbortController().signal, log: { warn() {} } });
}

function withAskingSession(run: () => Promise<void>) {
  return withOpenClawTestState({ scenario: "minimal" }, async () => {
    // Session markers are written and read by real state workers.
    vi.useRealTimers();
    setRuntimeConfigSnapshot(cfg);
    replaceSessionEntrySync({ agentId, sessionKey }, { sessionId: "asking", updatedAt: 1 });
    registerAgentRunContext(runId, { sessionKey, agentId, sessionId: "asking" });
    // mock-isolation: a session turn's recorded principal is outside this boundary.
    vi.spyOn(systemTurnAuthority, "prepareSessionSystemTurnAuthority").mockResolvedValue(undefined);
    vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockReturnValue({
      id: "session-turn",
      accepted: Promise.resolve({ ok: true }),
      settled: new Promise(() => {}),
      cancel: () => false,
    });
    await run();
  });
}

it("keeps an ordinary question answerable across restarts and continues the session once", () =>
  withAskingSession(async () => {
    const enqueue = vi.mocked(sessionEvents.enqueueSessionEventForHost);
    // A second client that did not ask or answer: what restored-question events reach it.
    const otherClient = { connect: { scopes: ["operator.admin"] } } as GatewayClient;
    const reached: unknown[][] = [];
    support.broadcast.mockImplementation((event, payload, options) => {
      if (options?.questionRecipient?.(otherClient)) {
        reached.push([event, payload]);
      }
    });
    const requested = await support.callQuestionRpc(
      "question.request",
      { ...support.requestParams, timeoutMs: 60_000 },
      { client: support.adminRequestClient },
    );
    const id = (requested[1] as { id: string }).id;
    await restartGateway();
    // A second restart before the answer carries the restored question again.
    await restartGateway();
    expect((await support.callQuestionRpc("question.list", {}))[1]).toMatchObject({
      questions: [{ id, status: "pending" }],
    });
    // Clients that reconnected before restore learn the question is answerable again.
    expect(reached.at(-1)).toEqual([
      "question.requested",
      expect.objectContaining({ id, status: "pending" }),
    ]);
    // The generic restart resume turn is skipped while the question waits.
    expect(enqueue).not.toHaveBeenCalled();
    const answer = { id, answers: { answers: { destination: ["Paris"] } } };
    expect((await support.callQuestionRpc("question.resolve", answer))[0]).toBe(true);
    // Other clients see the answer, as they would for a live question.
    await vi.waitFor(() =>
      expect(reached.at(-1)).toEqual([
        "question.resolved",
        { id, status: "answered", answers: { answers: { destination: ["Paris"] } } },
      ]),
    );
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(enqueue).toHaveBeenCalledWith(
      formatRestartedQuestionResult(support.manager.get(id)!),
      expect.objectContaining({ source: "tool_handoff", contextKey: `question:${id}` }),
    );
    expect((await support.callQuestionRpc("question.resolve", answer))[2]).toMatchObject({
      details: { reason: "QUESTION_ALREADY_TERMINAL" },
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
  }));

it("never carries host-authorized or secret questions across a restart", () =>
  withAskingSession(async () => {
    const hostAuthorized = support.manager.request({
      ...support.requestParams,
      timeoutMs: 60_000,
      authorizeClient: () => true,
    });
    const ids = [hostAuthorized.id, await support.requestSecretQuestion()];
    await restartGateway();
    for (const id of ids) {
      const [ok, , error] = await support.callQuestionRpc(
        "question.get",
        { id },
        { client: support.adminRequestClient },
      );
      expect(ok).toBe(false);
      expect(error).toMatchObject({ details: { reason: "QUESTION_NOT_FOUND" } });
    }
  }));
