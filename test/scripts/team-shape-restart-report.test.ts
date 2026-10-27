import { expect, it } from "vitest";
import { summarizeRestartStress } from "../../scripts/perf/team-shape-restart-report.ts";

const input = {
  id: "original",
  sessionKey: "agent:main:stress",
  sentAt: 10,
  accepted: true,
  phase: "managed",
};
const capture = {
  inputs: [input],
  events: [],
  restarts: [],
  histories: {
    [input.sessionKey]: {
      messages: [
        { role: "user", content: "Please finish with DONE_original" },
        { role: "assistant", phase: "commentary", content: "I will return DONE_original" },
      ],
      inputReceipts: [{ runId: input.id, state: "consumed", consumedByEventId: "user-row" }],
      sessionInfo: { hasActiveRun: false },
    },
  },
  log: "Gateway ready",
  effects: {},
  provider: { firstActivity: { original: 30 } },
  errors: [],
};

it("reports consumed input without an answer as unresolved, retaining actual request latency", () => {
  const { report } = summarizeRestartStress({
    ...capture,
    inputs: [{ ...input, accepted: false, error: "gateway request timeout" }],
  });
  expect(report.invariants.find((item) => item.id === 1)).toMatchObject({ status: "fail" });
  expect(report.inputs[0]).toMatchObject({
    accepted: true,
    acknowledged: false,
    acceptanceSource: "durable-receipt",
    transportUncertain: true,
    outcome: "unresolved",
    receipt: { state: "consumed" },
  });
  expect(report.latencyMs).toMatchObject({ samples: 1, p50: 20, p95: 20, max: 20 });
  expect(report.invariants.find((item) => item.id === 2)).toMatchObject({ status: "unknown" });
  expect(report.invariants.find((item) => item.id === 7)).toMatchObject({ status: "unknown" });
  const idleOnly = summarizeRestartStress({
    ...capture,
    restarts: [{ kind: "managed", at: 40, returnedAt: 50, active: [], idle: ["idle"] }],
  });
  expect(idleOnly.report.invariants.find((item) => item.id === 2)).toMatchObject({
    status: "unknown",
  });
  const uncertain = summarizeRestartStress({
    ...capture,
    inputs: [{ ...input, accepted: false }],
    histories: {},
  });
  expect(uncertain.report.inputs[0]?.outcome).toBe("acceptance-unknown");
  expect(uncertain.report.invariants.find((item) => item.id === 1)?.status).toBe("unknown");
  const idleQueued = summarizeRestartStress({
    ...capture,
    histories: {
      [input.sessionKey]: {
        messages: [{ role: "assistant", phase: "final_answer", content: "DONE_original" }],
        sessionInfo: { hasActiveRun: false },
        pendingInputs: { items: [{ runId: input.id, state: "queued" }] },
      },
    },
  });
  expect(idleQueued.report.inputs[0]?.outcome).toBe("answered");
  expect(idleQueued.report.invariants.find((item) => item.id === 1)?.status).toBe("fail");
  expect(idleQueued.report.counts.stuckQueued).toBe(1);
});

it("flags duplicate effects and final deliveries and visible errors after recovered work", () => {
  const { report } = summarizeRestartStress({
    ...capture,
    log: '{"event":"model_fallback_decision","fallbackStepFinalOutcome":"succeeded"}',
    provider: { requests: [{ at: 30, id: input.id }] },
    histories: {
      [input.sessionKey]: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "DONE_original" }],
            __openclaw: { id: "final-a", recordTimestampMs: 60 },
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "DONE_original" }],
            __openclaw: { id: "final-b", recordTimestampMs: 70 },
          },
          { role: "system", content: "Temporary error while recovering" },
        ],
      },
    },
    effects: { "original.effects": ["EFFECT_original", "EFFECT_original"] },
    restarts: [
      {
        kind: "managed",
        at: 40,
        returnedAt: 50,
        active: [input.sessionKey],
        idle: [],
        exitCode: 0,
        signal: null,
        shutdownMs: 5,
      },
    ],
    events: [
      {
        at: 60,
        event: "agent",
        payload: {
          sessionKey: input.sessionKey,
          runId: "recovered",
          stream: "lifecycle",
          data: { phase: "start" },
        },
      },
    ],
  });
  expect(report.invariants.find((item) => item.id === 1)).toMatchObject({ status: "pass" });
  expect(report.invariants.find((item) => item.id === 3)).toMatchObject({ status: "fail" });
  expect(report.effects).toEqual([
    { file: "original.effects", effect: "EFFECT_original", count: 2 },
  ]);
  expect(report.inputs[0]?.finalMarkers).toBe(2);
  expect(report.invariants.find((item) => item.id === 4)).toMatchObject({ status: "fail" });
  expect(report.counts.fallbackDecisions).toBe(1);
  expect(report.invariants.find((item) => item.id === 7)).toMatchObject({ status: "pass" });
  const durable = {
    role: "assistant",
    content: "DONE_original",
    __openclaw: { id: "unique", recordTimestampMs: 60 },
  };
  const normalSystem = {
    role: "system",
    content: "Compaction",
    __openclaw: { kind: "compaction" },
  };
  const recovered = summarizeRestartStress({
    ...capture,
    restarts: [
      {
        kind: "managed",
        at: 40,
        returnedAt: 50,
        shutdownMs: 5,
        active: [input.sessionKey],
        idle: [],
      },
    ],
    histories: { [input.sessionKey]: { messages: [durable, durable, normalSystem] } },
    effects: { "original.effects": ["EFFECT_original"] },
  });
  expect(recovered.report.invariants.find((item) => item.id === 2)?.status).toBe("pass");
  expect(recovered.report.inputs[0]?.finalMarkers).toBe(1);
  expect(recovered.report.invariants.find((item) => item.id === 4)?.status).toBe("pass");
  const beforeExit = { ...durable, __openclaw: { id: "before-exit", recordTimestampMs: 44 } };
  const raced = summarizeRestartStress({
    ...capture,
    restarts: [
      {
        kind: "managed",
        at: 40,
        returnedAt: 50,
        shutdownMs: 5,
        active: [input.sessionKey],
        idle: [],
      },
    ],
    histories: { [input.sessionKey]: { messages: [beforeExit] } },
  });
  expect(raced.report.invariants.find((item) => item.id === 2)?.status).toBe("unknown");
});

it("detects idle-session activity before reconnect and leaves disconnected silence unknown", () => {
  const restart = {
    kind: "managed",
    at: 40,
    returnedAt: 50,
    shutdownMs: 5,
    active: [input.sessionKey],
    idle: ["idle"],
  };
  const histories = {
    [input.sessionKey]: {
      messages: [
        { role: "assistant", content: "DONE_original", __openclaw: { recordTimestampMs: 60 } },
      ],
    },
    idle: {
      messages: [
        { role: "assistant", content: "Unrequested work", __openclaw: { recordTimestampMs: 47 } },
      ],
    },
  };
  const resumed = summarizeRestartStress({ ...capture, restarts: [restart], histories });
  expect(resumed.report.invariants.find((item) => item.id === 2)?.status).toBe("fail");
  const silent = summarizeRestartStress({
    ...capture,
    restarts: [restart],
    histories: { ...histories, idle: { messages: [] } },
  });
  expect(silent.report.invariants.find((item) => item.id === 2)?.status).toBe("unknown");
});
