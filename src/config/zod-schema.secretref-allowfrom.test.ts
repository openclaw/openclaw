import { describe, expect, it } from "vitest";
import {
  normalizeAllowFrom,
  requireAllowlistAllowFrom,
  requireOpenAllowFrom,
} from "./zod-schema.core.js";

const envRef = (id: string) => ({ source: "env" as const, provider: "default", id });

function collectIssues(
  fn: (params: {
    policy: string;
    allowFrom: ReadonlyArray<unknown>;
    ctx: { addIssue: (issue: unknown) => void };
    path: string[];
    message: string;
  }) => void,
  policy: string,
  allowFrom: ReadonlyArray<unknown>,
): unknown[] {
  const issues: unknown[] = [];
  fn({
    policy,
    allowFrom,
    ctx: { addIssue: (issue: unknown) => issues.push(issue) },
    path: ["allowFrom"],
    message: "test validation error",
  } as Parameters<typeof fn>[0]);
  return issues;
}

describe("normalizeAllowFrom with SecretRef entries", () => {
  it("filters out SecretRef objects and keeps plain strings", () => {
    const result = normalizeAllowFrom(["+15550001234", envRef("PHONE"), "+15550005678"]);
    expect(result).toEqual(["+15550001234", "+15550005678"]);
  });

  it("filters out env-template SecretRef strings and keeps plain strings", () => {
    const result = normalizeAllowFrom(["+15550001234", "plaintext"]);
    expect(result).toEqual(["+15550001234", "plaintext"]);
  });

  it("returns empty array when all entries are SecretRefs", () => {
    const result = normalizeAllowFrom([envRef("A"), envRef("B")]);
    expect(result).toEqual([]);
  });

  it("handles undefined input", () => {
    expect(normalizeAllowFrom(undefined)).toEqual([]);
  });

  it("handles mixed numbers, strings, and SecretRefs", () => {
    const result = normalizeAllowFrom([42, envRef("SECRET"), "ok"]);
    expect(result).toEqual(["42", "ok"]);
  });
});

describe("requireAllowlistAllowFrom with SecretRef entries", () => {
  it("rejects empty allowFrom with allowlist policy", () => {
    const issues = collectIssues(requireAllowlistAllowFrom, "allowlist", []);
    expect(issues).toHaveLength(1);
  });

  it("accepts plain strings with allowlist policy", () => {
    const issues = collectIssues(requireAllowlistAllowFrom, "allowlist", ["+15550001234"]);
    expect(issues).toHaveLength(0);
  });

  it("accepts SecretRef-only allowFrom with allowlist policy", () => {
    const issues = collectIssues(requireAllowlistAllowFrom, "allowlist", [envRef("PHONE")]);
    expect(issues).toHaveLength(0);
  });

  it("accepts mixed SecretRef and plain strings with allowlist policy", () => {
    const issues = collectIssues(requireAllowlistAllowFrom, "allowlist", [
      envRef("PHONE"),
      "+15550001234",
    ]);
    expect(issues).toHaveLength(0);
  });
});

describe("requireOpenAllowFrom with SecretRef entries", () => {
  it("rejects open policy without wildcard", () => {
    const issues = collectIssues(requireOpenAllowFrom, "open", ["+15550001234"]);
    expect(issues).toHaveLength(1);
  });

  it("accepts open policy with wildcard", () => {
    const issues = collectIssues(requireOpenAllowFrom, "open", ["*"]);
    expect(issues).toHaveLength(0);
  });

  it("accepts open policy with SecretRef that may resolve to wildcard", () => {
    const issues = collectIssues(requireOpenAllowFrom, "open", [envRef("WILDCARD")]);
    expect(issues).toHaveLength(0);
  });

  it("accepts open policy with mixed SecretRef and wildcard", () => {
    const issues = collectIssues(requireOpenAllowFrom, "open", [envRef("PHONE"), "*"]);
    expect(issues).toHaveLength(0);
  });
});
