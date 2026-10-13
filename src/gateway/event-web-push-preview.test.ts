import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { QuestionRecord } from "../../packages/gateway-protocol/src/schema/questions.js";
import { projectChatDisplayMessage } from "./chat-display-projection.core.js";
import {
  resolveWebPushAnswerPreview,
  resolveWebPushQuestionPreview,
} from "./event-web-push-preview.js";

const sessionKey = "agent:main:review";
const answerEvent = (message: unknown) => ({
  state: "final",
  sessionKey,
  runId: "run-42",
  message,
});
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

describe("Web Push content projection", () => {
  it("selects visible final-answer text and strips reasoning, progress, links and controls", () => {
    const preview = resolveWebPushAnswerPreview(
      answerEvent({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          {
            type: "text",
            text: "Intermediate progress",
            textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
          },
          {
            type: "text",
            text: "**Ready** to [review](https://example.test/private). NO_REPLY",
            textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
          },
        ],
      }),
      [sessionKey],
      {},
    );
    expect(preview).toEqual({
      version: 1,
      kind: "answer",
      sessionKey,
      runId: "run-42",
      text: "Ready to review.",
    });
  });

  it("uses the event's display content, never hidden source content", () => {
    expect(
      resolveWebPushAnswerPreview(
        answerEvent({
          ...assistant("hidden source"),
          openclawDisplayContent: [{ type: "text", text: "Visible answer" }],
        }),
        [sessionKey],
        {},
      ),
    ).toMatchObject({ text: "Visible answer" });
  });

  it.each([
    undefined,
    { ...assistant("private"), role: "toolResult" },
    { ...assistant("private"), stopReason: "error" },
    { ...assistant("private"), stopReason: "aborted" },
    { ...assistant("private"), provider: "openclaw", model: "gateway-injected" },
    { ...assistant("private"), openclawMessageToolMirror: {} },
    { role: "assistant", content: [{ type: "thinking", thinking: "private" }] },
    { role: "assistant", content: [{ type: "toolCall", name: "exec", arguments: "private" }] },
    assistant("NO_REPLY"),
  ])("omits non-answer preview content: %j", (message) => {
    expect(resolveWebPushAnswerPreview(answerEvent(message), [sessionKey], {})).toBeUndefined();
  });

  it.each([[], ["agent:main:other"], [sessionKey, "agent:main:other"]].map((keys) => ({ keys })))(
    "requires one matching authoritative route: $keys",
    ({ keys }) => {
      expect(
        resolveWebPushAnswerPreview(answerEvent(assistant("Answer")), keys, {}),
      ).toBeUndefined();
    },
  );

  it("redacts complete text before any history projection cap can remove pattern delimiters", () => {
    const secret = `private-start${"synthetic-private ".repeat(600)}private-end`;
    const preview = resolveWebPushAnswerPreview(
      answerEvent(assistant(`${secret} Safe summary.`)),
      [sessionKey],
      {
        logging: { redactPatterns: ["private-start[\\s\\S]*private-end"] },
      },
    );
    expect(preview?.kind).toBe("answer");
    expect(JSON.stringify(preview)).not.toContain("synthetic-private");
    expect(JSON.stringify(preview)).toContain("Safe summary.");
  });

  it("keeps already-truncated terminal display messages generic", () => {
    // Terminal producers can project before broadcasting, removing a redaction
    // delimiter long before the push owner sees the message.
    const projected = projectChatDisplayMessage(
      assistant(`private-start${"synthetic-private ".repeat(600)}private-end`),
    );
    expect(projected).toMatchObject({ __openclaw: { truncated: true } });
    expect(
      resolveWebPushAnswerPreview(answerEvent(projected), [sessionKey], {
        logging: { redactPatterns: ["private-start[\\s\\S]*private-end"] },
      }),
    ).toBeUndefined();
  });

  it("omits oversized selected answers instead of letting the history cap bypass the input bound", () => {
    expect(
      resolveWebPushAnswerPreview(
        answerEvent(assistant("x".repeat(64 * 1024 + 1))),
        [sessionKey],
        {},
      ),
    ).toBeUndefined();
  });

  it("redacts before clipping and keeps whole Unicode graphemes inside 240 UTF-16 units", () => {
    const text = `${"a".repeat(237)}e\u0301🦞end`;
    expect(
      resolveWebPushAnswerPreview(answerEvent(assistant(text)), [sessionKey], {}),
    ).toMatchObject({
      text: `${"a".repeat(237)}e\u0301…`,
    });
    const redacted = resolveWebPushAnswerPreview(
      answerEvent(assistant("Do not show confidential-value here")),
      [sessionKey],
      { logging: { redactPatterns: ["confidential-value"] } },
    );
    expect(JSON.stringify(redacted)).not.toContain("confidential-value");
    expect(redacted?.kind).toBe("answer");
  });
});

const questionRecord = (): QuestionRecord => ({
  id: "request:42",
  sessionKey,
  runId: "run-42",
  createdAtMs: 100,
  expiresAtMs: 60_100,
  status: "pending",
  questions: [
    {
      questionId: "choice",
      header: "Review",
      question: "Ship the draft?",
      options: [{ label: "Yes" }, { label: "No" }],
    },
  ],
});

describe("simple question push snapshots", () => {
  it("keeps canonical IDs, exact choices and explicit free-text eligibility", () => {
    const record = questionRecord();
    expect(resolveWebPushQuestionPreview(record, {})).toEqual({
      version: 1,
      kind: "question",
      requestId: "request:42",
      sessionKey,
      runId: "run-42",
      expiresAtMs: 60_100,
      question: {
        id: "choice",
        text: "Ship the draft?",
        choices: ["Yes", "No"],
        allowTextReply: false,
      },
    });
    expectDefined(record.questions[0], "expected the fixture question").isOther = true;
    expect(resolveWebPushQuestionPreview(record, {})).toMatchObject({
      question: { allowTextReply: true },
    });
    expectDefined(record.questions[0], "expected the fixture question").isOther = false;
    expectDefined(record.questions[0], "expected the fixture question").options = [];
    expect(resolveWebPushQuestionPreview(record, {})).toMatchObject({
      question: { allowTextReply: true },
    });
  });

  it.each([
    { isSecret: true },
    { secretStore: { name: "EXAMPLE_TOKEN", kind: "secret" as const } },
    { presentation: "form" as const },
    { resource: { selection: "explicit" as const } },
    { multiSelect: true },
    { answerFormat: "lines" as const },
    { allowEmpty: true },
    { defaultAnswers: ["Yes"] },
    { url: "https://example.test" },
    { question: "Long question ".repeat(30) },
    { options: [{ label: "**Yes**" }] },
    { options: [{ label: "Yes", value: "different" }] },
    { options: [{ label: "Yes", description: "Additional conditions apply" }] },
    { options: [{ label: "Yes", thumbnail: "private-image" }] },
    { options: [{ label: "Yes", resourceUri: "private-resource" }] },
    { options: [{ label: "Yes\u202E" }] },
    { options: [{ label: "x".repeat(81) }] },
    { options: [{ label: "Yes" }, { label: "Yes" }] },
    { options: ["One", "Two", "Three", "Four"].map((label) => ({ label })) },
  ])("leaves complex, private or changed-label questions in the app: %j", (changes) => {
    const record = questionRecord();
    Object.assign(expectDefined(record.questions[0], "expected the fixture question"), changes);
    expect(resolveWebPushQuestionPreview(record, {})).toBeUndefined();
  });

  it("falls back for multi-question requests and redacted choices", () => {
    const record = questionRecord();
    expect(
      resolveWebPushQuestionPreview(record, { logging: { redactPatterns: ["Yes"] } }),
    ).toBeUndefined();
    record.questions.push({
      ...expectDefined(record.questions[0], "expected the fixture question"),
      questionId: "second",
    });
    expect(resolveWebPushQuestionPreview(record, {})).toBeUndefined();
  });
});
