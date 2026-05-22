import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "../types.js";

const initializeSession = vi.fn();
const runTurn = vi.fn();
const closeSession = vi.fn();

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    initializeSession,
    runTurn,
    closeSession,
  }),
}));

vi.mock("./run-delivery.runtime.js", () => ({
  resolveDeliveryTarget: vi.fn(async () => ({
    ok: false,
    channel: undefined,
    to: undefined,
    accountId: undefined,
    threadId: undefined,
    mode: "implicit" as const,
    error: new Error("delivery is disabled"),
  })),
  dispatchCronDelivery: vi.fn(async (params) => ({
    result: params.withRunSession({
      status: "ok",
      summary: params.summary,
      outputText: params.outputText,
      delivered: false,
      deliveryAttempted: false,
    }),
    delivered: false,
    deliveryAttempted: false,
    deliveryPayloads: params.deliveryPayloads,
  })),
  resolveCronDeliveryBestEffort: () => false,
}));

import { runCronAcpTurn } from "./run-acp.js";

function makeAcpCronJob(overrides?: Partial<CronJob>): CronJob {
  return {
    id: "job-acp-1",
    name: "ACP nightly",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "acpTurn",
      message: "Summarize open issues",
    },
    ...overrides,
  };
}

describe("runCronAcpTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initializeSession.mockResolvedValue({
      runtime: {},
      handle: {},
      meta: { agent: "cursor" },
    });
    runTurn.mockImplementation(async (params) => {
      await params.onEvent?.({ type: "text_delta", stream: "output", text: "done from acp" });
    });
    closeSession.mockResolvedValue({
      runtimeClosed: true,
      metaCleared: true,
    });
  });

  it("runs an oneshot ACP turn and returns output text", async () => {
    const cfg = {
      acp: { enabled: true, defaultAgent: "cursor" },
      agents: {
        list: [
          {
            id: "cursor",
            runtime: { type: "acp", acp: { agent: "cursor" } },
          },
        ],
      },
    } as const;

    const result = await runCronAcpTurn({
      cfg,
      deps: {} as never,
      job: makeAcpCronJob({ agentId: "cursor" }),
      message: "Summarize open issues",
      sessionKey: "cron:job-acp-1",
    });

    expect(result.status).toBe("ok");
    expect(result.outputText).toBe("done from acp");
    expect(initializeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "cursor",
        mode: "oneshot",
      }),
    );
    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "prompt",
        text: expect.stringContaining("Summarize open issues"),
      }),
    );
    expect(closeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "cron-acp-turn-complete",
        discardPersistentState: true,
      }),
    );
  });

  it("skips when ACP is disabled by policy", async () => {
    const result = await runCronAcpTurn({
      cfg: { acp: { enabled: false } } as never,
      deps: {} as never,
      job: makeAcpCronJob(),
      message: "noop",
      sessionKey: "cron:job-acp-1",
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("acp.enabled=false");
    expect(initializeSession).not.toHaveBeenCalled();
  });
});
