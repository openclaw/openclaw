import { describe, expect, it } from "vitest";
import {
  ArtifactRecordSchema,
  buildArtifactRecordFromMeta,
  safeValidateArtifactRecord,
  validateArtifactRecord,
} from "./artifact-record.js";

const VALID_SHA256 = "a".repeat(64);

const VALID_RECORD = {
  artifact_id: VALID_SHA256,
  type: "code",
  content_uri: "file:///tmp/artifacts/aa/aaa",
  content_hash: VALID_SHA256,
  size_bytes: 1024,
  created_at: "2026-02-06T12:00:00.000Z",
  producer: "dispatcher",
  summary: "Main entry point",
  mime: "text/plain",
};

describe("ArtifactRecord schema", () => {
  it("validates a well-formed record", () => {
    const result = validateArtifactRecord(VALID_RECORD);
    expect(result.artifact_id).toBe(VALID_SHA256);
    expect(result.type).toBe("code");
    expect(result.producer).toBe("dispatcher");
  });

  it("defaults producer to system when omitted", () => {
    const { producer, ...rest } = VALID_RECORD;
    const result = validateArtifactRecord(rest);
    expect(result.producer).toBe("system");
  });

  it("rejects invalid artifact_id (not hex)", () => {
    expect(() =>
      validateArtifactRecord({ ...VALID_RECORD, artifact_id: "ZZZZ" + "a".repeat(60) }),
    ).toThrow(/artifact_id/);
  });

  it("rejects invalid artifact_id (wrong length)", () => {
    expect(() => validateArtifactRecord({ ...VALID_RECORD, artifact_id: "a".repeat(32) })).toThrow(
      /artifact_id/,
    );
  });

  it("rejects invalid type", () => {
    expect(() => validateArtifactRecord({ ...VALID_RECORD, type: "video" })).toThrow();
  });

  it("rejects negative size_bytes", () => {
    expect(() => validateArtifactRecord({ ...VALID_RECORD, size_bytes: -10 })).toThrow();
  });

  it("rejects extra keys (strict mode)", () => {
    expect(() => validateArtifactRecord({ ...VALID_RECORD, bogus_field: "nope" })).toThrow();
  });

  it("allows optional summary and mime to be absent", () => {
    const { summary, mime, ...rest } = VALID_RECORD;
    const result = validateArtifactRecord(rest);
    expect(result.summary).toBeUndefined();
    expect(result.mime).toBeUndefined();
  });

  it("rejects summary > 500 chars", () => {
    expect(() => validateArtifactRecord({ ...VALID_RECORD, summary: "x".repeat(501) })).toThrow();
  });

  it("accepts all valid artifact types", () => {
    for (const type of ["code", "doc", "data", "log", "plan", "result", "repo"]) {
      const result = validateArtifactRecord({ ...VALID_RECORD, type });
      expect(result.type).toBe(type);
    }
  });

  it("accepts all valid producer types", () => {
    for (const producer of ["dispatcher", "executor", "planner", "system"]) {
      const result = validateArtifactRecord({ ...VALID_RECORD, producer });
      expect(result.producer).toBe(producer);
    }
  });
});

describe("safeValidateArtifactRecord", () => {
  it("returns success for valid input", () => {
    const result = safeValidateArtifactRecord(VALID_RECORD);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.artifact_id).toBe(VALID_SHA256);
    }
  });

  it("returns failure with readable error for invalid input", () => {
    const result = safeValidateArtifactRecord({ ...VALID_RECORD, artifact_id: "bad" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("artifact_id");
    }
  });

  it("returns failure for null input", () => {
    const result = safeValidateArtifactRecord(null);
    expect(result.success).toBe(false);
  });
});

describe("buildArtifactRecordFromMeta", () => {
  it("converts ArtifactMeta to ArtifactRecord", () => {
    const meta = {
      id: VALID_SHA256,
      mime: "text/plain",
      createdAt: "2026-02-06T12:00:00.000Z",
      sha256: VALID_SHA256,
      sizeBytes: 512,
    };
    const record = buildArtifactRecordFromMeta({
      meta,
      storageUri: "file:///tmp/artifacts/aa/aaa",
      type: "doc",
      producer: "planner",
      summary: "A plan doc",
    });
    expect(record.artifact_id).toBe(VALID_SHA256);
    expect(record.type).toBe("doc");
    expect(record.producer).toBe("planner");
    expect(record.content_uri).toBe("file:///tmp/artifacts/aa/aaa");
    expect(record.size_bytes).toBe(512);
  });

  it("defaults producer to system", () => {
    const meta = {
      id: VALID_SHA256,
      mime: "application/json",
      createdAt: "2026-02-06T12:00:00.000Z",
      sha256: VALID_SHA256,
      sizeBytes: 100,
    };
    const record = buildArtifactRecordFromMeta({
      meta,
      storageUri: "file:///tmp/test",
      type: "data",
    });
    expect(record.producer).toBe("system");
  });
});
