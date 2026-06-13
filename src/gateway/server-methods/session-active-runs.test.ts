// Session active-run projection tests cover the display-only stale status
// derived for sessions.list rows that claim to be running without any live
// run evidence in this gateway process.
import { describe, expect, it } from "vitest";
import { projectSessionRowRunStatus, STALE_SESSION_ROW_GRACE_MS } from "./session-active-runs.js";

const NOW = 1_750_000_000_000;
const OLD_UPDATED_AT = NOW - STALE_SESSION_ROW_GRACE_MS - 1;

type ProjectionRow = Parameters<typeof projectSessionRowRunStatus>[0]["row"];

function project(overrides: {
  row?: Partial<ProjectionRow>;
  hasActiveRun?: boolean;
  activeIds?: string[];
  activeKeys?: string[];
  now?: number;
}) {
  return projectSessionRowRunStatus({
    row: {
      key: "agent:main:subagent:abc",
      sessionId: "sess-1",
      status: "running",
      updatedAt: OLD_UPDATED_AT,
      ...overrides.row,
    },
    hasActiveRun: overrides.hasActiveRun ?? false,
    activeEmbeddedRunSessionIds: new Set(overrides.activeIds ?? []),
    activeEmbeddedRunSessionKeys: new Set(overrides.activeKeys ?? []),
    now: overrides.now ?? NOW,
  });
}

describe("projectSessionRowRunStatus", () => {
  it("projects stale for a running row with no live run evidence", () => {
    expect(project({})).toBe("stale");
  });

  it("keeps non-running statuses unchanged", () => {
    expect(project({ row: { status: "done" } })).toBe("done");
    expect(project({ row: { status: "blocked" } })).toBe("blocked");
    expect(project({ row: { status: undefined } })).toBeUndefined();
  });

  it("keeps running rows with a Control UI-visible active run", () => {
    expect(project({ hasActiveRun: true })).toBe("running");
  });

  it("keeps running rows whose sessionId has an active embedded run", () => {
    expect(project({ activeIds: ["sess-1"] })).toBe("running");
  });

  it("keeps running rows whose key has an active embedded run", () => {
    expect(project({ activeKeys: ["agent:main:subagent:abc"] })).toBe("running");
  });

  it("keeps running rows with a live subagent registry run", () => {
    expect(project({ row: { subagentRunState: "active" } })).toBe("running");
    expect(project({ row: { hasActiveSubagentRun: true } })).toBe("running");
  });

  it("treats interrupted subagent registry rows as stale candidates", () => {
    expect(project({ row: { subagentRunState: "interrupted" } })).toBe("stale");
  });

  it("keeps ACP session rows running because their runs can live out of process", () => {
    expect(project({ row: { key: "acp:client:1" } })).toBe("running");
  });

  it("keeps freshly updated rows running during the grace window", () => {
    expect(project({ row: { updatedAt: NOW - 1_000 } })).toBe("running");
  });

  it("keeps rows without a usable updatedAt running", () => {
    expect(project({ row: { updatedAt: null } })).toBe("running");
  });
});
