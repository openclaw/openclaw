import { describe, expect, it, vi } from "vitest";
import {
  runCliAgentMock,
  runEmbeddedAgentMock,
  setupAgentRunnerTestHooks,
} from "./agent-runner.misc.runreplyagent.test-support.js";
import { createBaseRun } from "./agent-runner.runreplyagent.test-support.js";

await vi.hoisted(async () => {
  await import("./agent-runner.misc.runreplyagent.test-support.js");
});

await import("./agent-runner-run.js");

setupAgentRunnerTestHooks();

describe("runReplyAgent automatic thinking normalization", () => {
  it.each(["embedded", "cli"] as const)(
    "keeps %s clamp diagnostics out of ordinary channel replies",
    async (runtime) => {
      const runner = runtime === "cli" ? runCliAgentMock : runEmbeddedAgentMock;
      runner.mockResolvedValueOnce({
        payloads: [{ text: "The answer" }],
        meta: { requestShaping: { thinking: "medium" } },
      });
      const base = createBaseRun({
        context: { Provider: "telegram", OriginatingTo: "-100123:topic:42", MessageSid: "123" },
        run: {
          provider: runtime === "cli" ? "claude-cli" : "anthropic",
          model: runtime === "cli" ? "opus-4.5" : "claude",
          messageProvider: "telegram",
          thinkLevel: "adaptive",
        },
      });

      const result = await base.run();

      expect(runner).toHaveBeenCalledOnce();
      const payloads = Array.isArray(result) ? result : result ? [result] : [];
      expect(payloads.map((payload) => payload.text)).toEqual(["The answer"]);
      expect(base.followupRun.run.thinkLevel).toBe("adaptive");
    },
  );
});
