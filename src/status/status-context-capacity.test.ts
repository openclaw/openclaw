import { describe, expect, it } from "vitest";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions/types.js";
import { buildStatusMessageParts, statusModelRefs } from "./status-message.test-support.js";

describe("fixed-contract status prompt capacity", () => {
  it.each([
    { name: "reported 200K prompt", window: 1_000_000, prompt: 200_000, label: "200k" },
    { name: "reported 64K prompt", window: 1_000_000, prompt: 64_000, label: "64k" },
    { name: "bare materialized window", window: 128_000, prompt: undefined, label: "1.0m" },
  ])("renders $name through the actual status owner", ({ window, prompt, label }) => {
    const provider = "anthropic";
    const model = "claude-opus-5";
    const parts = buildStatusMessageParts({
      modelRefs: statusModelRefs({ provider, model }),
      agent: { model: `${provider}/${model}` },
      resolvedHarness: "openclaw",
      thinkingCatalog: [{ provider, id: model, contextWindow: window, contextTokens: prompt }],
      sessionEntry: {
        sessionId: "fixed-prompt-status",
        updatedAt: 0,
        totalTokens: 11,
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      },
    });
    expect(parts.text).toContain(`Context: 11/${label}`);
    const table = parts.presentation.blocks.find((block) => block.type === "table");
    if (table?.type !== "table") {
      throw new Error("Expected status presentation table");
    }
    expect(table.rows.find((row) => row[0] === "📚 Context")?.[1]).toContain(`11/${label}`);
  });
});
