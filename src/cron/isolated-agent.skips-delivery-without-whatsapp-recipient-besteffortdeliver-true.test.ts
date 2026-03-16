import "./isolated-agent.mocks.js";
import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as modelSelection from "../agents/model-selection.js";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import type { CliDeps } from "../cli/deps.js";
import {
  createCliDeps,
  expectDirectTelegramDelivery,
  mockAgentPayloads,
  runTelegramAnnounceTurn,
} from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome as withTempHome,
  writeSessionStore,
} from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

const TELEGRAM_TARGET = { mode: "announce", channel: "telegram", to: "123" } as const;
async function runExplicitTelegramAnnounceTurn(params: {
  home: string;
  storePath: string;
  deps: CliDeps;
  deliveryContract?: "cron-owned" | "shared";
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

      expectFailedTelegramDeliveryResult({
        res,
        deps,
        expectedStatus: params.expectedStatus,
        expectedErrorFragment: params.expectedErrorFragment,
        expectDeliveryAttempted: params.expectDeliveryAttempted,
      });
    },
    {
      deps: {
        sendMessageTelegram: vi.fn().mockRejectedValue(new Error("boom")),
      },
    },
  );
}

function expectFailedTelegramDeliveryResult(params: {
  res: Awaited<ReturnType<typeof runCronIsolatedAgentTurn>>;
  deps: CliDeps;
  expectedStatus: "ok" | "error";
  expectedErrorFragment?: string;
  expectDeliveryAttempted?: boolean;
}) {
  expect(params.res.status).toBe(params.expectedStatus);
  if (params.expectedStatus === "ok") {
    expect(params.res.delivered).toBe(false);
  } else {
    expect(params.res.delivered).toBeUndefined();
  }
  if (params.expectDeliveryAttempted !== undefined) {
    expect(params.res.deliveryAttempted).toBe(params.expectDeliveryAttempted);
  }
  if (params.expectedErrorFragment) {
    expect(params.res.error).toContain(params.expectedErrorFragment);
  }
  expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
  expect(params.deps.sendMessageTelegram).toHaveBeenCalledTimes(1);
}

async function runTelegramDeliveryResult(bestEffort: boolean) {
  let outcome:
    | {
        res: Awaited<ReturnType<typeof runCronIsolatedAgentTurn>>;
        deps: CliDeps;
      }
    | undefined;
  await withTelegramTextDelivery({ bestEffort }, async ({ res, deps }) => {
    outcome = { res, deps };
  });
  if (!outcome) {
    throw new Error("telegram delivery did not produce an outcome");
  }
  return outcome;
}

function expectSuccessfulTelegramTextDelivery(params: {
  res: Awaited<ReturnType<typeof runCronIsolatedAgentTurn>>;
  deps: CliDeps;
}): void {
  expect(params.res.status).toBe("ok");
  expect(params.res.delivered).toBe(true);
  expect(params.res.deliveryAttempted).toBe(true);
  expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
}

async function withTelegramTextDelivery(
  params: { bestEffort: boolean },
  run: (params: {
    home: string;
    storePath: string;
    deps: CliDeps;
    res: Awaited<ReturnType<typeof runCronIsolatedAgentTurn>>;
  }) => Promise<void>,
  fixtureParams?: Parameters<typeof withTelegramAnnounceFixture>[1],
) {
  await withTelegramAnnounceFixture(async ({ home, storePath, deps }) => {
    mockAgentPayloads([{ text: "hello from cron" }]);
    const res = await runTelegramAnnounceTurn({
      home,
      storePath,
      deps,
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "123",
        bestEffort: params.bestEffort,
      },
    });
    await run({ home, storePath, deps, res });
  }, fixtureParams);
}

async function expectTelegramTextDeliveryFailure(params: {
  bestEffort: boolean;
  expectedStatus: "ok" | "error";
  expectedErrorFragment?: string;
}) {
  await withTelegramTextDelivery(
    { bestEffort: params.bestEffort },
    async ({ deps, res }) => {
      expectFailedTelegramDeliveryResult({
        res,
        deps,
        expectedStatus: params.expectedStatus,
        expectedErrorFragment: params.expectedErrorFragment,
        expectDeliveryAttempted: true,
      });
    },
    {
      deps: {
        sendMessageTelegram: vi.fn().mockRejectedValue(new Error("boom")),
      },
    },
  );
}

async function runSignalDeliveryResult(bestEffort: boolean) {
  let outcome:
    | {
        res: Awaited<ReturnType<typeof runCronIsolatedAgentTurn>>;
        deps: CliDeps;
      }
    | undefined;
  await withTempHome(async (home) => {
    const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
    const deps = createCliDeps();
    mockAgentPayloads([{ text: "hello from cron" }]);
    const res = await runCronIsolatedAgentTurn({
      cfg: makeCfg(home, storePath, {
        channels: { signal: {} },
      }),
      deps,
      job: {
        ...makeJob({ kind: "agentTurn", message: "do it" }),
        delivery: {
          mode: "announce",
          channel: "signal",
          to: "+15551234567",
          bestEffort,
        },
      },
      message: "do it",
      sessionKey: "cron:job-1",
      lane: "cron",
    });
    outcome = { res, deps };
  });
  if (!outcome) {
    throw new Error("signal delivery did not produce an outcome");
  }
  return outcome;
}

async function assertExplicitTelegramTargetDelivery(params: {
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
  expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
  expectDirectTelegramDelivery(params.deps, {
    chatId: "123",
    text: params.expectedText,
  });
}

describe("runCronIsolatedAgentTurn", () => {
  beforeEach(() => {
    vi.spyOn(modelSelection, "resolveThinkingDefault").mockReturnValue(undefined);
    setupIsolatedAgentTurnMocks();
  });

  it("delivers explicit targets with direct text", async () => {
    await withTelegramAnnounceFixture(async ({ home, storePath, deps }) => {
      await assertExplicitTelegramTargetDelivery({
        home,
        storePath,
        deps,
        payloads: [{ text: "hello from cron" }],
        expectedText: "hello from cron",
      });
    });
  });

  it("delivers explicit targets with final-payload text", async () => {
    await withTelegramAnnounceFixture(async ({ home, storePath, deps }) => {
      await assertExplicitTelegramTargetDelivery({
        home,
        storePath,
        deps,
        payloads: [{ text: "Working on it..." }, { text: "Final weather summary" }],
        expectedText: "Final weather summary",
      });
    });
  });

  it("delivers explicit targets directly with per-channel-peer session scoping", async () => {
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

      expectDeliveredOk(res);
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expectDirectTelegramDelivery(deps, {
        chatId: "123",
        text: "hello from cron",
      });
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
        deliveryContract: "shared",
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

  it("reports not-delivered when text direct delivery fails and best-effort is enabled", async () => {
    await expectTelegramTextDeliveryFailure({
      bestEffort: true,
      expectedStatus: "ok",
    });
  });

  it("delivers text directly when best-effort is disabled", async () => {
    const { res, deps } = await runTelegramDeliveryResult(false);
    expectSuccessfulTelegramTextDelivery({ res, deps });
    expectDirectTelegramDelivery(deps, {
      chatId: "123",
      text: "hello from cron",
    });
  });

  it("returns error when text direct delivery fails and best-effort is disabled", async () => {
    await expectTelegramTextDeliveryFailure({
      bestEffort: false,
      expectedStatus: "error",
      expectedErrorFragment: "boom",
    });
  });

  it("retries transient text direct delivery failures before succeeding", async () => {
    const previousFastMode = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_TEST_FAST = "1";
    try {
      await withTelegramTextDelivery(
        { bestEffort: false },
        async ({ deps, res }) => {
          expectSuccessfulTelegramTextDelivery({ res, deps });
          expect(deps.sendMessageTelegram).toHaveBeenCalledTimes(2);
          expect(deps.sendMessageTelegram).toHaveBeenLastCalledWith(
            "123",
            "hello from cron",
            expect.objectContaining({ cfg: expect.any(Object) }),
          );
        },
        {
          deps: {
            sendMessageTelegram: vi
              .fn()
              .mockRejectedValueOnce(new Error("UNAVAILABLE: temporary network error"))
              .mockResolvedValue({ messageId: 7, chatId: "123", text: "hello from cron" }),
          },
        },
      );
    } finally {
      if (previousFastMode === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previousFastMode;
      }
    }
  });

  it("delivers text directly when best-effort is enabled", async () => {
    const { res, deps } = await runTelegramDeliveryResult(true);
    expectSuccessfulTelegramTextDelivery({ res, deps });
    expectDirectTelegramDelivery(deps, {
      chatId: "123",
      text: "hello from cron",
    });
  });

  it("delivers text directly for signal when best-effort is enabled", async () => {
    const { res, deps } = await runSignalDeliveryResult(true);
    expect(res.status).toBe("ok");
    expect(res.delivered).toBe(true);
    expect(res.deliveryAttempted).toBe(true);
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(deps.sendMessageSignal).toHaveBeenCalledTimes(1);
    expect(deps.sendMessageSignal).toHaveBeenCalledWith(
      "+15551234567",
      "hello from cron",
      expect.any(Object),
    );
  });

  it("ignores structured direct delivery failures when best-effort is enabled", async () => {
    await expectBestEffortTelegramNotDelivered({
      text: "hello from cron",
      mediaUrl: "https://example.com/img.png",
    });
  });
});
