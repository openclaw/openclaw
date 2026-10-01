import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect } from "vitest";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import type { CronDelivery } from "../types.js";
import type { dispatchCronDelivery } from "./delivery-dispatch.js";
import type { DeliveryTargetResolution } from "./delivery-target.js";
import type { RunCronAgentTurnResult } from "./run.types.js";

type SuccessfulDeliveryResolution = Extract<DeliveryTargetResolution, { ok: true }>;

export function expectFields(actual: Record<string, unknown>, expected: Record<string, unknown>) {
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key], key).toEqual(value);
  }
}

export function expectResultFields(result: unknown, expected: Record<string, unknown>) {
  const requireRecord = createRequireRecord("object", "expected-label");
  expectFields(requireRecord(result, "cron delivery result"), expected);
}

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

function makeWithRunSession() {
  return (
    result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
  ): RunCronAgentTurnResult => ({
    ...result,
    sessionId: "test-session-id",
    sessionKey: "test-session-key",
  });
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
}): Parameters<typeof dispatchCronDelivery>[0] {
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
    cfg: {} as never,
    cfgWithAgentDefaults: {} as never,
    deps: {} as never,
    job: {
      id: "test-job",
      name: "Test Job",
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      sessionTarget: overrides.sessionTarget ?? "isolated",
      sessionKey:
        overrides.sessionTarget === "current" ? "agent:main:webchat:direct:owner" : undefined,
      deleteAfterRun: false,
      delivery,
      payload: { kind: "agentTurn", message: "hello" },
    } as never,
    agentId: "main",
    agentSessionKey: "agent:main",
    sourceSessionKey:
      overrides.sessionTarget === "current" ? "agent:main:webchat:direct:owner" : undefined,
    sourceSessionGeneration:
      overrides.sessionTarget === "current"
        ? { sessionId: "source-session-id", lifecycleRevision: "source-lifecycle-revision" }
        : undefined,
    runSessionKey: overrides.runSessionKey ?? "agent:main",
    sessionId: "test-session-id",
    lifecycleRevision: "test-lifecycle-revision",
    sessionUpdatedAt: 1_000,
    runStartedAt,
    runEndedAt: runStartedAt,
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
    telemetry: undefined,
    abortSignal: undefined,
    isAborted: () => false,
    abortReason: () => "aborted",
    withRunSession: makeWithRunSession(),
  };
}
