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

describe("runCronIsolatedAgentTurn", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks({ fast: true });
  });

  it("handles media heartbeat delivery and announce cleanup modes", async () => {
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

      // Media should still be delivered even if text is just HEARTBEAT_OK.
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "HEARTBEAT_OK", mediaUrl: "https://example.com/img.png" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const mediaRes = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: {
          ...makeJob({
            kind: "agentTurn",
            message: "do it",
          }),
          delivery: { mode: "announce", channel: "telegram", to: "123" },
        },
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(mediaRes.status).toBe("ok");
      expect(deps.sendMessageTelegram).toHaveBeenCalled();
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();

      vi.mocked(runSubagentAnnounceFlow).mockClear();
      vi.mocked(deps.sendMessageTelegram).mockClear();
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "HEARTBEAT_OK 🦞" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const cfg = makeCfg(home, storePath);
      cfg.agents = {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          heartbeat: { ackMaxChars: 0 },
        },
      };

      const keepRes = await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job: {
          ...makeJob({
            kind: "agentTurn",
            message: "do it",
          }),
          delivery: { mode: "announce", channel: "last" },
        },
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(keepRes.status).toBe("ok");
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      const keepArgs = vi.mocked(runSubagentAnnounceFlow).mock.calls[0]?.[0] as
        | { cleanup?: "keep" | "delete" }
        | undefined;
      expect(keepArgs?.cleanup).toBe("keep");
      expect(deps.sendMessageTelegram).not.toHaveBeenCalled();

      vi.mocked(runSubagentAnnounceFlow).mockClear();

      const deleteRes = await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job: {
          ...makeJob({
            kind: "agentTurn",
            message: "do it",
          }),
          deleteAfterRun: true,
          delivery: { mode: "announce", channel: "last" },
        },
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(deleteRes.status).toBe("ok");
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      const deleteArgs = vi.mocked(runSubagentAnnounceFlow).mock.calls[0]?.[0] as
        | { cleanup?: "keep" | "delete" }
        | undefined;
      expect(deleteArgs?.cleanup).toBe("delete");
      expect(deps.sendMessageTelegram).not.toHaveBeenCalled();
    });
  });
});
