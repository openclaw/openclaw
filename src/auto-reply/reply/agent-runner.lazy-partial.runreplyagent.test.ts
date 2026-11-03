import { describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { PartialReplyPayload } from "../get-reply-options.types.js";
import {
  runEmbeddedAgentMock,
  setupAgentRunnerTestHooks,
} from "./agent-runner.misc.runreplyagent.test-support.js";
import { createBaseRun } from "./agent-runner.runreplyagent.test-support.js";

const sanitizeUserFacingText = vi.hoisted(() => vi.fn());

vi.mock(
  "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../agents/embedded-agent-helpers/sanitize-user-facing-text.js")
      >();
    sanitizeUserFacingText.mockImplementation(actual.sanitizeUserFacingText);
    return {
      ...actual,
      sanitizeUserFacingText,
    };
  },
);

await vi.hoisted(async () => {
  await import("./agent-runner.misc.runreplyagent.test-support.js");
});

await import("./agent-runner-run.js");

setupAgentRunnerTestHooks();

describe("runReplyAgent lazy partial text", () => {
  it("bounds sanitization across many visible deltas after the first nonempty partial", async () => {
    let partialSanitizes: number | undefined;
    runEmbeddedAgentMock.mockImplementationOnce(async (params: RunEmbeddedAgentParams) => {
      const before = sanitizeUserFacingText.mock.calls.length;
      await params.onPartialReply?.({ text: "not visible" });
      await params.onPartialReply?.({ text: "[tool calls omitted]" });
      let text = "first";
      for (let index = 0; index < 256; index++) {
        await params.onPartialReply?.({ text });
        text += "\n[docs](https://example.com)";
      }
      partialSanitizes = sanitizeUserFacingText.mock.calls.length - before;
      return { payloads: [{ text }], meta: { agentMeta: { usage: { input: 1, output: 1 } } } };
    });
    // Visibility alone does not prove that a sanitized partial has content.
    const onPartialReply = vi.fn(async () => true).mockResolvedValueOnce(false);

    const { run } = createBaseRun({ reply: { opts: { onPartialReply } } });
    await run();

    expect(onPartialReply).toHaveBeenCalledTimes(258);
    expect(partialSanitizes).toBe(2);
  });

  it.each([
    ["<final>&am", "p; [a](https://a.b)</final>", "&amp; [a](https://a.b)"],
    ["<final>[a", "](https://a.b) &amp;</final>", "[a](https://a.b) &amp;"],
    ["<fi", "nal>&amp; [a](https://a.b)</final>", "&amp; [a](https://a.b)"],
  ])("preserves full sanitization when markup spans deltas: %s", async (first, tail, expected) => {
    const onPartialReply = vi.fn((_payload: PartialReplyPayload) => true);
    const text = first + tail;
    runEmbeddedAgentMock.mockImplementationOnce(async (params: RunEmbeddedAgentParams) => {
      await params.onPartialReply?.({ text: first });
      await params.onPartialReply?.({ text });
      return { payloads: [{ text }], meta: {} };
    });
    const { run } = createBaseRun({ reply: { opts: { onPartialReply } } });

    const result = await run();
    expect(onPartialReply.mock.lastCall?.[0].text).toBe(expected);
    expect(result).toMatchObject({ text: expected });
  });
});
