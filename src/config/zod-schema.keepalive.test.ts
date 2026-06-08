// Verifies gateway.keepalive is part of the strict gateway config schema and is
// range/cross-field validated, so `openclaw config validate` accepts a valid
// block and rejects bad values (rather than the strict object rejecting the key).
import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

type ParseResult = ReturnType<typeof OpenClawSchema.safeParse>;

function keepaliveIssues(result: ParseResult) {
  if (result.success) {
    return [];
  }
  return result.error.issues.filter((i) => i.path[0] === "gateway" && i.path[1] === "keepalive");
}

function parse(keepalive: unknown): ParseResult {
  return OpenClawSchema.safeParse({ gateway: { keepalive } });
}

describe("gateway.keepalive config schema", () => {
  it("accepts the documented default block (the key is recognized, not rejected)", () => {
    expect(keepaliveIssues(parse({ interval: 30000, timeout: 5000 }))).toHaveLength(0);
  });

  it("accepts an omitted keepalive block (keepalive is on by default)", () => {
    const result = OpenClawSchema.safeParse({ gateway: {} });
    expect(keepaliveIssues(result)).toHaveLength(0);
  });

  it("accepts interval 0 (operator opt-out)", () => {
    expect(keepaliveIssues(parse({ interval: 0 }))).toHaveLength(0);
  });

  it("rejects timeout >= interval", () => {
    const result = parse({ interval: 5000, timeout: 5000 });
    const issues = keepaliveIssues(result);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.path.join(".") === "gateway.keepalive.timeout")).toBe(true);
  });

  it("rejects a timeout-only block whose timeout >= the default interval (30000)", () => {
    // interval omitted -> runtime defaults it to 30000, so a large timeout-only
    // block must not validate as if it were unconstrained.
    expect(keepaliveIssues(parse({ timeout: 30000 })).length).toBeGreaterThan(0);
    expect(keepaliveIssues(parse({ timeout: 45000 })).length).toBeGreaterThan(0);
  });

  it("accepts a timeout-only block below the default interval", () => {
    expect(keepaliveIssues(parse({ timeout: 20000 }))).toHaveLength(0);
  });

  it("rejects a non-zero interval below the 5000ms floor", () => {
    expect(keepaliveIssues(parse({ interval: 1000 })).length).toBeGreaterThan(0);
  });

  it("rejects an interval above the 3600000ms ceiling", () => {
    expect(keepaliveIssues(parse({ interval: 3_600_001 })).length).toBeGreaterThan(0);
  });

  it("rejects a timeout outside 1000-60000", () => {
    expect(keepaliveIssues(parse({ interval: 30000, timeout: 500 })).length).toBeGreaterThan(0);
    expect(keepaliveIssues(parse({ interval: 30000, timeout: 60_001 })).length).toBeGreaterThan(0);
  });

  it("rejects unknown keys inside the strict keepalive object", () => {
    expect(keepaliveIssues(parse({ interval: 30000, bogus: 1 })).length).toBeGreaterThan(0);
  });
});
