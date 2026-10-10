import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeRun } from "./update-run-codec.js";
import { UpdateRunRecordSchema } from "./update-run-schema.js";
import { recordUpdateRunVerificationCheckRecord } from "./update-run-verification.js";

describe("update run verification", () => {
  it("retains required checks when optional diagnostics exceed the bound", () => {
    const record = {
      status: "succeeded",
      verification: {
        checks: Array.from({ length: 32 }, (_, index) => ({
          id: `optional-${index}`,
          status: "pass" as const,
          required: false,
        })),
      },
    } as Parameters<typeof recordUpdateRunVerificationCheckRecord>[0];

    recordUpdateRunVerificationCheckRecord(record, {
      id: "required-failure",
      status: "fail",
      required: true,
    });
    expect(record.verification.checks).toEqual([
      { id: "required-failure", status: "fail", required: true },
      ...Array.from({ length: 31 }, (_, index) => ({
        id: `optional-${index + 1}`,
        status: "pass" as const,
        required: false,
      })),
    ]);
  });

  it("retains no optional checks when all retained slots are required", () => {
    const record = {
      status: "succeeded",
      verification: {
        checks: Array.from({ length: 32 }, (_, index) => ({
          id: `required-${index}`,
          status: "pass" as const,
          required: true,
        })),
      },
    } as Parameters<typeof recordUpdateRunVerificationCheckRecord>[0];

    recordUpdateRunVerificationCheckRecord(record, {
      id: "optional-diagnostic",
      status: "pass",
      required: false,
    });

    expect(record.verification.checks).toHaveLength(32);
    expect(record.verification.checks?.every((check) => check.required !== false)).toBe(true);
    expect(record.verification.checks?.some((check) => check.id === "optional-diagnostic")).toBe(
      false,
    );
  });

  it("preserves required check identities and statuses while bounding optional diagnostics", () => {
    const requiredChecks = Array.from({ length: 16 }, (_, index) => ({
      id: `required-${index}`,
      status: index % 2 === 0 ? ("pass" as const) : ("fail" as const),
      required: true,
    }));
    const record = {
      runId: randomUUID(),
      createdAtMs: 1,
      updatedAtMs: 1,
      trigger: "cli",
      phase: "finished",
      status: "succeeded",
      reason: null,
      origin: {},
      target: {},
      before: {},
      after: {},
      steps: [],
      verification: {
        checks: [
          ...requiredChecks,
          ...Array.from({ length: 16 }, (_, index) => ({
            id: `optional-${index}`,
            status: "unknown" as const,
            required: false,
            detail: "optional diagnostic ".repeat(50),
          })),
        ],
      },
      repair: [],
      confirmedAtMs: null,
      finishedAtMs: 2,
      downtimeMs: null,
    } as Parameters<typeof encodeRun>[0];

    const encoded = encodeRun(record, { env: { HOME: "/tmp/openclaw" } });
    const verification = JSON.parse(encoded.verification_json) as {
      checks: Array<{ id: string; status: string; required?: boolean }>;
    };

    expect(verification.checks).toEqual(
      expect.arrayContaining(
        requiredChecks.map(({ id, status, required }) => ({ id, status, required })),
      ),
    );
    expect(verification.checks.length).toBeGreaterThanOrEqual(requiredChecks.length);
    expect(verification.checks.length).toBeLessThanOrEqual(32);
  });

  it("preserves typed normal-cycle fields when diagnostics approach the byte bound", () => {
    const record = {
      runId: randomUUID(),
      createdAtMs: 1,
      updatedAtMs: 1,
      trigger: "cli",
      phase: "finished",
      status: "succeeded",
      reason: null,
      origin: {},
      target: {},
      before: {},
      after: {},
      steps: [],
      verification: {
        checks: Array.from({ length: 14 }, (_, index) => ({
          id: `required-${index}`,
          status: "pass" as const,
          required: true,
          detail: "required diagnostic ".repeat(48),
        })),
        normalCycle: {
          status: "pass" as const,
          observedAtMs: 20,
          detail: "normal-cycle diagnostic ".repeat(40),
        },
        doctorHint: "doctor hint ".repeat(90),
      },
      repair: [],
      confirmedAtMs: null,
      finishedAtMs: 2,
      downtimeMs: null,
    } as Parameters<typeof encodeRun>[0];

    const encoded = encodeRun(record, { env: { HOME: "/tmp/openclaw" } });
    const verification = UpdateRunRecordSchema.shape.verification.parse(
      JSON.parse(encoded.verification_json),
    );
    const checks = verification.checks ?? [];

    expect(verification.normalCycle).toEqual(
      expect.objectContaining({ status: "pass", observedAtMs: 20 }),
    );
    expect(checks.map(({ id, status, required }) => ({ id, status, required }))).toEqual(
      expect.arrayContaining(
        Array.from({ length: 14 }, (_, index) => ({
          id: `required-${index}`,
          status: "pass",
          required: true,
        })),
      ),
    );
  });

  it("rejects a required check set that cannot fit the verification byte bound", () => {
    const record = {
      runId: randomUUID(),
      createdAtMs: 1,
      updatedAtMs: 1,
      trigger: "cli",
      phase: "finished",
      status: "succeeded",
      reason: null,
      origin: {},
      target: {},
      before: {},
      after: {},
      steps: [],
      verification: {
        checks: Array.from({ length: 16 }, (_, index) => ({
          id: `${index}-`.padEnd(1024, "x"),
          status: "pass" as const,
          required: true,
        })),
      },
      repair: [],
      confirmedAtMs: null,
      finishedAtMs: 2,
      downtimeMs: null,
    } as Parameters<typeof encodeRun>[0];

    expect(() => encodeRun(record, { env: { HOME: "/tmp/openclaw" } })).toThrow(
      "Required update verification checks exceed their byte limit",
    );
  });
});
