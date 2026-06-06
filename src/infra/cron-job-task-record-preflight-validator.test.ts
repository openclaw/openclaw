import { describe, expect, it } from "vitest";
import {
  validateCronJobTaskRecordPreflight,
  type CronJobTaskRecordValidationResult,
} from "../cron/job-task-record-preflight-validator.js";

// ===== Worked examples (operator-ready) =====
// The worked examples below MUST match the validator's expected output format.

const workedExamplePassInput = {
  id: "dd8090a5-c4b6-449d-be2a-71f464842d9b",
  title:
    "Implement: Cron preflight validator spec -> operator-ready JSON drift + field completeness checker",
  status: "assigned",
  assigned_to: "wrench",
  priority: 3,
  domain: "openclaw",
  project: "openclaw",
  source: "gen_from_517e4ead-45ca-40fc-a782-67c18195da78",
  context:
    "INTENDED_AGENT: wrench\n\nAcceptance criteria: Validator covers required-field completeness, JSON drift detection, deterministic PASS/FAIL, and worked PASS/NEEDS_CHANGES examples.",
  next_action: "Create the lightweight validator implementation and worked examples.",
  created_at: "2026-06-06T16:48:26.899509+00:00",
  updated_at: "2026-06-06T16:58:52.09456+00:00",
  due_at: null,
  deliverable: null,
  blocker: null,
} as const;

const workedExamplePassExpected: CronJobTaskRecordValidationResult = {
  verdict: "PASS",
  summary:
    "PASS: required fields are complete and canonical fields match last-known-good schema snapshot.",
  missingFields: [],
  drift: [],
  notes: [
    "Validated target: cron/job task records (wrench build-queue sweep) (v1).",
    "Result: PASS (0 missing, 0 drift mismatches).",
  ],
};

const workedExampleNeedsChangesInput = {
  ...workedExamplePassInput,
  // Drift: wrong worker + completeness: missing next_action
  assigned_to: "grind",
  next_action: "",
} as const;

const workedExampleNeedsChangesExpected: CronJobTaskRecordValidationResult = {
  verdict: "NEEDS_CHANGES",
  summary: 'missing fields: next_action; schema drift: assigned_to("wrench"→"grind")',
  missingFields: ["next_action"],
  drift: [
    { field: "assigned_to", expected: JSON.stringify("wrench"), actual: JSON.stringify("grind") },
  ],
  notes: [
    "Missing required fields: next_action",
    'Schema drift vs last-known-good snapshot (cron/job task records (wrench build-queue sweep)):\n- assigned_to: expected "wrench", got "grind"',
    "Result: NEEDS_CHANGES (1 missing, 1 drift mismatch).",
  ],
};

describe("cron job task record preflight validator", () => {
  it("worked example: PASS", () => {
    expect(validateCronJobTaskRecordPreflight(workedExamplePassInput)).toEqual(
      workedExamplePassExpected,
    );
  });

  it("worked example: NEEDS_CHANGES", () => {
    expect(validateCronJobTaskRecordPreflight(workedExampleNeedsChangesInput)).toEqual(
      workedExampleNeedsChangesExpected,
    );
  });
});
