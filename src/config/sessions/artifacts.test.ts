import { describe, expect, it } from "vitest";
import {
  formatFilesystemTimestamp,
  isCompactionCheckpointTranscriptFileName,
  isPrimarySessionTranscriptFileName,
  isTrajectoryPointerArtifactName,
  isTrajectoryRuntimeArtifactName,
  isTrajectorySessionArtifactName,
  isUsageCountedSessionTranscriptFileName,
  parseCompactionCheckpointTranscriptFileName,
  parseUsageCountedSessionIdFromFileName,
} from "./artifacts.js";

describe("session artifact helpers", () => {
  it("classifies primary transcript files", () => {
    expect(isPrimarySessionTranscriptFileName("abc.jsonl")).toBe(true);
    expect(isPrimarySessionTranscriptFileName("keep.deleted.keep.jsonl")).toBe(true);
    expect(
      isPrimarySessionTranscriptFileName(
        "abc.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
      ),
    ).toBe(false);
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
      isUsageCountedSessionTranscriptFileName(
        "abc.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
      ),
    ).toBe(false);
    expect(isUsageCountedSessionTranscriptFileName("abc.trajectory.jsonl")).toBe(false);
  });

  it("parses usage-counted session ids from file names", () => {
    expect(parseUsageCountedSessionIdFromFileName("abc.jsonl")).toBe("abc");
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
  });

  it("formats filesystem timestamps", () => {
    const now = Date.parse("2026-02-23T12:34:56.000Z");
    expect(formatFilesystemTimestamp(now)).toBe("2026-02-23T12-34-56.000Z");
  });
});
