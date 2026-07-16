// Cron protocol schema tests cover runtime validation for cron protocol payloads.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  CronAddParamsSchema,
  CronDeliverySchema,
  CronJobPatchSchema,
  CronJobStateSchema,
} from "../../packages/gateway-protocol/src/schema.js";

type SchemaLike = {
  properties?: Record<string, unknown>;
  deprecated?: boolean;
  pattern?: string;
  anyOf?: SchemaLike[];
};

describe("cron protocol schema", () => {
  it("marks the legacy lastStatus alias deprecated", () => {
    const properties = (CronJobStateSchema as SchemaLike).properties ?? {};
    const lastStatus = properties.lastStatus as SchemaLike | undefined;
    if (!lastStatus) {
      throw new Error("expected legacy lastStatus schema alias");
    }
    expect(lastStatus.deprecated).toBe(true);
  });

  it("exposes failure-notification delivery state", () => {
    const properties = (CronJobStateSchema as SchemaLike).properties ?? {};
    expect(properties.lastFailureNotificationDelivered).toBeDefined();
    expect(properties.lastFailureNotificationDeliveryStatus).toBeDefined();
    expect(properties.lastFailureNotificationDeliveryError).toBeDefined();
  });

  it("anchors every cron regex pattern for llama.cpp schema conversion", () => {
    // llama.cpp rejects unanchored JSON Schema patterns during grammar
    // conversion; keep cron schemas fully ^...$ so provider routes do not 400.
    const schemas = [CronAddParamsSchema, CronJobPatchSchema, CronDeliverySchema];
    const patterns = schemas.flatMap((schema) => collectPatterns(schema));
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      expect(pattern.startsWith("^") && pattern.endsWith("$"), pattern).toBe(true);
    }
  });

  it("accepts nonblank declaration keys and session targets while rejecting blanks", () => {
    const baseAdd = {
      name: "daily-report",
      schedule: { kind: "at" as const, at: "2026-07-16T12:00:00.000Z" },
      sessionTarget: "main" as const,
      wakeMode: "now" as const,
      payload: { kind: "systemEvent" as const, text: "ping" },
    };

    expect(
      Value.Check(CronAddParamsSchema, {
        ...baseAdd,
        declarationKey: "daily-report",
        displayName: "Daily report",
        sessionTarget: "session:agent:ops:main",
        delivery: { mode: "webhook", to: "https://example.invalid/hook" },
      }),
    ).toBe(true);

    // Whitespace-only values are rejected.
    expect(
      Value.Check(CronAddParamsSchema, {
        ...baseAdd,
        declarationKey: "   ",
      }),
    ).toBe(false);
    expect(
      Value.Check(CronAddParamsSchema, {
        ...baseAdd,
        displayName: "   ",
      }),
    ).toBe(false);

    // Padded values are accepted.
    expect(
      Value.Check(CronAddParamsSchema, {
        ...baseAdd,
        declarationKey: " daily-report ",
      }),
    ).toBe(true);
    expect(
      Value.Check(CronAddParamsSchema, {
        ...baseAdd,
        displayName: " Daily report ",
      }),
    ).toBe(true);

    // Multiline nonblank values are accepted.
    expect(
      Value.Check(CronAddParamsSchema, {
        ...baseAdd,
        displayName: "line one\nline two",
      }),
    ).toBe(true);

    // Trailing-colon-only session targets are rejected.
    expect(
      Value.Check(CronAddParamsSchema, {
        ...baseAdd,
        sessionTarget: "session:",
      }),
    ).toBe(false);

    // Patch rejects whitespace-only displayName.
    expect(
      Value.Check(CronJobPatchSchema, {
        displayName: "   ",
      }),
    ).toBe(false);
  });
});

/** Recursively collect JSON Schema `pattern` strings from a TypeBox schema tree. */
function collectPatterns(value: unknown, out: string[] = []): string[] {
  if (!value || typeof value !== "object") {
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPatterns(item, out);
    }
    return out;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.pattern === "string") {
    out.push(record.pattern);
  }
  for (const child of Object.values(record)) {
    collectPatterns(child, out);
  }
  return out;
}
