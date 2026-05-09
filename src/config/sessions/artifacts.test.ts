import { describe, expect, it } from "vitest";
import {
  formatFilesystemTimestamp,
  isCompactionCheckpointTranscriptFileName,
  isTrajectoryPointerArtifactName,
  isTrajectoryRuntimeArtifactName,
  isTrajectorySessionArtifactName,
  parseCompactionCheckpointTranscriptFileName,
} from "./artifacts.js";

describe("session artifact helpers", () => {
  it("classifies trajectory sidecar artifacts", () => {
    expect(isTrajectoryRuntimeArtifactName("abc.trajectory.jsonl")).toBe(true);
    expect(isTrajectoryPointerArtifactName("abc.trajectory-path.json")).toBe(true);
    expect(isTrajectorySessionArtifactName("abc.trajectory.jsonl")).toBe(true);
    expect(isTrajectorySessionArtifactName("abc.trajectory-path.json")).toBe(true);
    expect(isTrajectorySessionArtifactName("abc.jsonl")).toBe(false);
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
