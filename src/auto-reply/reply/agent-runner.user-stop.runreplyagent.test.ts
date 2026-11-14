/** Tests which `runReplyAgent` routes state a user's Stop: only a turn admitted to run claims it. */
import { expect, it, vi } from "vitest";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { registerPendingAgentQuestion } from "../../agents/harness/gateway-question.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  runEmbeddedAgentMock,
  setupAgentRunnerTestHooks,
  storedSession,
} from "./agent-runner.misc.runreplyagent.test-support.js";
import { type BaseRunOptions, createBaseRun } from "./agent-runner.runreplyagent.test-support.js";
import * as turnAdmission from "./reply-turn-admission.js";

// Hoist the runner's mocks before static dependencies load.
await vi.hoisted(async () => {
  await import("./agent-runner.misc.runreplyagent.test-support.js");
});

setupAgentRunnerTestHooks();

const STOPPED = "The user stopped the previous agent run";

/** A session whose last run a user stopped, and its next turns through the real runner. */
async function stoppedSession() {
  const session = await storedSession({ userStoppedAt: 5, userStoppedSessionId: "session" });
  const prompts: string[] = [];
  runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentInternalParams) => {
    prompts.push(params.prompt);
    return { payloads: [{ text: "Done" }], meta: {} };
  });
  return {
    prompts,
    recorded: () => loadSessionEntry(session.scope)?.userStoppedAt,
    turn: (options: BaseRunOptions = {}) =>
      createBaseRun({
        ...options,
        run: { agentId: "main", sessionKey: session.sessionKey, ...options.run },
        reply: { ...session.reply, ...options.reply },
      }).run(),
  };
}

/** Routes that answer, refuse or skip a turn without running its prompt. */
const promptless: Record<string, () => { options: BaseRunOptions; dispose?: () => void }> = {
  "a refused pending-question answer": () => {
    const question = registerPendingAgentQuestion({
      questionId: "ask_after_stop",
      sessionKey: "main",
      questions: [{ id: "c", header: "Color", question: "Which?", options: [{ label: "Green" }] }],
      gatewayCall: vi.fn(async () => ({ status: "answered" })),
      answer: Promise.resolve({ status: "pending" }),
    });
    question.attachRegistration(Promise.resolve({ id: "ask_after_stop" }));
    return {
      options: {
        context: { agentText: "Green" },
        reply: { commandBody: "Green", isActive: true, shouldSteer: true },
      },
      dispose: () => question.dispose(),
    };
  },
  "a collaborative-steering refusal": () => ({
    options: {
      run: { config: { messages: { queue: { collaborativeSteeringFallback: "reject" } } } },
      reply: { opts: { messageInjectionDisposition: "collaborative-steering-disabled" } },
    },
  }),
  "a turn skipped while the stopped run still shuts down": () => {
    // The stopped run still owns the session, so turn admission skips this one.
    vi.spyOn(turnAdmission, "admitReplyTurn").mockResolvedValueOnce({
      status: "skipped",
      reason: "active-run",
    });
    return { options: {} };
  },
};

it("states a recorded Stop once, in the turn admitted to run", async () => {
  const session = await stoppedSession();
  await session.turn();
  await session.turn();
  expect(session.prompts).toHaveLength(2);
  expect(session.prompts[0]?.split(STOPPED)).toHaveLength(2);
  expect(session.prompts[1]).not.toContain(STOPPED);
  expect(session.recorded()).toBeUndefined();
});

it.each(Object.keys(promptless))("leaves the Stop past %s for the next turn", async (route) => {
  const session = await stoppedSession();
  const { options, dispose } = promptless[route]!();
  try {
    await session.turn(options);
  } finally {
    dispose?.();
  }
  expect(session.prompts).toEqual([]);
  expect(session.recorded()).toBe(5);
  await session.turn();
  expect(session.prompts[0]?.split(STOPPED)).toHaveLength(2);
  expect(session.recorded()).toBeUndefined();
});
