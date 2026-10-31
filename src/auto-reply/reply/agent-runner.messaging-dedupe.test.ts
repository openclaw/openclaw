import { describe, expect, it, vi } from "vitest";
import {
  runEmbeddedAgentMock,
  setupAgentRunnerTestHooks,
} from "./agent-runner.misc.runreplyagent.test-support.js";
import { createBaseRun } from "./agent-runner.runreplyagent.test-support.js";

await vi.hoisted(async () => {
  await import("./agent-runner.misc.runreplyagent.test-support.js");
});
await import("./agent-runner-run.js");
setupAgentRunnerTestHooks();

function channelRun(provider: string, to: string) {
  return createBaseRun({
    context: { Provider: provider, OriginatingTo: to, AccountId: "primary", MessageSid: "msg" },
    run: { messageProvider: provider, thinkLevel: "low" },
  });
}

describe("runReplyAgent messaging tool dedupe", () => {
  it.each([
    {
      state: undefined,
      routed: true,
      outcome: "deduped",
      text: "hello world!",
      sourceReplyFinal: undefined,
    },
    {
      state: "missing",
      routed: true,
      outcome: "missing",
      text: "hello world!",
      sourceReplyFinal: undefined,
    },
    {
      state: undefined,
      routed: false,
      outcome: "missing",
      text: "hello world!",
      sourceReplyFinal: undefined,
    },
    { state: undefined, routed: true, outcome: "deduped", text: "Done", sourceReplyFinal: false },
    { state: "missing", routed: true, outcome: "missing", text: "Done", sourceReplyFinal: false },
    { state: undefined, routed: false, outcome: "reply", text: "Done", sourceReplyFinal: false },
    { state: undefined, routed: true, outcome: "deduped", text: "✅", sourceReplyFinal: false },
    {
      state: undefined,
      routed: true,
      outcome: "deduped",
      text: "hello world!",
      sourceReplyFinal: false,
    },
  ] as const)(
    "requires current-source evidence before suppressing a deduplicated final: $state/$routed/$text/$sourceReplyFinal",
    async ({ state, routed, outcome, text, sourceReplyFinal }) => {
      runEmbeddedAgentMock.mockResolvedValueOnce({
        payloads: [{ text }],
        sourceReplyDeliveryState: state,
        messagingToolSentTexts: [text],
        messagingToolSentTargets: routed
          ? [{ tool: "slack", provider: "slack", to: "channel:C1", text, sourceReplyFinal }]
          : undefined,
        meta: {},
      });
      const result = await channelRun("slack", "channel:C1").run();
      if (outcome === "deduped") {
        expect(result).toBeUndefined();
      } else if (outcome === "reply") {
        expect(result).toMatchObject({ text });
        expect(result).not.toHaveProperty("isError", true);
      } else {
        expect(result).toMatchObject({ isError: true, text: expect.any(String) });
      }
    },
  );
});
