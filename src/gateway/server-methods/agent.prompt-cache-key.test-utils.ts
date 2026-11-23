// Imported by agent.test.ts to keep its mocked suite in one Vitest module graph.
import { afterEach, describe, it, vi } from "vitest";
import {
  describe0AfterEach0,
  expectRecordFields,
  invokeAgent,
  primeMainAgentRun,
  waitForAgentCommandCall,
} from "./agent.test-harness.js";

describe("gateway agent handler", () => {
  afterEach(describe0AfterEach0);

  it("passes a caller's explicit prompt cache key to the agent run", async () => {
    primeMainAgentRun();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "run the background job",
        agentId: "main",
        sessionKey: "agent:main:main",
        promptCacheKey: "background-review",
        idempotencyKey: "idem-prompt-cache-key",
      },
      { respond, reqId: "idem-prompt-cache-key" },
    );

    expectRecordFields(await waitForAgentCommandCall(), {
      promptCacheKey: "background-review",
    });
  });
});
