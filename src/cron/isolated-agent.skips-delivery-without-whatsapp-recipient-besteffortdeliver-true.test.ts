import "./isolated-agent.mocks.js";
import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import type { CliDeps } from "../cli/deps.js";
import {
  createCliDeps,
  mockAgentPayloads,
  runTelegramAnnounceTurn,
} from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStore,
} from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

async function runExplicitTelegramAnnounceTurn(params: {
  home: string;
  storePath: string;
  deps: CliDeps;
}): Promise<Awaited<ReturnType<typeof runCronIsolatedAgentTurn>>> {
  return runTelegramAnnounceTurn({
    ...params,
    delivery: { mode: "announce", channel: "telegram", to: "123" },
  });
}

function expectDeliveredOk(result: Awaited<ReturnType<typeof runCronIsolatedAgentTurn>>): void {
  expect(result.status).toBe("ok");
  expect(result.delivered).toBe(true);
}

async function expectBestEffortTelegramNotDelivered(
  payload: Record<string, unknown>,
): Promise<void> {
  await withTempCronHome(async (home) => {
    const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
    const deps = createCliDeps({
      sendMessageTelegram: vi.fn().mockRejectedValue(new Error("boom")),
    });
    mockAgentPayloads([payload]);
    const res = await runTelegramAnnounceTurn({
      home,
      storePath,
      deps,
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "123",
        bestEffort: true,
      },
    });

    expect(res.status).toBe("ok");
    expect(res.delivered).toBe(false);
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(deps.sendMessageTelegram).toHaveBeenCalledTimes(1);
  });
}

async function expectExplicitTelegramTargetAnnounce(params: {
  payloads: Array<Record<string, unknown>>;
  expectedText: string;
}): Promise<void> {
  await withTempCronHome(async (home) => {
    const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
    const deps = createCliDeps();
    mockAgentPayloads(params.payloads);
    const res = await runExplicitTelegramAnnounceTurn({
      home,
      storePath,
      deps,
    });

    expectDeliveredOk(res);
    expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    const announceArgs = vi.mocked(runSubagentAnnounceFlow).mock.calls[0]?.[0] as
      | {
          requesterOrigin?: { channel?: string; to?: string };
          roundOneReply?: string;
        }
      | undefined;
    expect(announceArgs?.requesterOrigin?.channel).toBe("telegram");
    expect(announceArgs?.requesterOrigin?.to).toBe("123");
    expect(announceArgs?.roundOneReply).toBe(params.expectedText);
    expect(deps.sendMessageTelegram).not.toHaveBeenCalled();
  });
}

describe("runCronIsolatedAgentTurn", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks();
  });

  it("routes text-only explicit target delivery through announce flow", async () => {
    await expectExplicitTelegramTargetAnnounce({
      payloads: [{ text: "hello from cron" }],
      expectedText: "hello from cron",
    });
  });

  it("announces the final payload text when delivery has an explicit target", async () => {
    await expectExplicitTelegramTargetAnnounce({
      payloads: [{ text: "Working on it..." }, { text: "Final weather summary" }],
      expectedText: "Final weather summary",
    });
  });

  it("routes announce injection to the delivery-target session key", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "hello from cron" }]);

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath, {
          session: {
            store: storePath,
            mainKey: "main",
            dmScope: "per-channel-peer",
          },
          channels: {
            telegram: { botToken: "t-1" },
          },
        }),
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "do it" }),
          delivery: { mode: "announce", channel: "telegram", to: "123" },
        },
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      const announceArgs = vi.mocked(runSubagentAnnounceFlow).mock.calls[0]?.[0] as
        | {
            requesterSessionKey?: string;
            requesterOrigin?: { channel?: string; to?: string };
          }
        | undefined;
      expect(announceArgs?.requesterSessionKey).toBe("agent:main:telegram:direct:123");
      expect(announceArgs?.requesterOrigin?.channel).toBe("telegram");
      expect(announceArgs?.requesterOrigin?.to).toBe("123");
    });
  });

  it("routes threaded announce targets through direct delivery", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            "agent:main:main": {
              sessionId: "main-session",
              updatedAt: Date.now(),
              lastChannel: "telegram",
              lastTo: "123",
              lastThreadId: 42,
            },
          },
          null,
          2,
        ),
        "utf-8",
      );
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "Final weather summary" }]);
      const res = await runTelegramAnnounceTurn({
        home,
        storePath,
        deps,
        delivery: { mode: "announce", channel: "last" },
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expect(deps.sendMessageTelegram).toHaveBeenCalledTimes(1);
      expect(deps.sendMessageTelegram).toHaveBeenCalledWith(
        "123",
        "Final weather summary",
        expect.objectContaining({
          messageThreadId: 42,
        }),
      );
    });
  });

  it("skips announce when messaging tool already sent to target", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "sent" }], {
        didSendViaMessagingTool: true,
        messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "123" }],
      });

      const res = await runExplicitTelegramAnnounceTurn({
        home,
        storePath,
        deps,
      });

      expectDeliveredOk(res);
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expect(deps.sendMessageTelegram).not.toHaveBeenCalled();
    });
  });

  it("reports not-delivered when best-effort structured outbound sends all fail", async () => {
    await expectBestEffortTelegramNotDelivered({
      text: "caption",
      mediaUrl: "https://example.com/img.png",
    });
  });

  it("skips announce for heartbeat-only output", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "HEARTBEAT_OK" }]);
      const res = await runTelegramAnnounceTurn({
        home,
        storePath,
        deps,
        delivery: { mode: "announce", channel: "telegram", to: "123" },
      });

      expect(res.status).toBe("ok");
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expect(deps.sendMessageTelegram).not.toHaveBeenCalled();
    });
  });

  it("fails when structured direct delivery fails and best-effort is disabled", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps({
        sendMessageTelegram: vi.fn().mockRejectedValue(new Error("boom")),
      });
      mockAgentPayloads([{ text: "hello from cron", mediaUrl: "https://example.com/img.png" }]);
      const res = await runTelegramAnnounceTurn({
        home,
        storePath,
        deps,
        delivery: { mode: "announce", channel: "telegram", to: "123" },
      });

      expect(res.status).toBe("error");
      expect(res.error).toContain("boom");
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expect(deps.sendMessageTelegram).toHaveBeenCalledTimes(1);
    });
  });

  it("ignores structured direct delivery failures when best-effort is enabled", async () => {
    await expectBestEffortTelegramNotDelivered({
      text: "hello from cron",
      mediaUrl: "https://example.com/img.png",
    });
  });
});
