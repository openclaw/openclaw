import { describe, expect, it } from "vitest";
import { resolveTrajectoryFilePath, resolveTrajectoryPointerOpenFlags } from "./paths.js";

describe("trajectory legacy path helpers", () => {
  it("resolves a session-adjacent trajectory file by default", () => {
    expect(
      resolveTrajectoryFilePath({
        transcriptLocator: "/tmp/session.jsonl",
        sessionId: "session-1",
      }),
    ).toBe("/tmp/session.trajectory.jsonl");
  });

  it("sanitizes session ids when resolving an override directory", () => {
    expect(
      resolveTrajectoryFilePath({
        env: { OPENCLAW_TRAJECTORY_DIR: "/tmp/traces" },
        sessionId: "../evil/session",
      }),
    ).toBe("/tmp/traces/___evil_session.jsonl");
  });

  it("keeps pointer write flags usable when O_NOFOLLOW is unavailable", () => {
    expect(
      resolveTrajectoryPointerOpenFlags({
        O_CREAT: 0x01,
        O_TRUNC: 0x02,
        O_WRONLY: 0x04,
      }),
    ).toBe(0x07);
  });
});
