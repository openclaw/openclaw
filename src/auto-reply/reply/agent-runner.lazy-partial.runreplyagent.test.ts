import { describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { PartialReplyPayload } from "../get-reply-options.types.js";
import {
  runEmbeddedAgentMock,
  setupAgentRunnerTestHooks,
} from "./agent-runner.misc.runreplyagent.test-support.js";
import { createBaseRun } from "./agent-runner.runreplyagent.test-support.js";

const sanitizerState = vi.hoisted(() => ({
  sanitizeUserFacingText: vi.fn(),
}));

vi.mock("../../agents/embedded-agent-helpers/sanitize-user-facing-text.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../agents/embedded-agent-helpers/sanitize-user-facing-text.js")
  >("../../agents/embedded-agent-helpers/sanitize-user-facing-text.js");
  sanitizerState.sanitizeUserFacingText.mockImplementation(actual.sanitizeUserFacingText);
  return {
    ...actual,
    sanitizeUserFacingText: (...args: Parameters<typeof actual.sanitizeUserFacingText>) =>
      sanitizerState.sanitizeUserFacingText(...args),
  };
});

await vi.hoisted(async () => {
  await import("./agent-runner.misc.runreplyagent.test-support.js");
});

await import("./agent-runner-run.js");

setupAgentRunnerTestHooks();

describe("runReplyAgent lazy partial text", () => {
  it("bounds sanitization across many visible deltas after the first nonempty partial", async () => {
    let partialSanitizes: number | undefined;
    runEmbeddedAgentMock.mockImplementationOnce(async (params: RunEmbeddedAgentParams) => {
      const before = sanitizerState.sanitizeUserFacingText.mock.calls.length;
      await params.onPartialReply?.({ text: "not visible" });
      await params.onPartialReply?.({ text: "[tool calls omitted]" });
      let text = "first";
      for (let index = 0; index < 256; index++) {
        await params.onPartialReply?.({ text });
        text += "\n[docs](https://example.com)";
      }
      partialSanitizes = sanitizerState.sanitizeUserFacingText.mock.calls.length - before;
      return {
        payloads: [{ text }],
        meta: { agentMeta: { usage: { input: 1, output: 1 } } },
      };
    });
    // Visibility alone does not prove that a sanitized partial has content.
    const onPartialReply = vi.fn(async () => true).mockResolvedValueOnce(false);

    const { run } = createBaseRun({ reply: { opts: { onPartialReply } } });
    await run();

    expect(onPartialReply).toHaveBeenCalledTimes(258);
    expect(partialSanitizes).toBe(2);
  });

  it.each([
    [
      "<final>Hello &am",
      "p; [docs](https://example.com)</final>",
      "Hello &amp; [docs](https://example.com)",
    ],
    [
      "<final>Hello [do",
      "cs](https://example.com) &amp;</final>",
      "Hello [docs](https://example.com) &amp;",
    ],
    [
      "<fi",
      "nal>Hello &amp; [docs](https://example.com)</final>",
      "Hello &amp; [docs](https://example.com)",
    ],
  ])("preserves full sanitization when markup spans deltas: %s", async (first, tail, expected) => {
    let preview: PartialReplyPayload | undefined;
    const text = first + tail;
    runEmbeddedAgentMock.mockImplementationOnce(async (params: RunEmbeddedAgentParams) => {
      await params.onPartialReply?.({ text: first });
      await params.onPartialReply?.({ text });
      return { payloads: [{ text }], meta: {} };
    });
    const { run } = createBaseRun({
      reply: {
        opts: {
          onPartialReply: (payload) => {
            preview = payload;
            return true;
          },
        },
      },
    });

    const result = await run();
    const { sanitizeUserFacingText } =
      await import("../../agents/embedded-agent-helpers/sanitize-user-facing-text.js");
    expect(preview?.text).toBe(sanitizeUserFacingText(text, { streaming: true }));
    expect(preview?.text).toBe(expected);
    expect(result).toMatchObject({ text: expected });
  });
});
