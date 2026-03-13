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

  async function expectTelegramAnnounceDelivery(params: {
    deliveryTarget: string;
    text: string;
    expectedThreadId?: number;
  }) {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: params.text }]);

      const res = await runTelegramAnnounceTurn({
        home,
        storePath,
        deps,
        delivery: { mode: "announce", channel: "telegram", to: params.deliveryTarget },
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expectDirectTelegramDelivery(deps, {
        chatId: "123",
        text: params.text,
        ...(params.expectedThreadId === undefined
          ? {}
          : { messageThreadId: params.expectedThreadId }),
      });
    });
  }

  it("routes forum-topic telegram targets through direct delivery with a topic id", async () => {
    await expectTelegramAnnounceDelivery({
      deliveryTarget: "123:topic:42",
      text: "forum message",
      expectedThreadId: 42,
    });
  });

  it("routes plain telegram targets through direct delivery without a topic id", async () => {
    await expectTelegramAnnounceDelivery({
      deliveryTarget: "123",
      text: "plain message",
    });
  });
});
