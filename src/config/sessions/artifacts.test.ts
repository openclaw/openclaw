import { describe, expect, it } from "vitest";
import {
  formatSessionArchiveTimestamp,
  isCompactionCheckpointTranscriptFileName,
  isMigrationArchiveArtifactName,
  isPrimarySessionTranscriptFileName,
  isSessionArchiveArtifactName,
  isSessionStoreTempArtifactName,
  isTrajectorySessionArtifactName,
  parseUsageCountedSessionIdFromFileName,
  parseSessionArchiveTimestamp,
} from "./artifacts.js";

describe("session artifact helpers", () => {
  it("classifies archived artifact file names", () => {
    expect(isSessionArchiveArtifactName("abc.jsonl.deleted.2026-01-01T00-00-00.000Z")).toBe(true);
    expect(
      isSessionArchiveArtifactName(`abc.jsonl.deleted.2026-01-01T00-00-00.000Z.${"a".repeat(32)}`),
    ).toBe(true);
    expect(isSessionArchiveArtifactName("abc.jsonl.reset.2026-01-01T00-00-00.000Z")).toBe(true);
    expect(isSessionArchiveArtifactName("abc.jsonl.bak.2026-01-01T00-00-00.000Z")).toBe(true);
    expect(isSessionArchiveArtifactName("sessions.json.bak.1737420882")).toBe(true);
    expect(isSessionArchiveArtifactName("keep.deleted.keep.jsonl")).toBe(false);
    expect(isSessionArchiveArtifactName("abc.jsonl")).toBe(false);
  });

  it("classifies migration archive file names", () => {
    expect(isMigrationArchiveArtifactName("abc.jsonl.migrated")).toBe(true);
    expect(isMigrationArchiveArtifactName("sessions.json.migrated.2")).toBe(true);
    expect(isMigrationArchiveArtifactName("abc.jsonl.migrated.tmp")).toBe(false);
    expect(isMigrationArchiveArtifactName("abc.migrated.jsonl")).toBe(false);
    expect(isMigrationArchiveArtifactName("abc.jsonl.MIGRATED")).toBe(false);
  });

  it("classifies orphaned session store atomic-write temp files", () => {
    const uuid = "0f9c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
    const store = "sessions.json";
    // sessions.json.<pid>.<uuid>.tmp (current) and legacy sessions.json.<uuid>.tmp
    expect(isSessionStoreTempArtifactName(`sessions.json.12345.${uuid}.tmp`, store)).toBe(true);
    expect(isSessionStoreTempArtifactName(`sessions.json.${uuid}.tmp`, store)).toBe(true);
    // Never the live store, archives, transcripts, or unrelated temp files.
    expect(isSessionStoreTempArtifactName("sessions.json", store)).toBe(false);
    expect(isSessionStoreTempArtifactName("sessions.json.bak.1737420882", store)).toBe(false);
    expect(isSessionStoreTempArtifactName(`${uuid}.jsonl`, store)).toBe(false);
    expect(isSessionStoreTempArtifactName("sessions.json.tmp", store)).toBe(false);
    expect(isSessionStoreTempArtifactName("other.json.12345.tmp", store)).toBe(false);
    // Tracks a custom session.store filename (and only that store's temps); the
    // basename is regex-escaped so its dots are literal, not wildcards.
    expect(isSessionStoreTempArtifactName(`my-store.json.99.${uuid}.tmp`, "my-store.json")).toBe(
      true,
    );
    expect(isSessionStoreTempArtifactName(`my-store.json.99.${uuid}.tmp`, store)).toBe(false);
    expect(isSessionStoreTempArtifactName(`sessions.json.99.${uuid}.tmp`, "my-store.json")).toBe(
      false,
    );
    expect(isSessionStoreTempArtifactName(`sessionsXjson.99.${uuid}.tmp`, store)).toBe(false);
  });

  it("classifies primary transcript files", () => {
    expect(isPrimarySessionTranscriptFileName("abc.jsonl")).toBe(true);
    expect(isPrimarySessionTranscriptFileName("keep.deleted.keep.jsonl")).toBe(true);
    expect(
      isPrimarySessionTranscriptFileName(
        "abc.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
      ),
    ).toBe(false);
    expect(isPrimarySessionTranscriptFileName("abc.jsonl.deleted.2026-01-01T00-00-00.000Z")).toBe(
      false,
    );
    expect(isPrimarySessionTranscriptFileName("abc.trajectory.jsonl")).toBe(false);
    expect(isPrimarySessionTranscriptFileName("sessions.json")).toBe(false);
  });

  it("classifies trajectory sidecar artifacts", () => {
    expect(isTrajectorySessionArtifactName("abc.trajectory.jsonl")).toBe(true);
    expect(isTrajectorySessionArtifactName("abc.trajectory-path.json")).toBe(true);
    expect(isTrajectorySessionArtifactName("abc.jsonl")).toBe(false);
  });

  it("recognizes exact compaction checkpoint transcript names", () => {
    expect(
      isCompactionCheckpointTranscriptFileName(
        "abc.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
      ),
    ).toBe(true);
    expect(isCompactionCheckpointTranscriptFileName("abc.checkpoint.not-a-uuid.jsonl")).toBe(false);
  });

  it("parses usage-counted session ids from file names", () => {
    const stamp = "2026-01-01T00-00-00.000Z";
    const checkpoint = "abc.checkpoint.11111111-1111-4111-8111-111111111111.jsonl";
    const cases = [
      ["abc.jsonl", "abc"],
      [".jsonl", ""],
      ["keep.deleted.keep.jsonl", "keep.deleted.keep"],
      [`abc.jsonl.reset.${stamp}`, "abc"],
      [`abc.jsonl.deleted.${stamp}`, "abc"],
      [`abc.jsonl.deleted.${stamp}.${"a".repeat(32)}`, "abc"],
      [`abc.jsonl.reset.${stamp}.zst`, "abc"],
      [`abc.checkpoint.not-a-uuid.jsonl.deleted.${stamp}`, "abc.checkpoint.not-a-uuid"],
      [`abc.jsonl.bak.${stamp}`, null],
      [checkpoint, null],
      ["abc.trajectory.jsonl", null],
      [`abc.trajectory.jsonl.deleted.${stamp}`, null],
      [`abc.trajectory.jsonl.reset.${stamp}.zst`, null],
      [`${checkpoint}.reset.${stamp}.zst`, null],
      [`${checkpoint}.deleted.${stamp}.zst`, null],
      [`.jsonl.reset.${stamp}`, null],
      [`abc.jsonl.deleted.${stamp}.${"A".repeat(32)}`, null],
    ] as const;
    for (const [fileName, sessionId] of cases) {
      expect(parseUsageCountedSessionIdFromFileName(fileName), fileName).toBe(sessionId);
    }
  });

  it("formats and parses archive timestamps", () => {
    const now = Date.parse("2026-02-23T12:34:56.000Z");
    const stamp = formatSessionArchiveTimestamp(now);
    expect(stamp).toBe("2026-02-23T12-34-56.000Z");

    const file = `abc.jsonl.deleted.${stamp}`;
    expect(parseSessionArchiveTimestamp(file, "deleted")).toBe(now);
    expect(parseSessionArchiveTimestamp(`${file}.${"a".repeat(32)}`, "deleted")).toBe(now);
    expect(parseSessionArchiveTimestamp(file, "reset")).toBeNull();
    expect(parseSessionArchiveTimestamp("keep.deleted.keep.jsonl", "deleted")).toBeNull();
  });

  it("falls back instead of throwing for out-of-range archive timestamps", () => {
    expect(formatSessionArchiveTimestamp(Number.POSITIVE_INFINITY)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/,
    );
    expect(formatSessionArchiveTimestamp(9_000_000_000_000_000)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/,
    );
  });
});
