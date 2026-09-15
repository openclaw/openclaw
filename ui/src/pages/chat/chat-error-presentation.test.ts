// @vitest-environment node
import { describe, expect, it } from "vitest";
import { hasTranscriptRunError, readTranscriptRunError } from "./chat-error-presentation.ts";

const summary = "Error: Request failed.\nTry again.";
function failure(runId = "run-1", diagnostic = summary) {
  return {
    role: "assistant",
    stopReason: "error",
    errorMessage: diagnostic,
    content: "⚠️ " + diagnostic,
    __openclaw: { id: "error-row", seq: 3, runId },
  };
}
describe("run error presentation ownership", () => {
  it("transfers only an exact run and normalized diagnostic, without changing messages", () => {
    const row = failure();
    const messages = [row];
    expect(
      hasTranscriptRunError(messages, { runId: "run-1", summary: "Request failed.  Try again." }),
    ).toBe(true);
    expect(messages).toEqual([failure()]);
  });
  it.each([
    ["another run", failure("run-2")],
    ["a different error in the same run", failure("run-1", "Error: Disk full.")],
    ["unowned history", { ...failure(), __openclaw: { id: "error-row", seq: 3 } }],
    ["unpersisted live text", { ...failure(), __openclaw: { runId: "run-1" } }],
    [
      "imported history",
      { ...failure(), __openclaw: { id: "error-row", runId: "run-1", importedFrom: "external" } },
    ],
    [
      "truncated history",
      { ...failure(), __openclaw: { id: "error-row", runId: "run-1", truncated: true } },
    ],
    ["ordinary assistant content", { ...failure(), stopReason: "stop" }],
    ["partial output", { ...failure(), content: "I completed the first step." }],
    [
      "media output",
      {
        ...failure(),
        content: [
          { type: "text", text: summary },
          { type: "image", url: "https://example.test/image.png" },
        ],
      },
    ],
  ])("keeps the composer diagnostic for %s", (_name, message) => {
    expect(hasTranscriptRunError([message], { runId: "run-1", summary })).toBe(false);
  });
  it("does not let an unowned composer failure borrow any transcript run", () => {
    expect(hasTranscriptRunError([failure()], { summary })).toBe(false);
  });
  it("handles history/reconnect/pagination from the supplied snapshot without global deduplication", () => {
    const error = { runId: "run-1", summary };
    expect(hasTranscriptRunError([], error)).toBe(false);
    expect(hasTranscriptRunError([failure("run-2"), failure()], error)).toBe(true);
    expect(hasTranscriptRunError(structuredClone([failure()]), error)).toBe(true);
    expect(hasTranscriptRunError([failure("run-2")], error)).toBe(false);
  });
  it("recognizes durable pre-reply failures and preserves safe diagnostic paths", () => {
    const diagnostic =
      "This turn did not run: File /workspace/example.txt failed.\npassword=synthetic-password";
    const row = {
      role: "custom",
      customType: "run-failed-before-reply",
      content: diagnostic,
      __openclaw: { id: "failure", seq: 1, runId: "run-1" },
    };
    expect(readTranscriptRunError(row)).toBe(
      "This turn did not run: File /workspace/example.txt failed.\npassword=[redacted]",
    );
    expect(
      hasTranscriptRunError([row], {
        runId: "run-1",
        summary: "File /workspace/example.txt failed.\npassword=[redacted]",
      }),
    ).toBe(true);
  });
});
