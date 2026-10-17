// Covers iterative redaction traversal for deep nesting and cyclic sensitive objects.

import { describe, expect, it } from "vitest";
import { REDACTED_SENTINEL, redactConfigObject, redactConfigSnapshot } from "./redact-snapshot.js";
import { makeSnapshot } from "./redact-snapshot.test-helpers.js";

describe("redactConfigSnapshot traversal", () => {
  it("does not throw RangeError on pathologically nested objects", () => {
    const depth = 4000;
    const secret = "synthetic-deep-nested-token-abcdefghij";
    let value: unknown = { token: secret };
    for (let i = 0; i < depth; i += 1) {
      value = { x: value };
    }

    expect(() => redactConfigObject(value)).not.toThrow();
    const redacted = redactConfigObject(value);

    let cursor: unknown = redacted;
    for (let i = 0; i < depth; i += 1) {
      cursor = (cursor as { x: unknown }).x;
    }
    expect((cursor as { token: string }).token).toBe(REDACTED_SENTINEL);

    let originalCursor: unknown = value;
    for (let i = 0; i < depth; i += 1) {
      originalCursor = (originalCursor as { x: unknown }).x;
    }
    expect((originalCursor as { token: string }).token).toBe(secret);
  });

  it("terminates cyclic sensitive objects and still collects their secrets", () => {
    const secret = "cycle-secret-private-key-abcdefghij";
    const cyclic: Record<string, unknown> = {
      type: "service_account",
      private_key: secret,
    };
    cyclic.self = cyclic;

    expect(() => redactConfigObject({ serviceAccount: cyclic })).not.toThrow();
    const redacted = redactConfigObject({ serviceAccount: cyclic });
    expect(redacted.serviceAccount).toBe(REDACTED_SENTINEL);
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(cyclic.private_key).toBe(secret);

    const raw = `{
  "serviceAccount": {
    "type": "service_account",
    "private_key": "${secret}"
  }
}`;
    const result = redactConfigSnapshot(makeSnapshot({ serviceAccount: cyclic }, raw));
    expect((result.config as { serviceAccount: unknown }).serviceAccount).toBe(REDACTED_SENTINEL);
    expect(JSON.stringify(result)).not.toContain(secret);
  }, 3000);
});
