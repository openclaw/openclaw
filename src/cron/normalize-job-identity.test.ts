import { describe, expect, it } from "vitest";
import { normalizeCronJobIdentityFields } from "./normalize-job-identity.js";

describe("normalizeCronJobIdentityFields", () => {
  it("copies trimmed jobId into id when id is missing", () => {
    const raw: Record<string, unknown> = {
      jobId: "  stable-slug  ",
      name: "n",
    };
    const r = normalizeCronJobIdentityFields(raw);
    expect(r.mutated).toBe(true);
    expect(r.legacyJobIdIssue).toBe(true);
    expect(raw.id).toBe("stable-slug");
    expect(raw.jobId).toBeUndefined();
  });

  it("trims id without reporting a legacy jobId issue when jobId is absent", () => {
    const raw: Record<string, unknown> = {
      id: "  trimmed-id  ",
      name: "n",
    };
    const r = normalizeCronJobIdentityFields(raw);
    expect(r.mutated).toBe(true);
    expect(r.legacyJobIdIssue).toBe(false);
    expect(raw.id).toBe("trimmed-id");
  });

  it("removes redundant jobId while keeping canonical id", () => {
    const raw: Record<string, unknown> = {
      id: "keep-me",
      jobId: "keep-me",
      name: "n",
    };
    const r = normalizeCronJobIdentityFields(raw);
    expect(r.mutated).toBe(true);
    expect(r.legacyJobIdIssue).toBe(true);
    expect(raw.id).toBe("keep-me");
    expect(raw.jobId).toBeUndefined();
  });

  it("ignores non-string jobId", () => {
    const raw: Record<string, unknown> = {
      id: "x",
      jobId: 1,
      name: "n",
    };
    const r = normalizeCronJobIdentityFields(raw);
    expect(r.mutated).toBe(true);
    expect(r.legacyJobIdIssue).toBe(true);
    expect(raw.id).toBe("x");
    expect(raw.jobId).toBeUndefined();
  });

  it("backfills a UUID when neither id nor legacy jobId is present (#72849)", () => {
    const raw: Record<string, unknown> = { name: "n" };
    const r = normalizeCronJobIdentityFields(raw);
    expect(r.mutated).toBe(true);
    expect(r.legacyJobIdIssue).toBe(false);
    expect(r.backfilledMissingId).toBe(true);
    expect(typeof raw.id).toBe("string");
    expect((raw.id as string).length).toBeGreaterThan(0);
    // Two backfills must produce distinct UUIDs so identity-based finds
    // cannot collide on a fresh load.
    const second: Record<string, unknown> = { name: "n2" };
    normalizeCronJobIdentityFields(second);
    expect(second.id).not.toBe(raw.id);
  });

  it("backfills a UUID when id is an empty string (#72849)", () => {
    const raw: Record<string, unknown> = { id: "   ", name: "n" };
    const r = normalizeCronJobIdentityFields(raw);
    expect(r.backfilledMissingId).toBe(true);
    expect(typeof raw.id).toBe("string");
    expect((raw.id as string).trim()).not.toBe("");
  });

  it("does not backfill when id is already set", () => {
    const raw: Record<string, unknown> = { id: "stable-id", name: "n" };
    const r = normalizeCronJobIdentityFields(raw);
    expect(r.backfilledMissingId).toBe(false);
    expect(raw.id).toBe("stable-id");
  });
});
