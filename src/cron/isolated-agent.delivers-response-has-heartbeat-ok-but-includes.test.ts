import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import type { CliDeps } from "../cli/deps.js";
import { callGateway } from "../gateway/call.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import { makeCfg, makeJob, writeSessionStore } from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-cron-heartbeat-suite-" });
}

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

  it("does not fan out telegram cron delivery across allowFrom entries", async () => {
    await withTempHome(async (home) => {
      const { storePath, deps } = await createTelegramDeliveryFixture(home);
      mockEmbeddedAgentPayloads([
        { text: "HEARTBEAT_OK", mediaUrl: "https://example.com/img.png" },
      ]);

      const cfg = makeCfg(home, storePath, {
        channels: {
          telegram: {
            botToken: "tok",
            allowFrom: ["111", "222", "333"],
          },
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job: {
          ...makeJob({
            kind: "agentTurn",
            message: "deliver once",
          }),
          delivery: { mode: "announce", channel: "telegram", to: "123" },
        },
        message: "deliver once",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(deps.sendMessageTelegram).toHaveBeenCalledTimes(1);
      expect(deps.sendMessageTelegram).toHaveBeenCalledWith(
        "123",
        "HEARTBEAT_OK",
        expect.objectContaining({ accountId: undefined }),
      );
    });
  });

  it("suppresses announce delivery for multi-payload narration ending in HEARTBEAT_OK", async () => {
    await withTempHome(async (home) => {
      const { storePath, deps } = await createTelegramDeliveryFixture(home);
      mockEmbeddedAgentPayloads([
        { text: "Checked inbox and calendar. Nothing actionable yet." },
        { text: "HEARTBEAT_OK" },
      ]);

      const res = await runTelegramAnnounceTurn({
        home,
        storePath,
        deps,
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(false);
      expect(deps.sendMessageTelegram).not.toHaveBeenCalled();
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    });
  });

  it("delivers media payloads even when heartbeat text is suppressed", async () => {
    await withTempHome(async (home) => {
      const { storePath, deps } = await createTelegramDeliveryFixture(home);

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
    });
  });

  it("keeps non-empty heartbeat text when last-target ack suppression is disabled", async () => {
    await withTempHome(async (home) => {
      const { storePath, deps } = await createTelegramDeliveryFixture(home);

      vi.mocked(runSubagentAnnounceFlow).mockClear();
      vi.mocked(deps.sendMessageTelegram as (...args: unknown[]) => unknown).mockClear();
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
      expect(keepRes.delivered).toBe(true);
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expect(deps.sendMessageTelegram).toHaveBeenCalledTimes(1);
      expect(deps.sendMessageTelegram).toHaveBeenCalledWith(
        "123",
        "HEARTBEAT_OK 🦞",
        expect.objectContaining({ accountId: undefined }),
      );
    });
  });

  it("deletes the direct cron session after last-target text delivery", async () => {
    await withTempHome(async (home) => {
      const { storePath, deps } = await createTelegramDeliveryFixture(home);

      mockEmbeddedAgentPayloads([{ text: "HEARTBEAT_OK 🦞" }]);

      const cfg = makeCfg(home, storePath);
      cfg.agents = {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          heartbeat: { ackMaxChars: 0 },
        },
      };

      vi.mocked(deps.sendMessageTelegram as (...args: unknown[]) => unknown).mockClear();
      vi.mocked(runSubagentAnnounceFlow).mockClear();
      vi.mocked(callGateway).mockClear();

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
      expect(deleteRes.delivered).toBe(true);
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expect(deps.sendMessageTelegram).toHaveBeenCalledTimes(1);
      expect(deps.sendMessageTelegram).toHaveBeenCalledWith(
        "123",
        "HEARTBEAT_OK 🦞",
        expect.objectContaining({ accountId: undefined }),
      );
      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(callGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "sessions.delete",
          params: expect.objectContaining({
            key: "agent:main:cron:job-1",
            deleteTranscript: true,
            emitLifecycleHooks: false,
          }),
        }),
      );
    });
  });

  it("skips structured outbound delivery when timeout abort is already set", async () => {
    await withTempHome(async (home) => {
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
      expect(res.error).toMatch(/timed out|timeout/i);
      expect(deps.sendMessageTelegram).not.toHaveBeenCalled();
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    });
  });
});
