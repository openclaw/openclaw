import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import type { CliDeps } from "../cli/deps.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStore,
} from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

describe("runCronIsolatedAgentTurn – HEARTBEAT_OK summary suppression (#20941)", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks({ fast: true });
  });

  it("sets delivered=true when response is HEARTBEAT_OK so caller skips main-session summary", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, {
        lastProvider: "telegram",
        lastChannel: "telegram",
        lastTo: "123",
      });
      const deps: CliDeps = {
        sendMessageSlack: vi.fn(),
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };

      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "HEARTBEAT_OK" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: {
          ...makeJob({
            kind: "agentTurn",
            message: "check things",
          }),
          delivery: { mode: "announce", channel: "telegram", to: "123" },
        },
        message: "check things",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      // The key assertion: delivered must be true so the caller does NOT
      // inject "Cron: HEARTBEAT_OK" into the main session.
      expect(res.delivered).toBe(true);
      // Neither outbound delivery nor announce flow should have fired.
      expect(deps.sendMessageTelegram).not.toHaveBeenCalled();
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    });
  });

  it("still delivers when HEARTBEAT_OK includes media (structured content)", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, {
        lastProvider: "telegram",
        lastChannel: "telegram",
        lastTo: "123",
      });
      const deps: CliDeps = {
        sendMessageSlack: vi.fn(),
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn().mockResolvedValue({
          messageId: "t1",
          chatId: "123",
        }),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };

      // Media payload should bypass heartbeat suppression
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "HEARTBEAT_OK", mediaUrl: "https://example.com/img.png" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: {
          ...makeJob({
            kind: "agentTurn",
            message: "check things",
          }),
          delivery: { mode: "announce", channel: "telegram", to: "123" },
        },
        message: "check things",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      // Media should still be delivered even when text is HEARTBEAT_OK
      expect(deps.sendMessageTelegram).toHaveBeenCalled();
    });
  });
});
