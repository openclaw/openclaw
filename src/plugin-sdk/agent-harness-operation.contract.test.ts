import { describe, expectTypeOf, it } from "vitest";
import type { AgentHarnessAttemptParams } from "./agent-harness-runtime.js";

type ReleasedOperation = NonNullable<AgentHarnessAttemptParams["replyOperation"]>;

// A third-party consumer handles the published alternatives exhaustively.
function describeResult(result: NonNullable<ReleasedOperation["result"]>): string {
  switch (result.kind) {
    case "completed":
      return "completed";
    case "failed":
    case "aborted":
      return result.code;
    default:
      return result satisfies never;
  }
}

describe("released harness operation observations", () => {
  it("retains the published phase, result, and turn-kind alternatives", () => {
    expectTypeOf<ReleasedOperation["phase"]>().toEqualTypeOf<
      | "queued"
      | "waiting_for_deferred_maintenance"
      | "waiting_for_global_lane"
      | "preflight_compacting"
      | "memory_flushing"
      | "running"
      | "completed"
      | "failed"
      | "aborted"
    >();
    expectTypeOf<ReleasedOperation["turnKind"]>().toEqualTypeOf<"visible" | "queued_followup">();
    expectTypeOf<ReturnType<typeof describeResult>>().toEqualTypeOf<string>();
  });
});
