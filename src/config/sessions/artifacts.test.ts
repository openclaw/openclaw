import { describe, expect, it } from "vitest";
import {
  formatSessionArchiveTimestamp,
  isCompactionCheckpointTranscriptFileName,
  isCheckpointSessionTranscriptFileName,
  isPrimarySessionTranscriptFileName,
  isSessionArchiveArtifactName,
  isTrajectoryPointerArtifactName,
  isTrajectoryRuntimeArtifactName,
  isTrajectorySessionArtifactName,
  isUsageCountedSessionTranscriptFileName,
  parseCompactionCheckpointTranscriptFileName,
  parseParentSessionIdFromCheckpointFileName,
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
    expect(
      isPrimarySessionTranscriptFileName(
        "e417ba9b-8043-43db-8d18-d88f1823567d.checkpoint.21901ee7-8f22-4d07-9e39-6eaf7b224630.jsonl",
      ),
    ).toBe(false);
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
    ).toBe(true);
    expect(isUsageCountedSessionTranscriptFileName("abc.trajectory.jsonl")).toBe(false);
    expect(
      isUsageCountedSessionTranscriptFileName(
        "e417ba9b-8043-43db-8d18-d88f1823567d.checkpoint.21901ee7-8f22-4d07-9e39-6eaf7b224630.jsonl",
      ),
    ).toBe(true);
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
    ).toBe("abc");
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

  it("classifies checkpoint transcript files and extracts parent session id", () => {
    const parent = "e417ba9b-8043-43db-8d18-d88f1823567d";
    const ckp = "21901ee7-8f22-4d07-9e39-6eaf7b224630";

    // Positive: well-formed checkpoint sibling.
    expect(isCheckpointSessionTranscriptFileName(`${parent}.checkpoint.${ckp}.jsonl`)).toBe(true);
    expect(parseParentSessionIdFromCheckpointFileName(`${parent}.checkpoint.${ckp}.jsonl`)).toBe(
      parent,
    );

    // Negative: primary, archive, non-uuid suffix, or substring matches.
    expect(isCheckpointSessionTranscriptFileName(`${parent}.jsonl`)).toBe(false);
    expect(
      isCheckpointSessionTranscriptFileName(`${parent}.jsonl.deleted.2026-01-01T00-00-00.000Z`),
    ).toBe(false);
    // Substring contains "checkpoint" but is missing the UUID shape — must not dedup.
    expect(isCheckpointSessionTranscriptFileName("my-checkpoint-review-session.jsonl")).toBe(false);
    expect(parseParentSessionIdFromCheckpointFileName("my-checkpoint-review-session.jsonl")).toBe(
      null,
    );
    // Shape looks close but the trailing UUID segment is malformed.
    expect(isCheckpointSessionTranscriptFileName(`${parent}.checkpoint.not-a-uuid.jsonl`)).toBe(
      false,
    );
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
});
