import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveDoctorSessionSqliteTargets } from "./doctor-session-sqlite-targets.js";

describe("doctor session sqlite explicit store owner", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("uses the requested agent when an explicit store path is supplied", () => {
    const root = tempDirs.make("openclaw-doctor-agent-");
    const store = path.join(root, "sessions.json");
    const report = resolveDoctorSessionSqliteTargets({
      mode: "inspect",
      store,
      agent: "other",
      cfg: { agents: { entries: { main: { default: true }, other: {} } } },
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
    });
    expect(report.targets).toHaveLength(1);
    expect(report.targets[0]?.agentId).toBe("other");
  });
});
