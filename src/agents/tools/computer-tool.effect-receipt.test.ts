import { beforeEach, describe, expect, it } from "vitest";
import type { ComputerActResult } from "../../plugins/computer-use-contract.js";
import { isToolResultError } from "../tool-result-error.js";
import { createToolTerminalObserver } from "../tool-terminal-outcome.js";
import type { ComputerToolTransport } from "./computer-tool-shared.js";
import {
  createComputerTool,
  resetComputerToolMocks,
  TINY_PNG_BASE64,
  v2Descriptor,
} from "./computer-tool.test-helpers.js";

const projections = [
  "inline observation",
  "targeted observation",
  "screenshot",
  "unchanged screenshot",
  "failed targeted observation",
  "failed screenshot",
] as const;
type Projection = (typeof projections)[number];

const outcomes: {
  name: string;
  result: ComputerActResult;
  expected: "mutation_committed" | "uncertain";
}[] = [
  { name: "confirmed", result: { ok: true, effect: "confirmed" }, expected: "mutation_committed" },
  { name: "unverifiable", result: { ok: true, effect: "unverifiable" }, expected: "uncertain" },
  {
    name: "suspected no-op",
    result: { ok: true, effect: "suspected_noop" },
    expected: "uncertain",
  },
  { name: "missing effect", result: { ok: true }, expected: "uncertain" },
  { name: "unsuccessful", result: { ok: false }, expected: "uncertain" },
];

function windowObservation(index: number): NonNullable<ComputerActResult["observation"]> {
  return {
    kind: "window",
    observationId: `observation-${index}`,
    elements: [
      {
        elementRef: `element-${index}`,
        role: "text",
        label: "Synthetic editor",
        bounds: { x: 0, y: 0, width: 1, height: 1 },
      },
    ],
  };
}

function createFixture(projection: Projection, actionResult: ComputerActResult) {
  const targeted = projection.includes("observation");
  const computerUse = v2Descriptor(["key", "get_window_state", "screenshot"]);
  const counts = { mutations: 0, observations: 0, screenshots: 0 };
  const invoke: ComputerToolTransport["invoke"] = async (request) => {
    if (request.command === "screen.snapshot") {
      counts.screenshots += 1;
      if (projection === "failed screenshot") {
        throw new Error("synthetic screenshot failure");
      }
      return {
        format: "png",
        width: 1,
        height: 1,
        base64: TINY_PNG_BASE64,
        displayFrameId: `display-frame-${counts.screenshots}`,
      };
    }
    if (request.commandParams.action === "get_window_state") {
      counts.observations += 1;
      if (counts.observations > 1 && projection === "failed targeted observation") {
        throw new Error("synthetic observation failure");
      }
      return { ok: true, observation: windowObservation(counts.observations) };
    }
    if (request.commandParams.action === "key") {
      counts.mutations += 1;
      return {
        ...actionResult,
        ...(projection === "inline observation" ? { observation: windowObservation(2) } : {}),
      };
    }
    throw new Error(`Unexpected synthetic action: ${String(request.commandParams.action)}`);
  };
  const tool = createComputerTool({
    idempotencyScope: "receipt-test",
    ...(projection === "unchanged screenshot" ? { contextEpoch: { value: 0 } } : {}),
    transport: {
      computerUse,
      resolveNode: async () => ({ nodeId: "synthetic-desktop", computerUse }),
      invoke,
    },
  });
  return {
    counts,
    async mutate() {
      if (targeted) {
        await tool.execute("observe", { action: "get_window_state", windowRef: "window-1" });
      } else if (projection === "unchanged screenshot") {
        await tool.execute("observe", { action: "screenshot" });
      }
      return await tool.execute("input", {
        action: "key",
        text: "A",
        ...(targeted ? { windowRef: "window-1", observationId: "observation-1" } : {}),
      });
    },
  };
}

function terminalFor(action: string, result: unknown) {
  return createToolTerminalObserver("computer-receipt-test")({
    toolName: "computer",
    arguments: { action },
    result,
    executionStarted: true,
    outcome: isToolResultError(result) ? "failure" : "success",
  });
}

// Synthetic transport results exercise real validation, projection, and terminal
// classification. They do not prove desktop execution or cancellation settlement.
describe.each(projections)("computer effect receipt after %s", (projection) => {
  beforeEach(resetComputerToolMocks);

  it.each(outcomes)(
    "retains $name action evidence",
    async ({ result: providerResult, expected }) => {
      const fixture = createFixture(projection, providerResult);
      const result = await fixture.mutate();
      const text = result.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");

      expect(fixture.counts.mutations).toBe(1);
      switch (projection) {
        case "inline observation":
          expect(fixture.counts.observations).toBe(1);
          expect(result.details).toMatchObject({ result: { observation: windowObservation(2) } });
          break;
        case "targeted observation":
          expect(fixture.counts.observations).toBe(2);
          expect(result.details).toMatchObject({
            followUpObservation: { observation: windowObservation(2) },
          });
          break;
        case "screenshot":
          expect(fixture.counts.screenshots).toBe(1);
          expect(result.content.some((block) => block.type === "image")).toBe(true);
          break;
        case "unchanged screenshot":
          expect(fixture.counts.screenshots).toBe(2);
          expect(result.content.some((block) => block.type === "image")).toBe(false);
          expect(text).toContain("screen unchanged since previous frame");
          break;
        case "failed targeted observation":
          expect(fixture.counts.observations).toBe(2);
          expect(text).toContain("follow-up observation failed: synthetic observation failure");
          break;
        case "failed screenshot":
          expect(fixture.counts.screenshots).toBe(1);
          expect(text).toContain("follow-up screenshot failed: synthetic screenshot failure");
          break;
      }
      expect(terminalFor("key", result).effectReceipt).toEqual({ state: expected });
    },
  );
});

describe("computer read effect receipts", () => {
  beforeEach(resetComputerToolMocks);

  it.each([
    { ok: true, expected: "read_completed" },
    { ok: false, expected: "failed_no_effect" },
  ])("records a read with ok=$ok as $expected", async ({ ok, expected }) => {
    const computerUse = v2Descriptor(["list_windows"]);
    let reads = 0;
    const tool = createComputerTool({
      transport: {
        computerUse,
        resolveNode: async () => ({ nodeId: "synthetic-desktop", computerUse }),
        invoke: async () => {
          reads += 1;
          return { ok, details: { windows: [] } };
        },
      },
    });
    const result = await tool.execute("read", { action: "list_windows" });
    expect(reads).toBe(1);
    expect(terminalFor("list_windows", result).effectReceipt).toEqual({ state: expected });
  });
});
