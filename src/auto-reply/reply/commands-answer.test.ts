/**
 * Tests /answer routing: it resolves the session's pending ask_user_question,
 * proving a parked question is answerable via the universal text fallback (the
 * hang-trap resolution). Also covers no-pending, already-resolved, auth gating,
 * numbered-option selection, and multi-part "header: answer" parsing.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AgentHarnessUserInputQuestion } from "../../agents/harness/user-input-bridge.js";
import {
  getGlobalQuestionManager,
  resetGlobalQuestionManagerForTest,
} from "../../gateway/question-manager.js";
import {
  handleAnswerCommand,
  parseAnswerCommand,
  resolvePendingQuestionFromAnswerCommand,
} from "./commands-answer.js";
import type { HandleCommandsParams } from "./commands-types.js";

const SINGLE: readonly AgentHarnessUserInputQuestion[] = [
  {
    id: "q1",
    header: "Deploy",
    question: "Ship it?",
    isOther: true,
    options: [{ label: "Yes (Recommended)" }, { label: "No" }],
  },
];

function makeParams(overrides: {
  body: string;
  sessionKey: string;
  authorized?: boolean;
}): HandleCommandsParams {
  return {
    ctx: {},
    command: {
      channel: "telegram",
      commandBodyNormalized: overrides.body,
      isAuthorizedSender: overrides.authorized ?? true,
      senderId: "user-1",
    },
    sessionKey: overrides.sessionKey,
  } as unknown as HandleCommandsParams;
}

describe("/answer command", () => {
  afterEach(() => {
    resetGlobalQuestionManagerForTest();
  });

  it("parses the command body and ignores non-/answer text", () => {
    expect(parseAnswerCommand("/answer 1")).toEqual({ text: "1" });
    expect(parseAnswerCommand("/Answer  yes please ")).toEqual({ text: "yes please" });
    expect(parseAnswerCommand("/goal status")).toBeNull();
  });

  it("resolves a PARKED question (hang-trap evidence) via a numbered selection", async () => {
    const manager = getGlobalQuestionManager();
    const { record, wait } = manager.register({ sessionKey: "s1", questions: SINGLE });

    const result = await handleAnswerCommand(
      makeParams({ body: "/answer 1", sessionKey: "s1" }),
      true,
    );
    expect(result).toEqual({ shouldContinue: false, reply: { text: "✅ Answer submitted." } });
    await expect(wait).resolves.toEqual({ q1: { text: "Yes (Recommended)" } });
    expect(manager.getSnapshot(record.id)?.status).toBe("resolved");
  });

  it("accepts free-text answers for the 'Other' path", async () => {
    const manager = getGlobalQuestionManager();
    const { wait } = manager.register({ sessionKey: "s1", questions: SINGLE });
    await handleAnswerCommand(
      makeParams({ body: "/answer ship next week instead", sessionKey: "s1" }),
      true,
    );
    await expect(wait).resolves.toEqual({ q1: { text: "ship next week instead" } });
  });

  it("routes multi-part answers via 'header: answer' lines", async () => {
    const manager = getGlobalQuestionManager();
    const questions: AgentHarnessUserInputQuestion[] = [
      { id: "q1", header: "Env", question: "Which env?", isOther: true },
      { id: "q2", header: "When", question: "When?", isOther: true },
    ];
    const { wait } = manager.register({ sessionKey: "s1", questions });
    await handleAnswerCommand(
      makeParams({ body: "/answer Env: prod\nWhen: tonight", sessionKey: "s1" }),
      true,
    );
    await expect(wait).resolves.toEqual({
      q1: { text: "prod" },
      q2: { text: "tonight" },
    });
  });

  it("replies when there is no pending question for the session", async () => {
    const result = await handleAnswerCommand(
      makeParams({ body: "/answer 1", sessionKey: "s-none" }),
      true,
    );
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "No pending question to answer." },
    });
  });

  it("only resolves questions for the matching session", async () => {
    const manager = getGlobalQuestionManager();
    const other = manager.register({ sessionKey: "other", questions: SINGLE });
    const result = await handleAnswerCommand(
      makeParams({ body: "/answer 1", sessionKey: "s1" }),
      true,
    );
    expect(result?.reply?.text).toBe("No pending question to answer.");
    expect(manager.getSnapshot(other.record.id)?.status).toBe("pending");
  });

  it("shows usage when no answer text is provided", async () => {
    const manager = getGlobalQuestionManager();
    manager.register({ sessionKey: "s1", questions: SINGLE });
    const result = await handleAnswerCommand(
      makeParams({ body: "/answer", sessionKey: "s1" }),
      true,
    );
    expect(result?.reply?.text).toContain("Usage: /answer");
  });

  it("ignores the command when text commands are disabled or sender is unauthorized", async () => {
    const manager = getGlobalQuestionManager();
    const { record } = manager.register({ sessionKey: "s1", questions: SINGLE });
    expect(
      await handleAnswerCommand(makeParams({ body: "/answer 1", sessionKey: "s1" }), false),
    ).toBeNull();
    const unauth = await handleAnswerCommand(
      makeParams({ body: "/answer 1", sessionKey: "s1", authorized: false }),
      true,
    );
    expect(unauth).toEqual({ shouldContinue: false });
    expect(manager.getSnapshot(record.id)?.status).toBe("pending");
  });
});

describe("resolvePendingQuestionFromAnswerCommand (native option-button path)", () => {
  afterEach(() => {
    resetGlobalQuestionManagerForTest();
  });

  it("resolves a parked question with the chosen numbered option", async () => {
    const manager = getGlobalQuestionManager();
    const { record, wait } = manager.register({ sessionKey: "s1", questions: SINGLE });
    const outcome = resolvePendingQuestionFromAnswerCommand({
      sessionKey: "s1",
      command: "/answer 2",
      resolvedBy: "slack:U123",
    });
    expect(outcome.status).toBe("resolved");
    await expect(wait).resolves.toEqual({ q1: { text: "No" } });
    const snapshot = manager.getSnapshot(record.id);
    expect(snapshot?.status).toBe("resolved");
    expect(snapshot?.resolvedBy).toBe("slack:U123");
  });

  it("returns not-answer-command for a non-/answer callback value", () => {
    const manager = getGlobalQuestionManager();
    manager.register({ sessionKey: "s1", questions: SINGLE });
    expect(
      resolvePendingQuestionFromAnswerCommand({ sessionKey: "s1", command: "codex" }).status,
    ).toBe("not-answer-command");
  });

  it("leaves a bare /answer (free-text Other) pending as needs-input", () => {
    const manager = getGlobalQuestionManager();
    const { record } = manager.register({ sessionKey: "s1", questions: SINGLE });
    expect(
      resolvePendingQuestionFromAnswerCommand({ sessionKey: "s1", command: "/answer" }).status,
    ).toBe("needs-input");
    expect(manager.getSnapshot(record.id)?.status).toBe("pending");
  });

  it("returns no-pending when the session has no matching question", () => {
    const manager = getGlobalQuestionManager();
    const other = manager.register({ sessionKey: "other", questions: SINGLE });
    expect(
      resolvePendingQuestionFromAnswerCommand({ sessionKey: "s1", command: "/answer 1" }).status,
    ).toBe("no-pending");
    expect(manager.getSnapshot(other.record.id)?.status).toBe("pending");
  });
});
