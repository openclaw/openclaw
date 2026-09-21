import { describe, expect, it } from "vitest";
import { assessHostCollectorPopulation } from "./population-runtime.js";

describe("host-owned collector dynamics telemetry", () => {
  it("keeps semantic candidate signals unknown for successful collectors", () => {
    expect(
      assessHostCollectorPopulation({
        groupId: "swarm:test",
        maxConcurrent: 4,
        records: [{ runId: "run-1", terminalStatus: "done" }],
      }),
    ).toMatchObject({
      authority: "search-only",
      actions: [{ kind: "hold" }],
    });
  });

  it("turns host-observed terminal failure into advisory debt pressure", () => {
    expect(
      assessHostCollectorPopulation({
        groupId: "swarm:test",
        maxConcurrent: 4,
        records: [
          { runId: "run-1", terminalStatus: "failed" },
          { runId: "run-2", terminalStatus: "done" },
        ],
      }),
    ).toMatchObject({
      authority: "search-only",
      actions: [{ kind: "drain" }],
    });
  });

  it("treats scheduler saturation as measured pressure without inventing evidence", () => {
    expect(
      assessHostCollectorPopulation({
        groupId: "swarm:test",
        maxConcurrent: 2,
        records: [
          { runId: "run-1", terminalStatus: null },
          { runId: "run-2", terminalStatus: null },
        ],
      }),
    ).toMatchObject({
      actions: [{ kind: "drain" }],
    });
  });
});
