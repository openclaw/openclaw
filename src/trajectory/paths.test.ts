import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTrajectoryFilePath } from "./paths.js";

describe("trajectory path helpers", () => {
  it("resolves a session-scoped trajectory export file by default", () => {
    expect(
      resolveTrajectoryFilePath({
        sessionId: "session-1",
      }),
    ).toBe(path.join(process.cwd(), "session-1.jsonl"));
  });

  it("sanitizes session ids when resolving an override directory", () => {
    expect(
      resolveTrajectoryFilePath({
        env: { OPENCLAW_TRAJECTORY_DIR: "/tmp/traces" },
        sessionId: "../evil/session",
      }),
    ).toBe("/tmp/traces/___evil_session.jsonl");
  });
});
