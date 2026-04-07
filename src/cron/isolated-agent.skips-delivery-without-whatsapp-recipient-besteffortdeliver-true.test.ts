import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as modelSelection from "../agents/model-selection.js";
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
  withTempCronHome as withTempHome,
  writeSessionStore,
} from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

vi.mock("../agents/auth-profiles/session-override.js", () => ({
  resolveSessionAuthProfileOverride: vi.fn(async () => undefined),
}));

const TELEGRAM_TARGET = { mode: "announce", channel: "telegram", to: "123" } as const;

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

describe("runCronIsolatedAgentTurn", () => {
  beforeEach(() => {
    vi.spyOn(modelSelection, "resolveThinkingDefault").mockReturnValue("off");
    setupIsolatedAgentTurnMocks({ fast: true });
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
