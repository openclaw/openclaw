import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUpdateRepairLoop } from "./update-repair-agent.js";
import type { UpdateRepairValidation } from "./update-repair-protocol.js";

type UpdateRepairParams = Parameters<typeof runUpdateRepairLoop>[0];

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
const route = {
  runner: "embedded",
  agentId: "owner",
  provider: "fixture",
  model: "repair",
  modelLabel: "fixture/repair",
  agentDir: "/fixture/agent",
  runConfig: {},
};
function turnResult(
  text = 'REPAIR_RESULT: {"status":"fixed","summary":"Corrected the installation."}',
  toolCalls = 1,
  status = "ok",
) {
  return {
    toolCalls,
    exitCode: status === "ok" ? 0 : 2,
    envelope: { model: "repair", provider: "fixture", final: text, status },
  };
}
function params(validate = vi.fn().mockResolvedValue(unhealthy(-2))): UpdateRepairParams {
  return { target, context: { error: "Candidate boot failed", phase: "validating" }, validate };
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.prepareUpdateRepairInference.mockResolvedValue({
    ok: true,
    route,
    modelFallbacks: ["fixture/fallback"],
  });
  runtime.runUpdateRepairTurn.mockResolvedValue(turnResult());
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runUpdateRepairLoop", () => {
  it("stops when validation regresses", async () => {
    const validate = vi
      .fn()
      .mockResolvedValueOnce(unhealthy(-3))
      .mockResolvedValueOnce(unhealthy(-4));
    const result = await runUpdateRepairLoop(params(validate));
    expect(result).toMatchObject({
      status: "unrepaired",
      reason: "Validation regressed after repair.",
    });
    expect(result.attempts).toHaveLength(1);
    expect(runtime.runUpdateRepairTurn).toHaveBeenCalledOnce();
  });

  it("stops after one improving turn", async () => {
    const validate = vi
      .fn()
      .mockResolvedValueOnce(unhealthy(-4))
      .mockResolvedValueOnce(unhealthy(-3));
    const events: string[] = [];
    const result = await runUpdateRepairLoop({
      ...params(validate),
      onEvent: (event) => events.push(event.type),
    });
    expect(result).toMatchObject({ status: "improved", reason: "turn-budget" });
    expect(result.attempts).toHaveLength(1);
    expect(events).toEqual([
      "validation",
      "route-selected",
      "turn-started",
      "validation",
      "turn-finished",
      "stopped",
    ]);
  });

  it("aborts the turn at its deadline and validates any partial edits after draining", async () => {
    vi.useFakeTimers();
    let drained = false;
    runtime.runUpdateRepairTurn.mockImplementationOnce(
      ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              drained = true;
              resolve(turnResult("Partial edit", 1, "timeout"));
            },
            { once: true },
          );
        }),
    );
    const validate = vi.fn().mockImplementation(async () => {
      if (validate.mock.calls.length > 1) {
        expect(drained).toBe(true);
      }
      return unhealthy(-1);
    });
    const pending = runUpdateRepairLoop({ ...params(validate), budget: { perTurnMs: 10 } });
    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;
    expect(result).toMatchObject({ status: "aborted", reason: "per-turn-budget" });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(result.attempts).toHaveLength(1);
  });

  it("returns at the wall deadline even if a read-only oracle never settles", async () => {
    vi.useFakeTimers();
    const validate = vi.fn(() => new Promise<UpdateRepairValidation>(() => {}));
    const pending = runUpdateRepairLoop({ ...params(validate), budget: { wallClockMs: 10 } });
    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;
    expect(result).toMatchObject({ status: "aborted", reason: "wall-clock-budget" });
    expect(runtime.withUpdateRepairEnvironment).not.toHaveBeenCalled();
    expect(runtime.runUpdateRepairTurn).not.toHaveBeenCalled();
  });

  it("validates partial edits before reporting tool-budget exhaustion", async () => {
    runtime.runUpdateRepairTurn.mockResolvedValueOnce(turnResult("Partial repair", 2));
    const validate = vi.fn(async () => unhealthy(-4 + validate.mock.calls.length));
    const result = await runUpdateRepairLoop({
      ...params(validate),
      budget: { maxToolCalls: 2 },
    });
    expect(result).toMatchObject({ status: "aborted", reason: "tool-call-budget" });
    expect(result.attempts.map((attempt) => attempt.toolCalls)).toEqual([2]);
    expect(runtime.runUpdateRepairTurn.mock.calls[0]?.[0].maxToolCalls).toBe(2);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(result.attempts[0]?.validation).toEqual(unhealthy(-2));
  });

  it("falls back to raw text when the repair result is malformed", async () => {
    runtime.runUpdateRepairTurn.mockResolvedValueOnce(turnResult("REPAIR_RESULT: garbage"));
    const result = await runUpdateRepairLoop(params());
    expect(result.status).toBe("unrepaired");
    expect(result.attempts[0]?.summary).toBe("REPAIR_RESULT: garbage");
  });

  it("caps the complete model prompt and redacts evidence and result summaries", async () => {
    const secret = "sk-test-" + "x".repeat(80);
    runtime.runUpdateRepairTurn.mockResolvedValueOnce(
      turnResult(`token=${secret} ${"diagnostic ".repeat(90)}`),
    );
    const input = params();
    input.context.symptoms = Array.from({ length: 30 }, () => "Symptom 😀".repeat(100));
    input.context.error = `token=${secret} ` + "failure ".repeat(2000);
    const result = await runUpdateRepairLoop(input);
    const prompt = runtime.runUpdateRepairTurn.mock.calls[0]?.[0].prompt as string;
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(8192);
    expect(prompt).toContain("Never start, stop, or restart");
    expect(prompt).toContain("REPAIR_RESULT:");
    expect(prompt).not.toContain(secret);
    expect(result.attempts[0]?.summary).not.toContain("x".repeat(20));
    expect(result).toMatchObject({ status: "unrepaired", reason: "Validation did not improve." });
  });

  it("reports unavailable inference without starting a turn or throwing", async () => {
    runtime.prepareUpdateRepairInference.mockResolvedValueOnce({
      ok: false,
      reason: "No usable route.",
    });
    const result = await runUpdateRepairLoop(params());
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "No usable route.",
      attempts: [],
    });
    expect(runtime.runUpdateRepairTurn).not.toHaveBeenCalled();
  });

  it("rejects a closed owner and a concurrent repair before either can execute", async () => {
    let release!: (value: UpdateRepairValidation) => void;
    const first = runUpdateRepairLoop(
      params(
        vi.fn(
          () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        ),
      ),
    );
    expect(release).toBeTypeOf("function");
    expect((await runUpdateRepairLoop(params())).status).toBe("unavailable");
    release(healthy);
    expect(await first).toEqual({ status: "repaired", attempts: [], finalValidation: healthy });
    expect((await runUpdateRepairLoop({ ...params(), isCurrent: () => false })).status).toBe(
      "aborted",
    );
    expect(runtime.runUpdateRepairTurn).not.toHaveBeenCalled();
    expect(runtime.prepareUpdateRepairInference).not.toHaveBeenCalled();
  });
});
