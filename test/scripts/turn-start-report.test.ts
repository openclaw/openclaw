import { expect, it } from "vitest";
import {
  observeTurnStartReceipt,
  summarizeTurnStarts,
  type TurnStartPhase,
  type TurnStartSample,
} from "../../scripts/perf/turn-start-report.ts";

it("captures only matching visible assistant deltas and tool starts, once per milestone", () => {
  const sample = { sessionKey: "agent:main:session", runId: "current" };
  const delta = {
    event: "chat",
    payload: {
      sessionKey: sample.sessionKey,
      runId: sample.runId,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "First token" }] },
    },
  };
  for (const payload of [
    { ...delta.payload, sessionKey: "agent:main:other" },
    { ...delta.payload, runId: "stale" },
    { ...delta.payload, state: "final" },
    { ...delta.payload, message: { role: "assistant", content: "  " } },
    { ...delta.payload, message: { role: "user", content: "Wrong role" } },
  ]) {
    observeTurnStartReceipt(sample, { event: "chat", payload }, 10);
  }
  const tool = {
    event: "session.tool",
    payload: {
      sessionKey: sample.sessionKey,
      runId: sample.runId,
      stream: "tool",
      data: { phase: "start" },
    },
  };
  observeTurnStartReceipt(
    sample,
    { event: "session.tool", payload: { ...tool.payload, data: { phase: "result" } } },
    20,
  );
  observeTurnStartReceipt(sample, { ...tool, event: "response.output_item.added" }, 25);
  expect(sample).toEqual({ sessionKey: "agent:main:session", runId: "current" });
  observeTurnStartReceipt(sample, delta, 30);
  observeTurnStartReceipt(sample, delta, 40);
  observeTurnStartReceipt(sample, tool, 50);
  observeTurnStartReceipt(sample, { ...tool, event: "agent" }, 60);
  expect(sample).toEqual({
    sessionKey: "agent:main:session",
    runId: "current",
    receivedRunId: "current",
    firstAssistantDeltaMs: 30,
    firstToolStartMs: 50,
  });
});

it.each([{ delta: "Token" }, { text: "Answer" }])(
  "captures canonical assistant agent events: %j",
  (data) => {
    const sample = { sessionKey: "agent:main:session", runId: "current" };
    observeTurnStartReceipt(
      sample,
      {
        event: "agent",
        payload: { ...sample, stream: "assistant", data },
      },
      75,
    );
    expect(sample).toMatchObject({ receivedRunId: "current", firstAssistantDeltaMs: 75 });
  },
);

it("pins a cold run from its first valid pre-ACK receipt and ignores later mismatched runs", () => {
  const sample: Parameters<typeof observeTurnStartReceipt>[0] = {
    sessionKey: "agent:main:new",
    runId: "placeholder",
    awaitingCreatedRunId: true,
  };
  const event = (runId: string, stream: string, data: Record<string, unknown>) => ({
    event: "agent",
    payload: { sessionKey: sample.sessionKey, runId, stream, data },
  });
  observeTurnStartReceipt(sample, event("not-accepted", "assistant", { delta: "" }), 10);
  observeTurnStartReceipt(sample, event("not-accepted", "tool", { phase: "result" }), 20);
  expect(sample.receivedRunId).toBeUndefined();
  observeTurnStartReceipt(sample, event("accepted", "tool", { phase: "start" }), 30);
  observeTurnStartReceipt(sample, event("other", "assistant", { delta: "Wrong run" }), 40);
  expect(sample.firstAssistantDeltaMs).toBeUndefined();
  observeTurnStartReceipt(sample, event("accepted", "assistant", { text: "First answer" }), 50);
  sample.runId = "accepted";
  sample.awaitingCreatedRunId = false;
  observeTurnStartReceipt(sample, event("accepted", "assistant", { delta: "Later answer" }), 60);
  expect(sample).toMatchObject({
    receivedRunId: "accepted",
    firstToolStartMs: 30,
    firstAssistantDeltaMs: 50,
  });
});

it("counts streamed preamble text before the final answer, not other item lifecycle frames", () => {
  const sample: Parameters<typeof observeTurnStartReceipt>[0] = {
    sessionKey: "agent:main:session",
    runId: "current",
  };
  const event = (kind: string, phase: string, progressText: string) => ({
    event: "agent",
    payload: {
      sessionKey: sample.sessionKey,
      runId: sample.runId,
      stream: "item",
      data: { kind, phase, progressText },
    },
  });
  for (const frame of [
    event("preamble", "start", "Starting"),
    event("preamble", "done", "Done"),
    event("command", "update", "Running"),
    event("preamble", "update", " "),
  ]) {
    observeTurnStartReceipt(sample, frame, 10);
  }
  expect(sample.firstAssistantDeltaMs).toBeUndefined();
  observeTurnStartReceipt(sample, event("preamble", "update", "Inspecting the workspace"), 20);
  observeTurnStartReceipt(
    sample,
    {
      event: "agent",
      payload: {
        sessionKey: sample.sessionKey,
        runId: sample.runId,
        stream: "assistant",
        data: { delta: "Final answer" },
      },
    },
    80,
  );
  expect(sample.firstAssistantDeltaMs).toBe(20);
});

function turn(overrides: Partial<TurnStartSample> = {}): TurnStartSample {
  return {
    round: 0,
    sessionKey: "agent:main:fresh",
    runId: "fresh-run",
    startedAtEpochMs: 1000,
    admissionMethod: "sessions.create",
    acknowledgedMs: 200,
    providerRequestMs: 100,
    firstAssistantDeltaMs: 150,
    firstToolStartMs: 120,
    completedMs: 300,
    ...overrides,
  };
}

const phases: TurnStartPhase[] = [
  {
    round: 1,
    name: "chat.send.detail.admission.revalidate",
    durationMs: 80,
    startedAt: 2000,
    endedAt: 2100,
    details: { stage: "startup" },
  },
  {
    round: 0,
    name: "chat.send.detail.admission.revalidate",
    durationMs: 40,
    startedAt: 1000,
    endedAt: 1200,
    details: { stage: "startup" },
  },
  {
    round: 0,
    name: "chat.send.detail.admission.revalidate",
    durationMs: 60,
    startedAt: 1000,
    endedAt: 1200,
    details: { stage: "startup" },
  },
];

it("keeps interleaved client waterfalls per run and overlapping scope totals per cohort", () => {
  const report = summarizeTurnStarts({
    coldRounds: 1,
    turns: [
      turn({
        round: 1,
        runId: "warm-run",
        startedAtEpochMs: 2000,
        admissionMethod: "chat.send",
      }),
      turn(),
    ],
    phases,
  });
  expect(report.waterfalls).toMatchObject([
    { runId: "warm-run", cohort: "warm", admissionMethod: "chat.send" },
    { runId: "fresh-run", cohort: "fresh", admissionMethod: "sessions.create" },
  ]);
  expect(report.waterfalls[1]?.milestones).toEqual([
    { name: "admission.start", offsetMs: 0 },
    { name: "provider.request", offsetMs: 100 },
    { name: "tool.start.received", offsetMs: 120 },
    { name: "assistant.delta.received", offsetMs: 150 },
    { name: "admission.ack", offsetMs: 200 },
    { name: "turn.completed", offsetMs: 300 },
  ]);
  expect(report.phases).toEqual([
    {
      cohort: "warm",
      stage: "startup",
      name: "chat.send.detail.admission.revalidate",
      measurement: "overlapping-stage-aggregate",
      attribution: "round/cohort only; no per-turn correlation",
      totalMs: 80,
      count: 1,
      p50: 80,
      p90: 80,
      p95: 80,
      max: 80,
    },
    {
      cohort: "fresh",
      stage: "startup",
      name: "chat.send.detail.admission.revalidate",
      measurement: "overlapping-stage-aggregate",
      attribution: "round/cohort only; no per-turn correlation",
      totalMs: 100,
      count: 2,
      p50: 40,
      p90: 60,
      p95: 60,
      max: 60,
    },
  ]);
});

it("reports nearest-rank p90 separately from p95 without pooling fresh and warm turns", () => {
  const report = summarizeTurnStarts({
    coldRounds: 1,
    turns: [
      ...Array.from({ length: 20 }, (_, index) =>
        turn({ runId: `fresh-${index}`, acknowledgedMs: (index + 1) * 10 }),
      ),
      turn({ round: 1, runId: "warm", acknowledgedMs: 5 }),
    ],
    phases,
  });
  expect(report.milestones.filter((metric) => metric.name === "admission.ack")).toEqual([
    { cohort: "fresh", name: "admission.ack", count: 20, p50: 100, p90: 180, p95: 190, max: 200 },
    { cohort: "warm", name: "admission.ack", count: 1, p50: 5, p90: 5, p95: 5, max: 5 },
  ]);
});

it("retains subscriber receipts delivered after the agent.wait response", () => {
  const report = summarizeTurnStarts({
    coldRounds: 1,
    turns: [turn({ acknowledgedMs: 90, completedMs: 110 })],
    phases,
  });
  expect(report.waterfalls[0]?.milestones).toEqual([
    { name: "admission.start", offsetMs: 0 },
    { name: "admission.ack", offsetMs: 90 },
    { name: "provider.request", offsetMs: 100 },
    { name: "turn.completed", offsetMs: 110 },
    { name: "tool.start.received", offsetMs: 120 },
    { name: "assistant.delta.received", offsetMs: 150 },
  ]);
});

it.each([
  { firstAssistantDeltaMs: undefined },
  { firstToolStartMs: Number.NaN },
  { providerRequestMs: Infinity },
  { acknowledgedMs: -1 },
  { completedMs: undefined },
])("rejects missing or invalid milestone evidence: %j", (invalid) => {
  expect(() => summarizeTurnStarts({ coldRounds: 1, turns: [turn(invalid)], phases })).toThrow(
    "turn-start milestone",
  );
});

it("rejects empty evidence and inverted diagnostic timestamps", () => {
  expect(() => summarizeTurnStarts({ coldRounds: 1, turns: [], phases })).toThrow(
    "requires completed turns",
  );
  expect(() => summarizeTurnStarts({ coldRounds: 1, turns: [turn()], phases: [] })).toThrow(
    "requires completed turns",
  );
  expect(() =>
    summarizeTurnStarts({
      coldRounds: 1,
      turns: [turn()],
      phases: [{ ...phases[0]!, startedAt: 2200 }],
    }),
  ).toThrow("Invalid turn-start diagnostic phase");
});
