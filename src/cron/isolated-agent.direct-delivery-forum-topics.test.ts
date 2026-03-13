import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it } from "vitest";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import {
  createCliDeps,
  expectDirectTelegramDelivery,
  mockAgentPayloads,
  runTelegramAnnounceTurn,
} from "./isolated-agent.delivery.test-helpers.js";
import { withTempCronHome, writeSessionStore } from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

describe("runCronIsolatedAgentTurn forum topic delivery", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks();
  });

  it.each([
    {
      label: "forum-topic targets",
      text: "forum message",
      to: "123:topic:42",
      expected: { chatId: "123", text: "forum message", messageThreadId: 42 },
    },
    {
      label: "plain telegram targets",
      text: "plain message",
      to: "123",
      expected: { chatId: "123", text: "plain message" },
    },
  ])("routes $label through the direct telegram delivery path", async ({ text, to, expected }) => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text }]);

      const res = await runTelegramAnnounceTurn({
        home,
        storePath,
        deps,
        delivery: { mode: "announce", channel: "telegram", to },
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expectDirectTelegramDelivery(deps, expected);
    });
  });
});
