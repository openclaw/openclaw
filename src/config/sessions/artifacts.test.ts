import { describe, expect, it } from "vitest";
import {
  formatSessionArchiveTimestamp,
  isCompactionCheckpointTranscriptFileName,
  isOrphanedSessionTmpFileName,
  isPrimarySessionTranscriptFileName,
  isSessionArchiveArtifactName,
  isTrajectoryPointerArtifactName,
  isTrajectoryRuntimeArtifactName,
  isTrajectorySessionArtifactName,
  isUsageCountedSessionTranscriptFileName,
  parseCompactionCheckpointTranscriptFileName,
  parseUsageCountedSessionIdFromFileName,
  parseSessionArchiveTimestamp,
} from "./artifacts.js";

describe("session artifact helpers", () => {
  it("classifies archived artifact file names", () => {
    expect(isSessionArchiveArtifactName("abc.jsonl.deleted.2026-01-01T00-00-00.000Z")).toBe(true);
    expect(isSessionArchiveArtifactName("abc.jsonl.reset.2026-01-01T00-00-00.000Z")).toBe(true);
    expect(isSessionArchiveArtifactName("abc.jsonl.bak.2026-01-01T00-00-00.000Z")).toBe(true);
    expect(isSessionArchiveArtifactName("sessions.json.bak.1737420882")).toBe(true);
    expect(isSessionArchiveArtifactName("keep.deleted.keep.jsonl")).toBe(false);
    expect(isSessionArchiveArtifactName("abc.jsonl")).toBe(false);
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
    expect(isTrajectoryRuntimeArtifactName("abc.trajectory.jsonl")).toBe(true);
    expect(isTrajectoryPointerArtifactName("abc.trajectory-path.json")).toBe(true);
    expect(isTrajectorySessionArtifactName("abc.trajectory.jsonl")).toBe(true);
    expect(isTrajectorySessionArtifactName("abc.trajectory-path.json")).toBe(true);
    expect(isTrajectorySessionArtifactName("abc.jsonl")).toBe(false);
  });

  it("classifies usage-counted transcript files", () => {
    expect(isUsageCountedSessionTranscriptFileName("abc.jsonl")).toBe(true);
    expect(
      isUsageCountedSessionTranscriptFileName("abc.jsonl.reset.2026-01-01T00-00-00.000Z"),
    ).toBe(true);
    expect(
      isUsageCountedSessionTranscriptFileName("abc.jsonl.deleted.2026-01-01T00-00-00.000Z"),
    ).toBe(true);
    expect(isUsageCountedSessionTranscriptFileName("abc.jsonl.bak.2026-01-01T00-00-00.000Z")).toBe(
      false,
    );
    expect(
      isUsageCountedSessionTranscriptFileName(
        "abc.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
      ),
    ).toBe(false);
    expect(isUsageCountedSessionTranscriptFileName("abc.trajectory.jsonl")).toBe(false);
  });

  it("parses usage-counted session ids from file names", () => {
    expect(parseUsageCountedSessionIdFromFileName("abc.jsonl")).toBe("abc");
    expect(parseUsageCountedSessionIdFromFileName("abc.jsonl.reset.2026-01-01T00-00-00.000Z")).toBe(
      "abc",
    );
    expect(
      parseUsageCountedSessionIdFromFileName("abc.jsonl.deleted.2026-01-01T00-00-00.000Z"),
    ).toBe("abc");
    expect(parseUsageCountedSessionIdFromFileName("abc.jsonl.bak.2026-01-01T00-00-00.000Z")).toBe(
      null,
    );
    expect(
      parseUsageCountedSessionIdFromFileName(
        "abc.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
      ),
    ).toBeNull();
    expect(parseUsageCountedSessionIdFromFileName("abc.trajectory.jsonl")).toBeNull();
  });

  it("parses exact compaction checkpoint transcript file names", () => {
    expect(
      parseCompactionCheckpointTranscriptFileName(
        "abc.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
      ),
    ).toEqual({
      sessionId: "abc",
      checkpointId: "11111111-1111-4111-8111-111111111111",
    });
    expect(isCompactionCheckpointTranscriptFileName("abc.checkpoint.not-a-uuid.jsonl")).toBe(false);
    expect(
      isCompactionCheckpointTranscriptFileName(
        "abc.checkpoint.11111111-1111-4111-8111-111111111111.jsonl.deleted.2026-01-01T00-00-00.000Z",
      ),
    ).toBe(false);
  });

  it("formats and parses archive timestamps", () => {
    const now = Date.parse("2026-02-23T12:34:56.000Z");
    const stamp = formatSessionArchiveTimestamp(now);
    expect(stamp).toBe("2026-02-23T12-34-56.000Z");

    const file = `abc.jsonl.deleted.${stamp}`;
    expect(parseSessionArchiveTimestamp(file, "deleted")).toBe(now);
    expect(parseSessionArchiveTimestamp(file, "reset")).toBeNull();
    expect(parseSessionArchiveTimestamp("keep.deleted.keep.jsonl", "deleted")).toBeNull();
  });

  it("detects orphaned .tmp files from writeTextAtomic", () => {
    expect(
      isOrphanedSessionTmpFileName("sessions.json.550e8400-e29b-41d4-a716-446655440000.tmp"),
    ).toBe(true);
    expect(isOrphanedSessionTmpFileName("abc.jsonl.a1b2c3d4-e5f6-7890-abcd-ef1234567890.tmp")).toBe(
      true,
    );
    // Bare .tmp without UUID — not an orphan from writeTextAtomic.
    expect(isOrphanedSessionTmpFileName("foo.tmp")).toBe(false);
    expect(isOrphanedSessionTmpFileName("foo.bar.tmp")).toBe(false);
    // Normal session files are not tmp artifacts.
    expect(isOrphanedSessionTmpFileName("abc.jsonl")).toBe(false);
    expect(isOrphanedSessionTmpFileName("sessions.json")).toBe(false);
  });
});
