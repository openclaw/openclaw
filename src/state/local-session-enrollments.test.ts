import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  createLocalSessionEnrollment,
  listLocalSessionEnrollments,
  listLocalSessionExclusions,
  setLocalSessionExclusion,
  transitionLocalSessionEnrollment,
} from "./local-session-enrollments.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const input = {
  ownerProfileId: "profile-alice",
  ownerLabel: "Alice",
  deviceId: "device-1",
  pluginId: "codex",
  sourceId: "codex",
  agentId: "main",
};

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("local session enrollments", () => {
  it("keeps one live enrollment per device and source", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "local-session-enrollments-"));
    const first = createLocalSessionEnrollment(input);
    const second = createLocalSessionEnrollment({ ...input, ownerProfileId: "profile-bob" });
    const rows = listLocalSessionEnrollments({ deviceId: "device-1", sourceId: "codex" });
    expect(rows.map((row) => [row.enrollmentId, row.state])).toEqual([
      [second.enrollmentId, "pending"],
      [first.enrollmentId, "revoked"],
    ]);
  });

  it("activates only from pending and treats later transitions as terminal", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "local-session-enrollments-"));
    const created = createLocalSessionEnrollment(input);
    const active = transitionLocalSessionEnrollment({
      enrollmentId: created.enrollmentId,
      to: "active",
    });
    expect(active?.state).toBe("active");
    expect(active?.confirmedAtMs).toBeTypeOf("number");
    const revoked = transitionLocalSessionEnrollment({
      enrollmentId: created.enrollmentId,
      to: "revoked",
      reason: "stopped",
    });
    expect(revoked).toMatchObject({ state: "revoked", reason: "stopped" });
    // A revoked row cannot be re-activated by a late device consent.
    expect(
      transitionLocalSessionEnrollment({ enrollmentId: created.enrollmentId, to: "active" })?.state,
    ).toBe("revoked");
    expect(transitionLocalSessionEnrollment({ enrollmentId: "missing", to: "active" })).toBe(
      undefined,
    );
  });

  it("refuses a late acceptance and records the offer as expired", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "local-session-enrollments-"));
    const created = createLocalSessionEnrollment(input);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(created.expiresAtMs + 1);
      const late = transitionLocalSessionEnrollment({
        enrollmentId: created.enrollmentId,
        to: "active",
      });
      expect(late).toMatchObject({ state: "expired", reason: "offer expired" });
      expect(listLocalSessionEnrollments({ deviceId: "device-1" }).map((row) => row.state)).toEqual(
        ["expired"],
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("stores per-thread exclusions independently of enrollment rows", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "local-session-enrollments-"));
    setLocalSessionExclusion({
      deviceId: "device-1",
      sourceId: "codex",
      threadId: "thread-a",
      excluded: true,
      byProfileId: "profile-alice",
    });
    setLocalSessionExclusion({
      deviceId: "device-1",
      sourceId: "codex",
      threadId: "thread-a",
      excluded: true,
      byProfileId: "profile-alice",
    });
    expect(listLocalSessionExclusions({ deviceId: "device-1", sourceId: "codex" })).toEqual([
      "thread-a",
    ]);
    setLocalSessionExclusion({
      deviceId: "device-1",
      sourceId: "codex",
      threadId: "thread-a",
      excluded: false,
      byProfileId: "profile-alice",
    });
    expect(listLocalSessionExclusions({ deviceId: "device-1", sourceId: "codex" })).toEqual([]);
  });
});
