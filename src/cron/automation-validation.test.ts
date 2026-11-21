import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  validateAutomationLastMeaningfulResult,
  validateAutomationResult,
  validateCyberAccessProgram,
} from "../../packages/gateway-protocol/src/compiled/cron-runtime.generated.js";
import {
  AutomationLastMeaningfulResultSchema,
  AutomationResultSchema,
} from "../../packages/gateway-protocol/src/schema/cron-automation-result.js";
import { CyberAccessProgramSchema } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import { parseAutomationResult } from "./automation-result.js";
import { getInvalidPersistedCronJobReason } from "./persisted-shape.js";

const meaningful = { outcome: "done", summary: "Completed.", atMs: 0 };
const summaries = [
  "",
  " \t\n",
  "\u00a0",
  "Completed.",
  "  Completed.  ",
  "x".repeat(2000),
  "x".repeat(2001),
  "🦊".repeat(2000),
  "🦊".repeat(2001),
  "\ud800".repeat(2000),
  "\udc00".repeat(2001),
];
const results: unknown[] = [
  undefined,
  null,
  [],
  {},
  { outcome: "no_change" },
  { outcome: "no_change", summary: undefined },
  { outcome: "invalid", summary: "Completed." },
  { outcome: "done", summary: 1 },
  { outcome: "done", summary: "Completed.", extra: true },
  ...["no_change", "progress", "done", "blocked", "needs_attention"].flatMap((outcome) =>
    summaries.map((summary) => ({ outcome, summary })),
  ),
];
const persisted: unknown[] = [
  undefined,
  null,
  {},
  ...results
    .filter((value) => typeof value === "object" && value !== null)
    .map((value) => Object.assign({}, value, { atMs: 0 })),
  ...[-1, 0, 0.5, 8_640_000_000_000_000, 8_640_000_000_000_001, Infinity, Number.NaN].map((atMs) =>
    Object.assign({}, meaningful, { atMs }),
  ),
  Object.assign(Object.create({ outcome: "done" }), {
    summary: "Completed.",
    atMs: 0,
    extra: true,
  }),
  Object.create(meaningful),
  Object.defineProperty({ ...meaningful }, "extra", { value: true }),
  Object.assign({ ...meaningful }, { [Symbol("ignored")]: true }),
];

const candidate = (fields: Record<string, unknown>) => ({
  id: "job",
  schedule: { kind: "every", everyMs: 60_000 },
  payload: { kind: "agentTurn", message: "Review the queue." },
  ...fields,
});

describe("cron standalone schema checks", () => {
  it("preserves persisted validation after the storage normalization boundaries", () => {
    // Storage clones authored jobs and parses loaded rows. Raw inherited-property
    // semantics are not the generated compiler's contract.
    for (const normalize of [
      (value: unknown) => structuredClone(value),
      (value: unknown): unknown => {
        const stored = JSON.stringify({ value });
        return JSON.parse(stored).value;
      },
    ]) {
      for (const value of persisted) {
        const normalized = normalize(value);
        const valid = Value.Check(AutomationLastMeaningfulResultSchema, normalized);
        expect(validateAutomationLastMeaningfulResult(normalized)).toBe(valid);
        expect(
          getInvalidPersistedCronJobReason(
            candidate({ state: { lastMeaningfulResult: normalized } }),
          ),
        ).toBe(normalized === undefined || valid ? null : "invalid-state");
      }
    }
  });

  it("preserves result checks on own fields and parser normalization", () => {
    for (const value of results) {
      expect(validateAutomationResult(value)).toBe(Value.Check(AutomationResultSchema, value));
    }
    expect(parseAutomationResult({ outcome: "done", summary: "  Completed.  " })).toEqual({
      outcome: "done",
      summary: "Completed.",
    });
    expect(parseAutomationResult({ outcome: "done", summary: " \t\n" })).toBeUndefined();
    expect(parseAutomationResult({ outcome: "no_change", summary: undefined })).toEqual({
      outcome: "no_change",
      summary: undefined,
    });
    expect(
      parseAutomationResult(
        Object.assign(Object.create({ outcome: "done" }), { summary: "Completed." }),
      ),
    ).toBeUndefined();
    expect(
      parseAutomationResult(
        Object.defineProperty({ outcome: "done", summary: "Completed." }, "extra", {
          value: true,
        }),
      ),
    ).toEqual({ outcome: "done", summary: "Completed." });
  });

  it("preserves Access values and the persisted payload restriction", () => {
    for (const value of [
      "standard",
      "daybreak_blue",
      "daybreak_red",
      "",
      " standard",
      "invalid",
      undefined,
      null,
      0,
      {},
    ]) {
      const valid = Value.Check(CyberAccessProgramSchema, value);
      expect(validateCyberAccessProgram(value)).toBe(valid);
      expect(getInvalidPersistedCronJobReason(candidate({ cyberAccessProgram: value }))).toBe(
        value === undefined || valid ? null : "invalid-execution-policy",
      );
    }
    expect(
      getInvalidPersistedCronJobReason(
        candidate({
          cyberAccessProgram: "standard",
          payload: { kind: "systemEvent", text: "Review the queue." },
        }),
      ),
    ).toBe("invalid-execution-policy");
  });
});
