import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import type { CronDelivery } from "../types.js";
import type { DispatchCronDeliveryParams } from "./delivery-dispatch-types.js";
import type { DeliveryTargetResolution } from "./delivery-target.js";

type SuccessfulDeliveryResolution = Extract<DeliveryTargetResolution, { ok: true }>;

export function makeResolvedDelivery(
  overrides: Partial<SuccessfulDeliveryResolution> = {},
): SuccessfulDeliveryResolution {
  return {
    ok: true,
    channel: "telegram",
    to: "123456",
    accountId: undefined,
    threadId: undefined,
    mode: "explicit",
    ...overrides,
  };
}

export function makeBaseParams(overrides: {
  synthesizedText?: string;
  deliveryRequested?: boolean;
  runStartedAt?: number;
  sessionTarget?: string;
  deliveryBestEffort?: boolean;
  spawnOnlyHandoff?: boolean;
  runSessionKey?: string;
  resolvedDeliveryMode?: "explicit" | "implicit";
}): DispatchCronDeliveryParams {
  const resolvedDelivery = {
    ...makeResolvedDelivery(),
    mode: overrides.resolvedDeliveryMode ?? "explicit",
  } satisfies Extract<DeliveryTargetResolution, { ok: true }>;
  const delivery: CronDelivery = {
    mode: "announce",
    bestEffort: overrides.deliveryBestEffort,
  };
  const runStartedAt = overrides.runStartedAt ?? Date.now();
  return {
    deliveryAttemptFence: null,
    cfgWithAgentDefaults: {} as never,
    deps: {} as never,
    job: {
      id: "test-job",
      name: "Test Job",
      sessionTarget: overrides.sessionTarget ?? "isolated",
      sessionKey:
        overrides.sessionTarget === "current" ? "agent:main:webchat:direct:owner" : undefined,
      deleteAfterRun: false,
      delivery,
      payload: { kind: "agentTurn", message: "hello" },
    } as never,
    agentId: "main",
    agentSessionKey: "agent:main:cron:test-job",
    sourceSessionKey:
      overrides.sessionTarget === "current" ? "agent:main:webchat:direct:owner" : undefined,
    sourceSessionGeneration:
      overrides.sessionTarget === "current"
        ? { sessionId: "source-session-id", lifecycleRevision: "source-lifecycle-revision" }
        : undefined,
    runSessionKey: overrides.runSessionKey ?? "agent:main:cron:test-job",
    sessionId: "test-session-id",
    lifecycleRevision: "test-lifecycle-revision",
    sessionUpdatedAt: 1_000,
    runStartedAt,
    timeoutMs: 30_000,
    resolvedDelivery,
    deliveryPlan: resolveCronDeliveryPlan({ delivery }),
    deliveryRequested: overrides.deliveryRequested ?? true,
    undeliveredRunStatus: "ok",
    skipDelivery: undefined,
    spawnOnlyHandoff: overrides.spawnOnlyHandoff ?? false,
    sourceDeliveryOutcome: {
      visibleDeliveries: [],
      verifiedMessageToolDelivery: false,
      satisfiesSourceDelivery: false,
      unverifiedMessageToolDelivery: false,
    },
    deliveryBestEffort: overrides.deliveryBestEffort ?? false,
    deliveryPayloadHasStructuredContent: false,
    deliveryPayloads: overrides.synthesizedText ? [{ text: overrides.synthesizedText }] : [],
    synthesizedText: overrides.synthesizedText ?? "on it",
    summary: overrides.synthesizedText ?? "on it",
    outputText: overrides.synthesizedText ?? "on it",
    abortSignal: undefined,
    isAborted: () => false,
    abortReason: () => "aborted",
  };
}

type SourceOutcome = DispatchCronDeliveryParams["sourceDeliveryOutcome"];
export function messageToolOutcome(
  targets: SourceOutcome["visibleDeliveries"][number]["target"][],
  verified = true,
): SourceOutcome {
  return {
    visibleDeliveries: targets.map((target) => ({
      via: "message_tool",
      target,
      verifiedTarget: verified,
    })),
    verifiedMessageToolDelivery: verified,
    satisfiesSourceDelivery: verified,
    unverifiedMessageToolDelivery: !verified,
  };
}
