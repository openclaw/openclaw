import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import {
  createCliDeps,
  mockAgentPayloads,
  runTelegramAnnounceTurn,
} from "./isolated-agent.delivery.test-helpers.js";
import { resolveCronPayloadOutcome } from "./isolated-agent/helpers.js";
import { withTempCronHome, writeSessionStore } from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

describe("Telegram topic announce regression", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks();
  });

  it("preserves the full successful delivery payload sequence", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        { text: "part 1" },
        { text: "part 2" },
        { text: "ignored error", isError: true },
        { text: "part 3" },
      ],
    });

    expect(result.summary).toBe("part 3");
    expect(result.outputText).toBe("part 3");
    expect(result.deliveryPayloads).toEqual([
      { text: "part 1" },
      { text: "part 2" },
      { text: "part 3" },
    ]);
  });

  it("delivers every text payload chunk to Telegram forum topics", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "chunk 1" }, { text: "chunk 2" }, { text: "chunk 3" }]);

      const res = await runTelegramAnnounceTurn({
        home,
        storePath,
        deps,
        delivery: { mode: "announce", channel: "telegram", to: "123:topic:42" },
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      const sendMessageTelegramCalls = vi.mocked(
        deps.sendMessageTelegram as (...args: unknown[]) => unknown,
      ).mock.calls;
      expect(sendMessageTelegramCalls).toEqual([
        ["123", "chunk 1", expect.objectContaining({ messageThreadId: 42 })],
        ["123", "chunk 2", expect.objectContaining({ messageThreadId: 42 })],
        ["123", "chunk 3", expect.objectContaining({ messageThreadId: 42 })],
      ]);
    });
  });
});
