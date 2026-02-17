import "./isolated-agent.mocks.js";
import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStore,
} from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

function createCliDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    sendMessageWhatsApp: vi.fn(),
    sendMessageTelegram: vi.fn(),
    sendMessageDiscord: vi.fn(),
    sendMessageSignal: vi.fn(),
    sendMessageIMessage: vi.fn(),
    ...overrides,
  };
}

function mockAgentPayloads(
  payloads: Array<Record<string, unknown>>,
  extra: Partial<Awaited<ReturnType<typeof runEmbeddedPiAgent>>> = {},
): void {
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
    payloads,
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
    ...extra,
  });
}

async function runTelegramAnnounceTurn(params: {
  home: string;
  storePath: string;
  deps: CliDeps;
  delivery: {
    mode: "announce";
    channel: string;
    to?: string;
    bestEffort?: boolean;
  };
}): Promise<Awaited<ReturnType<typeof runCronIsolatedAgentTurn>>> {
  return runCronIsolatedAgentTurn({
    cfg: makeCfg(params.home, params.storePath, {
      channels: { telegram: { botToken: "t-1" } },
    }),
    deps: params.deps,
    job: {
      ...makeJob({ kind: "agentTurn", message: "do it" }),
      delivery: params.delivery,
    },
    message: "do it",
    sessionKey: "cron:job-1",
    lane: "cron",
  });
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

async function expectExplicitTelegramTargetDelivery(params: {
  payloads: Array<Record<string, unknown>>;
  expectedText: string;
}): Promise<void> {
  await withTempCronHome(async (home) => {
    const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
    const deps = createCliDeps();
    mockAgentPayloads(params.payloads);
    const res = await runTelegramAnnounceTurn({
      home,
      storePath,
      deps,
      delivery: { mode: "announce", channel: "telegram", to: "123" },
    });

    expect(res.status).toBe("ok");
    expect(res.delivered).toBe(true);
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(deps.sendMessageTelegram).toHaveBeenCalledTimes(1);
    const [to, text] = vi.mocked(deps.sendMessageTelegram).mock.calls[0] ?? [];
    expect(to).toBe("123");
    expect(text).toBe(params.expectedText);
  });
}

describe("runCronIsolatedAgentTurn", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks();
  });

  it("delivers directly when delivery has an explicit target", async () => {
    await expectExplicitTelegramTargetDelivery({
      payloads: [{ text: "hello from cron" }],
      expectedText: "hello from cron",
    });
  });

  it("delivers the final payload text when delivery has an explicit target", async () => {
    await expectExplicitTelegramTargetDelivery({
      payloads: [{ text: "Working on it..." }, { text: "Final weather summary" }],
      expectedText: "Final weather summary",
    });
  });

  it("passes resolved threadId into shared subagent announce flow", async () => {
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
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      const announceArgs = vi.mocked(runSubagentAnnounceFlow).mock.calls[0]?.[0] as
        | { requesterOrigin?: { threadId?: string | number; channel?: string; to?: string } }
        | undefined;
      expect(announceArgs?.requesterOrigin?.channel).toBe("telegram");
      expect(announceArgs?.requesterOrigin?.to).toBe("123");
      expect(announceArgs?.requesterOrigin?.threadId).toBe(42);
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

      const res = await runTelegramAnnounceTurn({
        home,
        storePath,
        deps,
        delivery: { mode: "announce", channel: "telegram", to: "123" },
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
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

  it("fails when direct delivery fails and best-effort is disabled", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps({
        sendMessageTelegram: vi.fn().mockRejectedValue(new Error("boom")),
      });
      mockAgentPayloads([{ text: "hello from cron" }]);
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

  it("ignores direct delivery failures when best-effort is enabled", async () => {
    await expectBestEffortTelegramNotDelivered({ text: "hello from cron" });
  });
});
