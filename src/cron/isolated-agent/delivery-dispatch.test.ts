import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { CliOutboundSendSource } from "../../cli/outbound-send-mapping.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { CronJob } from "../types.js";
import { dispatchCronDelivery } from "./delivery-dispatch.js";
import type { DeliveryTargetResolution } from "./delivery-target.js";

vi.mock("../../agents/subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(),
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  countActiveDescendantRuns: vi.fn(() => 0),
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn(),
}));

vi.mock("../../infra/outbound/outbound-session.js", () => ({
  resolveOutboundSessionRoute: vi.fn(async () => ({ sessionKey: "agent:main:main" })),
}));

vi.mock("./subagent-followup.js", () => ({
  expectsSubagentFollowup: vi.fn(() => false),
  isLikelyInterimCronMessage: vi.fn(() => false),
  readDescendantSubagentFallbackReply: vi.fn(async () => undefined),
  waitForDescendantSubagentSummary: vi.fn(async () => undefined),
}));

const { runSubagentAnnounceFlow } = await import("../../agents/subagent-announce.js");
const { deliverOutboundPayloads } = await import("../../infra/outbound/deliver.js");

function createDeps(): CliDeps {
  return {
    sendMessageWhatsApp: vi.fn() as CliOutboundSendSource["sendMessageWhatsApp"],
    sendMessageTelegram: vi.fn() as CliOutboundSendSource["sendMessageTelegram"],
    sendMessageDiscord: vi.fn() as CliOutboundSendSource["sendMessageDiscord"],
    sendMessageSlack: vi.fn() as CliOutboundSendSource["sendMessageSlack"],
    sendMessageSignal: vi.fn() as CliOutboundSendSource["sendMessageSignal"],
    sendMessageIMessage: vi.fn() as CliOutboundSendSource["sendMessageIMessage"],
  };
}

function createJob(): CronJob {
  return {
    id: "job-1",
    name: "job",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "run" },
    state: {},
  };
}

function createResolvedDelivery(ok = true): DeliveryTargetResolution {
  if (!ok) {
    return {
      ok: false,
      channel: "telegram",
      to: "123",
      mode: "explicit",
      error: new Error("target unavailable"),
    };
  }
  return {
    ok: true,
    channel: "telegram",
    to: "123",
    mode: "explicit",
  };
}

function createParams(overrides?: Partial<Parameters<typeof dispatchCronDelivery>[0]>) {
  const basePayloads: ReplyPayload[] = [{ text: "hello" }];
  return {
    cfg: {} as OpenClawConfig,
    cfgWithAgentDefaults: {} as OpenClawConfig,
    deps: createDeps(),
    job: createJob(),
    agentId: "main",
    agentSessionKey: "agent:main:main",
    runSessionId: "run-1",
    runStartedAt: Date.now(),
    runEndedAt: Date.now(),
    timeoutMs: 10_000,
    resolvedDelivery: createResolvedDelivery(true),
    deliveryRequested: true,
    skipHeartbeatDelivery: false,
    skipMessagingToolDelivery: false,
    deliveryBestEffort: false,
    deliveryPayloadHasStructuredContent: false,
    deliveryPayloads: basePayloads,
    synthesizedText: "hello",
    summary: "hello",
    outputText: "hello",
    telemetry: {},
    abortSignal: undefined,
    isAborted: () => false,
    abortReason: () => "aborted",
    withRunSession: (result) => ({
      ...result,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
    }),
    ...overrides,
  } satisfies Parameters<typeof dispatchCronDelivery>[0];
}

describe("dispatchCronDelivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runSubagentAnnounceFlow).mockResolvedValue(true);
    vi.mocked(deliverOutboundPayloads).mockResolvedValue([
      { ok: true, provider: "telegram" },
    ] as never);
  });

  it("returns ok + reason target-resolution-failed-best-effort when target resolution fails under best-effort", async () => {
    const state = await dispatchCronDelivery(
      createParams({
        resolvedDelivery: createResolvedDelivery(false),
        deliveryBestEffort: true,
      }),
    );

    expect(state.result?.status).toBe("ok");
    expect(state.delivered).toBe(false);
    expect(state.deliveryOutcomeReason).toBe("target-resolution-failed-best-effort");
    expect(state.result?.deliveryOutcomeReason).toBe("target-resolution-failed-best-effort");
  });

  it("returns heartbeat-only reason when delivery is skipped for heartbeat output", async () => {
    const state = await dispatchCronDelivery(
      createParams({
        skipHeartbeatDelivery: true,
      }),
    );

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(false);
    expect(state.deliveryOutcomeReason).toBe("heartbeat-only");
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("marks messaging-tool-delivered when tool already sent to target", async () => {
    const state = await dispatchCronDelivery(
      createParams({
        skipMessagingToolDelivery: true,
      }),
    );

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(state.deliveryOutcomeReason).toBe("messaging-tool-delivered");
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("returns announce-failed reason when announce send fails under best-effort", async () => {
    vi.mocked(runSubagentAnnounceFlow).mockResolvedValue(false);

    const state = await dispatchCronDelivery(
      createParams({
        deliveryBestEffort: true,
      }),
    );

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(false);
    expect(state.deliveryOutcomeReason).toBe("announce-failed");
  });
});
