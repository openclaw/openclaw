import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  createLocalSessionConnectIntent,
  createLocalSessionEnrollment,
  listLocalSessionEnrollments,
} from "../../state/local-session-enrollments.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { activateLocalSessionConnectIntentForDevice } from "./connect-intent.js";

vi.mock("./bridge.js", () => ({
  listRegisteredLocalSessionSources: () => [
    {
      pluginId: "codex",
      sourceId: "codex",
      label: "Codex",
      command: "codex.localSessions.source.v1",
    },
  ],
  getLocalSessionBridge: () => undefined,
}));

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

function mintIntent(owner: { ownerProfileId: string; ownerLabel: string }, setupId: string) {
  createLocalSessionConnectIntent({
    setupId,
    ...owner,
    agentId: "main",
    sourceIds: ["codex"],
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 600_000,
  });
}

describe("connect-link activation", () => {
  it("does not take over a source someone else shares from the same device", () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "connect-intent-"));
    openOpenClawStateDatabase();
    const bobs = createLocalSessionEnrollment({
      ownerProfileId: "bob",
      ownerLabel: "Bob",
      deviceId: "device-1",
      pluginId: "codex",
      sourceId: "codex",
      agentId: "main",
    });
    mintIntent({ ownerProfileId: "alice", ownerLabel: "Alice" }, "setup-alice");
    const broadcast = vi.fn();
    activateLocalSessionConnectIntentForDevice({
      setupId: "setup-alice",
      deviceId: "device-1",
      broadcast,
    });
    expect(broadcast).not.toHaveBeenCalled();
    expect(
      listLocalSessionEnrollments({ deviceId: "device-1" }).map((row) => [
        row.enrollmentId,
        row.ownerProfileId,
        row.state,
      ]),
    ).toEqual([[bobs.enrollmentId, "bob", "pending"]]);
  });

  it("does not move the redeeming person's own share to another agent", () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "connect-intent-"));
    openOpenClawStateDatabase();
    createLocalSessionEnrollment({
      ownerProfileId: "alice",
      ownerLabel: "Alice",
      deviceId: "device-1",
      pluginId: "codex",
      sourceId: "codex",
      agentId: "review",
    });
    mintIntent({ ownerProfileId: "alice", ownerLabel: "Alice" }, "setup-alice-3");
    const broadcast = vi.fn();
    activateLocalSessionConnectIntentForDevice({
      setupId: "setup-alice-3",
      deviceId: "device-1",
      broadcast,
    });
    expect(broadcast).not.toHaveBeenCalled();
    expect(
      listLocalSessionEnrollments({ deviceId: "device-1" }).map((row) => [row.agentId, row.state]),
    ).toEqual([["review", "pending"]]);
  });

  it("replaces the redeeming person's own earlier share", () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "connect-intent-"));
    openOpenClawStateDatabase();
    createLocalSessionEnrollment({
      ownerProfileId: "alice",
      ownerLabel: "Alice",
      deviceId: "device-1",
      pluginId: "codex",
      sourceId: "codex",
      agentId: "main",
    });
    mintIntent({ ownerProfileId: "alice", ownerLabel: "Alice" }, "setup-alice-2");
    const broadcast = vi.fn();
    activateLocalSessionConnectIntentForDevice({
      setupId: "setup-alice-2",
      deviceId: "device-1",
      broadcast,
    });
    expect(broadcast).toHaveBeenCalledOnce();
    expect(
      listLocalSessionEnrollments({ deviceId: "device-1" })
        .map((row) => row.state)
        .toSorted(),
    ).toEqual(["pending", "revoked"]);
  });
});
