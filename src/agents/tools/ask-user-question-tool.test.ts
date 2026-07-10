/**
 * Tests the ask_user_question tool: input validation, option normalization
 * (auto-appended "Other", count caps), promise parking, and answer return shape.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  getGlobalQuestionManager,
  resetGlobalQuestionManagerForTest,
} from "../../gateway/question-manager.js";
import { createAskUserQuestionTool } from "./ask-user-question-tool.js";
import { ToolInputError } from "./common.js";

function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = result.content.find((part) => part.type === "text")?.text ?? "{}";
  return JSON.parse(text);
}

describe("ask_user_question tool", () => {
  afterEach(() => {
    resetGlobalQuestionManagerForTest();
  });

  it("parks on a promise and returns answers once resolved from any surface", async () => {
    const tool = createAskUserQuestionTool({ agentChannel: "telegram", runSessionKey: "s1" });
    const pending = tool.execute("call-1", {
      questions: [
        {
          header: "Deploy",
          question: "Ship the release?",
          options: [{ label: "Yes (Recommended)" }, { label: "No" }],
        },
      ],
    });

    // The tool must not resolve until the question is answered.
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const manager = getGlobalQuestionManager();
    const [record] = manager.list();
    expect(record).toBeDefined();
    expect(record.turnSourceChannel).toBe("telegram");
    expect(record.sessionKey).toBe("s1");
    // Auto-appended free-form "Other".
    expect(record.questions[0].isOther).toBe(true);
    expect(record.questions[0].id).toBe("q1");
    expect(record.questions[0].options?.map((o) => o.label)).toEqual(["Yes (Recommended)", "No"]);

    manager.resolve(record.id, { q1: { text: "Yes (Recommended)" } }, "operator");
    const payload = parseResult(await pending) as {
      status: string;
      answers: Record<string, { text: string }>;
    };
    expect(payload.status).toBe("answered");
    expect(payload.answers).toEqual({ q1: { text: "Yes (Recommended)" } });
  });

  it("reports expired when the question resolves with no answer", async () => {
    const tool = createAskUserQuestionTool();
    const pending = tool.execute("call-2", {
      questions: [{ header: "Pick", question: "Which one?" }],
    });
    await Promise.resolve();
    const manager = getGlobalQuestionManager();
    const [record] = manager.list();
    manager.expire(record.id, "shutdown");
    const payload = parseResult(await pending) as { status: string; answers: unknown };
    expect(payload.status).toBe("expired");
    expect(payload.answers).toEqual({});
  });

  it("rejects unknown fields, header overflow, bad option counts, and multiSelect", async () => {
    const tool = createAskUserQuestionTool();
    await expect(
      tool.execute("c", { questions: [{ header: "x", question: "q" }], extra: 1 }),
    ).rejects.toBeInstanceOf(ToolInputError);
    await expect(
      tool.execute("c", { questions: [{ header: "way-too-long-header", question: "q" }] }),
    ).rejects.toThrow(/header must be <= 12/);
    await expect(
      tool.execute("c", {
        questions: [{ header: "H", question: "q", options: [{ label: "only-one" }] }],
      }),
    ).rejects.toThrow(/between 2 and 4/);
    await expect(
      tool.execute("c", {
        questions: [{ header: "H", question: "q", multiSelect: true }],
      }),
    ).rejects.toThrow(/multiSelect/);
    await expect(
      tool.execute("c", {
        questions: [
          { header: "a", question: "1" },
          { header: "b", question: "2" },
          { header: "c", question: "3" },
          { header: "d", question: "4" },
        ],
      }),
    ).rejects.toThrow(/at most 3/);
  });

  it("normalizes multiple questions with sequential ids and drops empty option descriptions", async () => {
    const tool = createAskUserQuestionTool();
    const pending = tool.execute("c", {
      questions: [
        {
          header: "One",
          question: "q1",
          options: [{ label: "a", description: "  " }, { label: "b" }],
        },
        { header: "Two", question: "q2" },
      ],
    });
    await Promise.resolve();
    const manager = getGlobalQuestionManager();
    const [record] = manager.list();
    expect(record.questions.map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(record.questions[0].options?.[0]).toEqual({ label: "a" });
    manager.resolve(record.id, { q1: { text: "a" }, q2: { text: "free" } });
    await pending;
  });
});
