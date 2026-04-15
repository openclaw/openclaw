import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("meta.lastTouchedAt numeric timestamp coercion", () => {
  it("accepts a numeric Unix timestamp and coerces it to an ISO string", () => {
    const numericTimestamp = 1770394758161;
    const res = validateConfigObject({
      meta: {
        lastTouchedAt: numericTimestamp,
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(typeof res.config.meta?.lastTouchedAt).toBe("string");
      expect(res.config.meta?.lastTouchedAt).toBe(new Date(numericTimestamp).toISOString());
    }
  });

  it("still accepts a string ISO timestamp unchanged", () => {
    const isoTimestamp = "2026-02-07T01:39:18.161Z";
    const res = validateConfigObject({
      meta: {
        lastTouchedAt: isoTimestamp,
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.meta?.lastTouchedAt).toBe(isoTimestamp);
    }
  });

  it("rejects out-of-range numeric timestamps without throwing", () => {
    const res = validateConfigObject({
      meta: {
        lastTouchedAt: 1e20,
      },
    });
    expect(res.ok).toBe(false);
  });

  it("passes non-date strings through unchanged (backwards-compatible)", () => {
    const res = validateConfigObject({
      meta: {
        lastTouchedAt: "not-a-date",
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.meta?.lastTouchedAt).toBe("not-a-date");
    }
  });

  it("accepts meta with only lastTouchedVersion (no lastTouchedAt)", () => {
    const res = validateConfigObject({
      meta: {
        lastTouchedVersion: "2026.2.6",
      },
    });
    expect(res.ok).toBe(true);
  });

  it("generates JSON Schema for lastTouchedAt with a representable type and no empty any-branches", () => {
    const schema = OpenClawSchema.toJSONSchema({
      target: "draft-07",
      unrepresentable: "any",
    }) as Record<string, unknown>;
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const metaProps = props.meta.properties as Record<string, Record<string, unknown>>;
    const lastTouchedAt = metaProps.lastTouchedAt;

    // Whether or not the union de-duplicates into a single typed branch, the
    // schema must not contain an empty any-schema (`{}`). Pre-fix, the output
    // was `anyOf: [{ type: "string" }, {}]` because the numeric-transform
    // branch's output type was unrepresentable. The .pipe(z.string()) fix
    // makes both branches resolve to typed strings.
    const branches = lastTouchedAt.anyOf as Record<string, unknown>[] | undefined;
    if (branches !== undefined) {
      // Union still present (no de-dup): every branch must be a typed schema.
      expect(branches.length).toBeGreaterThan(0);
      for (const branch of branches) {
        expect(Object.keys(branch).length).toBeGreaterThan(0);
        expect(branch).toHaveProperty("type");
      }
    } else {
      // De-duplicated into a single typed branch — must be a representable string.
      expect(lastTouchedAt.type).toBe("string");
    }
    // Belt-and-suspenders: serializing must never produce an empty-object branch.
    expect(JSON.stringify(lastTouchedAt)).not.toMatch(/"anyOf":\s*\[[^\]]*\{\s*\}/);
  });
});
