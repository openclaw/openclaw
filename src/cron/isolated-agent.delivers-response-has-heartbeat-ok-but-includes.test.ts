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

async function createTelegramDeliveryFixture(home: string): Promise<{
  storePath: string;
  deps: CliDeps;
}> {
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
  return { storePath, deps };
}

function mockEmbeddedAgentPayloads(payloads: Array<{ text: string; mediaUrl?: string }>) {
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
    payloads,
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  });
}

async function runTelegramAnnounceTurn(params: {
  home: string;
  storePath: string;
  deps: CliDeps;
  cfg?: ReturnType<typeof makeCfg>;
  signal?: AbortSignal;
}) {
  return runCronIsolatedAgentTurn({
    cfg: params.cfg ?? makeCfg(params.home, params.storePath),
    deps: params.deps,
    job: {
      ...makeJob({
        kind: "agentTurn",
        message: "do it",
      }),
      delivery: { mode: "announce", channel: "telegram", to: "123" },
    },
    message: "do it",
    sessionKey: "cron:job-1",
    signal: params.signal,
    lane: "cron",
  });
}

describe("runCronIsolatedAgentTurn", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks({ fast: true });
  });

  it("handles media heartbeat delivery and announce cleanup modes", async () => {
    await withTempCronHome(async (home) => {
      const { storePath, deps } = await createTelegramDeliveryFixture(home);

      // Media should still be delivered even if text is just HEARTBEAT_OK.
      mockEmbeddedAgentPayloads([
        { text: "HEARTBEAT_OK", mediaUrl: "https://example.com/img.png" },
      ]);

      const mediaRes = await runTelegramAnnounceTurn({
        home,
        storePath,
        deps,
      });

      expect(mediaRes.status).toBe("ok");
      expect(deps.sendMessageTelegram).toHaveBeenCalled();
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();

      vi.mocked(runSubagentAnnounceFlow).mockClear();
      vi.mocked(deps.sendMessageTelegram).mockClear();
      mockEmbeddedAgentPayloads([{ text: "HEARTBEAT_OK 🦞" }]);

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

  it("skips structured outbound delivery when timeout abort is already set", async () => {
    await withTempCronHome(async (home) => {
      const { storePath, deps } = await createTelegramDeliveryFixture(home);
      const controller = new AbortController();
      controller.abort("cron: job execution timed out");

      mockEmbeddedAgentPayloads([
        { text: "HEARTBEAT_OK", mediaUrl: "https://example.com/img.png" },
      ]);

      const res = await runTelegramAnnounceTurn({
        home,
        storePath,
        deps,
        signal: controller.signal,
      });

      expect(res.status).toBe("error");
      expect(res.error).toContain("timed out");
      expect(deps.sendMessageTelegram).not.toHaveBeenCalled();
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    });
  });
});
