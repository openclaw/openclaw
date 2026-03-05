import "./isolated-agent.mocks.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import type { CliDeps } from "../cli/deps.js";
import {
  createCliDeps,
  expectDirectTelegramDelivery,
  mockAgentPayloads,
  runTelegramAnnounceTurn,
} from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import { makeCfg, makeJob, writeSessionStore } from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

type HomeEnvSnapshot = {
  HOME: string | undefined;
  USERPROFILE: string | undefined;
  HOMEDRIVE: string | undefined;
  HOMEPATH: string | undefined;
  OPENCLAW_HOME: string | undefined;
  OPENCLAW_STATE_DIR: string | undefined;
};

const TELEGRAM_TARGET = { mode: "announce", channel: "telegram", to: "123" } as const;
let suiteTempHomeRoot = "";
let suiteTempHomeCaseId = 0;

function snapshotHomeEnv(): HomeEnvSnapshot {
  return {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    OPENCLAW_HOME: process.env.OPENCLAW_HOME,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
  };
}

function restoreHomeEnv(snapshot: HomeEnvSnapshot) {
  const restoreValue = (key: keyof HomeEnvSnapshot) => {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };
  restoreValue("HOME");
  restoreValue("USERPROFILE");
  restoreValue("HOMEDRIVE");
  restoreValue("HOMEPATH");
  restoreValue("OPENCLAW_HOME");
  restoreValue("OPENCLAW_STATE_DIR");
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = path.join(suiteTempHomeRoot, `case-${suiteTempHomeCaseId++}`);
  await fs.mkdir(path.join(home, ".openclaw", "agents", "main", "sessions"), { recursive: true });
  const snapshot = snapshotHomeEnv();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");
  if (process.platform === "win32") {
    const parsed = path.parse(home);
    if (parsed.root) {
      process.env.HOMEDRIVE = parsed.root.replace(/[\\/]+$/, "");
      process.env.HOMEPATH = home.slice(process.env.HOMEDRIVE.length) || "\\";
    }
  }
  try {
    return await fn(home);
  } finally {
    restoreHomeEnv(snapshot);
  }
}

async function runExplicitTelegramAnnounceTurn(params: {
  home: string;
  storePath: string;
  deps: CliDeps;
}): Promise<Awaited<ReturnType<typeof runCronIsolatedAgentTurn>>> {
  return runTelegramAnnounceTurn({
    ...params,
    delivery: TELEGRAM_TARGET,
  });
}

async function withTelegramAnnounceFixture(
  run: (params: { home: string; storePath: string; deps: CliDeps }) => Promise<void>,
  params?: {
    deps?: Partial<CliDeps>;
    sessionStore?: { lastProvider?: string; lastTo?: string };
  },
): Promise<void> {
  await withTempHome(async (home) => {
    const storePath = await writeSessionStore(home, {
      lastProvider: params?.sessionStore?.lastProvider ?? "webchat",
      lastTo: params?.sessionStore?.lastTo ?? "",
    });
    const deps = createCliDeps(params?.deps);
    await run({ home, storePath, deps });
  });
}

function expectDeliveredOk(result: Awaited<ReturnType<typeof runCronIsolatedAgentTurn>>): void {
  expect(result.status).toBe("ok");
  expect(result.delivered).toBe(true);
}

async function expectBestEffortTelegramNotDelivered(
  payload: Record<string, unknown>,
): Promise<void> {
  await expectStructuredTelegramFailure({
    payload,
    bestEffort: true,
    expectedStatus: "ok",
    expectDeliveryAttempted: true,
  });
}

async function expectStructuredTelegramFailure(params: {
  payload: Record<string, unknown>;
  bestEffort: boolean;
  expectedStatus: "ok" | "error";
  expectedErrorFragment?: string;
  expectDeliveryAttempted?: boolean;
}): Promise<void> {
  await withTelegramAnnounceFixture(
    async ({ home, storePath, deps }) => {
      mockAgentPayloads([params.payload]);
      const res = await runTelegramAnnounceTurn({
        home,
        storePath,
        deps,
        delivery: {
          ...TELEGRAM_TARGET,
          ...(params.bestEffort ? { bestEffort: true } : {}),
        },
      });

      expect(res.status).toBe(params.expectedStatus);
      if (params.expectedStatus === "ok") {
        expect(res.delivered).toBe(false);
      }
      if (params.expectDeliveryAttempted !== undefined) {
        expect(res.deliveryAttempted).toBe(params.expectDeliveryAttempted);
      }
      if (params.expectedErrorFragment) {
        expect(res.error).toContain(params.expectedErrorFragment);
      }
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expect(deps.sendMessageTelegram).toHaveBeenCalledTimes(1);
    },
    {
      deps: {
        sendMessageTelegram: vi.fn().mockRejectedValue(new Error("boom")),
      },
    },
  );
}

async function runAnnounceFlowResult(bestEffort: boolean) {
  let outcome:
    | {
        res: Awaited<ReturnType<typeof runCronIsolatedAgentTurn>>;
        deps: CliDeps;
      }
    | undefined;
  await withTelegramAnnounceFixture(async ({ home, storePath, deps }) => {
    mockAgentPayloads([{ text: "hello from cron" }]);
    vi.mocked(runSubagentAnnounceFlow).mockResolvedValueOnce(false);
    const res = await runTelegramAnnounceTurn({
      home,
      storePath,
      deps,
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "123",
        bestEffort,
      },
    });
    outcome = { res, deps };
  });
  if (!outcome) {
    throw new Error("announce flow did not produce an outcome");
  }
  return outcome;
}

async function assertExplicitTelegramTargetAnnounce(params: {
  home: string;
  storePath: string;
  deps: CliDeps;
  payloads: Array<Record<string, unknown>>;
  expectedText: string;
}): Promise<void> {
  mockAgentPayloads(params.payloads);
  const res = await runExplicitTelegramAnnounceTurn({
    home: params.home,
    storePath: params.storePath,
    deps: params.deps,
  });

  expectDeliveredOk(res);
  expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  const announceArgs = vi.mocked(runSubagentAnnounceFlow).mock.calls[0]?.[0] as
    | {
        requesterOrigin?: { channel?: string; to?: string };
        roundOneReply?: string;
        bestEffortDeliver?: boolean;
      }
    | undefined;
  expect(announceArgs?.requesterOrigin?.channel).toBe("telegram");
  expect(announceArgs?.requesterOrigin?.to).toBe("123");
  expect(announceArgs?.roundOneReply).toBe(params.expectedText);
  expect(announceArgs?.bestEffortDeliver).toBe(false);
  expect((announceArgs as { expectsCompletionMessage?: boolean })?.expectsCompletionMessage).toBe(
    true,
  );
  expect(params.deps.sendMessageTelegram).not.toHaveBeenCalled();
}

describe("runCronIsolatedAgentTurn", () => {
  beforeAll(async () => {
    suiteTempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-delivery-suite-"));
  });

  afterAll(async () => {
    if (!suiteTempHomeRoot) {
      return;
    }
    await fs.rm(suiteTempHomeRoot, { recursive: true, force: true });
    suiteTempHomeRoot = "";
    suiteTempHomeCaseId = 0;
  });

  beforeEach(() => {
    setupIsolatedAgentTurnMocks();
  });

  it("announces explicit targets with direct and final-payload text", async () => {
    await withTelegramAnnounceFixture(async ({ home, storePath, deps }) => {
      await assertExplicitTelegramTargetAnnounce({
        home,
        storePath,
        deps,
        payloads: [{ text: "hello from cron" }],
        expectedText: "hello from cron",
      });
      vi.clearAllMocks();
      await assertExplicitTelegramTargetAnnounce({
        home,
        storePath,
        deps,
        payloads: [{ text: "Working on it..." }, { text: "Final weather summary" }],
        expectedText: "Final weather summary",
      });
    });
  });

  it("routes announce injection to the delivery-target session key", async () => {
    await withTelegramAnnounceFixture(async ({ home, storePath, deps }) => {
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
    await withTempHome(async (home) => {
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
      expectDirectTelegramDelivery(deps, {
        chatId: "123",
        text: "Final weather summary",
        messageThreadId: 42,
      });
    });
  });

  it("skips announce when messaging tool already sent to target", async () => {
    await withTelegramAnnounceFixture(async ({ home, storePath, deps }) => {
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
    await withTelegramAnnounceFixture(async ({ home, storePath, deps }) => {
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
    await expectStructuredTelegramFailure({
      payload: { text: "hello from cron", mediaUrl: "https://example.com/img.png" },
      bestEffort: false,
      expectedStatus: "error",
      expectedErrorFragment: "boom",
    });
  });

  it("falls back to direct delivery when announce reports false and best-effort is disabled", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "hello from cron" }]);
      vi.mocked(runSubagentAnnounceFlow).mockResolvedValueOnce(false);

      const res = await runTelegramAnnounceTurn({
        home,
        storePath,
        deps,
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "123",
          bestEffort: false,
        },
      });

      // When announce delivery fails, the direct-delivery fallback fires
      // so the message still reaches the target channel.
      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(res.deliveryAttempted).toBe(true);
      expect(deps.sendMessageTelegram).toHaveBeenCalledTimes(1);
    });
  });

  it("falls back to direct delivery when announce reports false and best-effort is enabled", async () => {
    const { res, deps } = await runAnnounceFlowResult(true);
    expect(res.status).toBe("ok");
    expect(res.delivered).toBe(true);
    expect(res.deliveryAttempted).toBe(true);
    expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expect(deps.sendMessageTelegram).toHaveBeenCalledTimes(1);
  });

  it("falls back to direct delivery when announce flow throws and best-effort is disabled", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "hello from cron" }]);
      vi.mocked(runSubagentAnnounceFlow).mockRejectedValueOnce(
        new Error("gateway closed (1008): pairing required"),
      );

      const res = await runTelegramAnnounceTurn({
        home,
        storePath,
        deps,
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "123",
          bestEffort: false,
        },
      });

      // When announce throws (e.g. "pairing required"), the direct-delivery
      // fallback fires so the message still reaches the target channel.
      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(res.deliveryAttempted).toBe(true);
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
