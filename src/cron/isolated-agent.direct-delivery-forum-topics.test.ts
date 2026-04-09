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

  it("routes forum-topic telegram targets through the correct delivery path", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "forum message" }]);

      const res = await runTelegramAnnounceTurn({
        home,
        storePath,
        deps,
        delivery: { mode: "announce", channel: "telegram", to: "123:topic:42" },
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expectDirectTelegramDelivery(deps, {
        chatId: "123",
        text: "forum message",
        messageThreadId: 42,
      });
    });
  });

  it("delivers all successful text chunks to forum-topic telegram targets", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([
        { text: "section 1" },
        { text: "temporary error", isError: true },
        { text: "section 2" },
      ]);

      const res = await runTelegramAnnounceTurn({
        home,
        storePath,
        deps,
        delivery: { mode: "announce", channel: "telegram", to: "123:topic:42" },
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expect(deps.sendMessageTelegram).toHaveBeenCalledTimes(2);
      expect(deps.sendMessageTelegram).toHaveBeenNthCalledWith(
        1,
        "123",
        "section 1",
        expect.objectContaining({ messageThreadId: 42 }),
      );
      expect(deps.sendMessageTelegram).toHaveBeenNthCalledWith(
        2,
        "123",
        "section 2",
        expect.objectContaining({ messageThreadId: 42 }),
      );
    });
  });

  it("routes plain telegram targets through the correct delivery path", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "plain message" }]);

      const plainRes = await runTelegramAnnounceTurn({
        home,
        storePath,
        deps,
        delivery: { mode: "announce", channel: "telegram", to: "123" },
      });

      expect(plainRes.status).toBe("ok");
      expect(plainRes.delivered).toBe(true);
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expectDirectTelegramDelivery(deps, {
        chatId: "123",
        text: "plain message",
      });
    });
  });
});
