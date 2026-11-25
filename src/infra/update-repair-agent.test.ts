import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { runUpdateRepairLoop as repairLoop } from "./update-repair-agent.js";
import { repairRoute } from "./update-repair-agent.test-support.js";
import type { UpdateRepairValidation } from "./update-repair-protocol.js";

type UpdateRepairParams = Parameters<typeof repairLoop>[0];

const runtime = vi.hoisted(() => ({
  withUpdateRepairEnvironment: vi.fn((_target, run) => run()),
  prepareUpdateRepairInference: vi.fn(),
  runUpdateRepairTurn: vi.fn(),
}));
vi.mock("./update-repair-agent.runtime.js", () => runtime);

const target = {
  stateDir: "/fixture/state",
  configPath: "/fixture/config.json",
  workspaceDir: "/fixture/workspace",
  installRoot: "/fixture/install",
};
const unhealthy = (score: number): UpdateRepairValidation => ({
  ok: false,
  score,
  summary: `Remaining errors: ${-score}`,
});
const healthy = { ok: true, score: 0, summary: "Doctor passed" };
function turnResult(text: string, toolCalls = 1, status = "ok") {
  return {
    toolCalls,
    envelope: { model: "repair", provider: "fixture", final: text, status },
  };
}
function params(validate = vi.fn().mockResolvedValue(unhealthy(-2))): UpdateRepairParams {
  return { target, context: { error: "Candidate boot failed", phase: "validating" }, validate };
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.prepareUpdateRepairInference.mockReset();
  runtime.runUpdateRepairTurn.mockReset();
  runtime.prepareUpdateRepairInference.mockResolvedValue({
    ok: true,
    route: repairRoute("/fixture/agent"),
    modelFallbacks: ["fixture/fallback"],
  });
  runtime.runUpdateRepairTurn.mockResolvedValue(
    turnResult('REPAIR_RESULT:{"status":"fixed","summary":"OK"}'),
  );
});
afterEach(() => {
  vi.useRealTimers();
});

it.each([
  { before: -3, after: -4, status: "unrepaired", reason: "Validation regressed after repair." },
  { before: -4, after: -3, status: "improved", reason: "turn-budget" },
])("stops after one $status turn", async ({ before, after, status, reason }) => {
  const validate = vi
    .fn()
    .mockResolvedValueOnce(unhealthy(before))
    .mockResolvedValueOnce(unhealthy(after));
  const events: string[] = [];
  const result = await repairLoop({
    ...params(validate),
    onEvent: (event) => events.push(event.type),
  });
  expect(result).toMatchObject({ status, reason, attempts: [expect.anything()] });
  expect(runtime.runUpdateRepairTurn).toHaveBeenCalledOnce();
  expect(events).toEqual(
    "validation route-selected turn-started validation turn-finished stopped".split(" "),
  );
});

it.each([-610_000, 610_000])(
  "aborts the turn at its deadline after a %ims clock step and validates drained edits",
  async (jump) => {
    vi.useFakeTimers();
    let drained = false;
    runtime.runUpdateRepairTurn.mockImplementationOnce(async ({ signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      drained = true;
      return turnResult("Partial edit", 1, "timeout");
    });
    const validate = vi.fn().mockImplementation(async () => {
      if (validate.mock.calls.length > 1) {
        expect(drained).toBe(true);
      }
      return unhealthy(-1);
    });
    const pending = repairLoop({ ...params(validate), budget: { perTurnMs: 10 } });
    vi.setSystemTime(Date.now() + jump);
    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;
    expect(result).toMatchObject({ status: "aborted", reason: "per-turn-budget" });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(result.attempts).toHaveLength(1);
  },
);

it.each([-610_000, 610_000])(
  "returns at the wall deadline after a %ims clock step even if the oracle never settles",
  async (jump) => {
    vi.useFakeTimers();
    const validate = vi.fn(() => new Promise<UpdateRepairValidation>(() => {}));
    const pending = repairLoop({ ...params(validate), budget: { wallClockMs: 10 } });
    vi.setSystemTime(Date.now() + jump);
    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;
    expect(result).toMatchObject({ status: "aborted", reason: "wall-clock-budget" });
    expect(runtime.withUpdateRepairEnvironment).not.toHaveBeenCalled();
    expect(runtime.runUpdateRepairTurn).not.toHaveBeenCalled();
  },
);

it.each([-610_000, 610_000])(
  "preserves elapsed budgets and duration after a %ims wall-clock step",
  async (jump) => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    const validate = vi
      .fn()
      .mockImplementationOnce(async () => {
        vi.advanceTimersByTime(1_000);
        vi.setSystemTime(Date.now() + jump);
        return unhealthy(-2);
      })
      .mockResolvedValueOnce(healthy);
    runtime.prepareUpdateRepairInference.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(1_000);
      return { ok: true, route: repairRoute("/fixture/agent"), modelFallbacks: [] };
    });
    runtime.runUpdateRepairTurn.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(25);
      vi.setSystemTime(Date.now() + jump);
      return turnResult("Fixed");
    });
    const result = await repairLoop({
      ...params(validate),
      budget: { wallClockMs: 60_000, perTurnMs: 60_000 },
    });
    expect(result).toMatchObject({ status: "repaired", attempts: [{ durationMs: 25 }] });
    expect(runtime.prepareUpdateRepairInference).toHaveBeenCalledWith(expect.anything(), 59_000);
    expect(runtime.runUpdateRepairTurn).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 58_000 }),
    );
  },
);

it("validates partial edits before reporting tool-budget exhaustion", async () => {
  runtime.runUpdateRepairTurn.mockResolvedValueOnce(turnResult("Partial repair", 2));
  const validate = vi.fn(async () => unhealthy(-4 + validate.mock.calls.length));
  const result = await repairLoop({ ...params(validate), budget: { maxToolCalls: 2 } });
  expect(result).toMatchObject({ status: "aborted", reason: "tool-call-budget" });
  expect(result.attempts.map((attempt) => attempt.toolCalls)).toEqual([2]);
  expect(validate).toHaveBeenCalledTimes(2);
  expect(result.attempts[0]?.validation).toEqual(unhealthy(-2));
});

it("falls back to raw text when the repair result is malformed", async () => {
  const summary = "REPAIR_RESULT: garbage";
  runtime.runUpdateRepairTurn.mockResolvedValueOnce(turnResult(summary));
  const result = await repairLoop(params());
  expect(result).toMatchObject({ status: "unrepaired", attempts: [{ summary }] });
});

it("caps the complete model prompt and redacts evidence and result summaries", async () => {
  const secret = "sk-test-" + "x".repeat(80);
  runtime.runUpdateRepairTurn.mockResolvedValueOnce(
    turnResult(`token=${secret} ${"diagnostic ".repeat(90)}`),
  );
  const input = params();
  input.context.symptoms = Array.from({ length: 30 }, () => "Symptom 😀".repeat(100));
  input.context.error = `token=${secret} ` + "failure ".repeat(2000);
  const result = await repairLoop(input);
  const prompt = runtime.runUpdateRepairTurn.mock.calls[0]?.[0].prompt as string;
  expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(8192);
  expect(prompt).toContain("Never start, stop, or restart");
  expect(prompt).toContain("REPAIR_RESULT:");
  expect(prompt).not.toContain(secret);
  expect(result.attempts[0]?.summary).not.toContain("x".repeat(20));
  expect(result).toMatchObject({ status: "unrepaired", reason: "Validation did not improve." });
});

it("reports unavailable inference without starting a turn or throwing", async () => {
  runtime.prepareUpdateRepairInference.mockResolvedValueOnce({ ok: false, reason: "No route." });
  const result = await repairLoop(params());
  expect(result).toMatchObject({ status: "unavailable", reason: "No route.", attempts: [] });
  expect(runtime.runUpdateRepairTurn).not.toHaveBeenCalled();
});

it("rejects a closed owner and a concurrent repair before either can execute", async () => {
  const validation = createDeferredCore<UpdateRepairValidation>();
  const validate = vi.fn(() => validation.promise);
  const first = repairLoop(params(validate));
  expect(validate).toHaveBeenCalledOnce();
  expect((await repairLoop(params())).status).toBe("unavailable");
  validation.resolve(healthy);
  expect(await first).toEqual({ status: "repaired", attempts: [], finalValidation: healthy });
  expect((await repairLoop({ ...params(), isCurrent: () => false })).status).toBe("aborted");
  expect(runtime.runUpdateRepairTurn).not.toHaveBeenCalled();
  expect(runtime.prepareUpdateRepairInference).not.toHaveBeenCalled();
});
