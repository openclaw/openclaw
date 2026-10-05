import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { writeExecApprovalsConfigRow } from "../../infra/exec-approvals-sqlite.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../../skills/runtime/session-snapshot.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { ensureSkillSnapshot } from "./session-updates.js";

// mock-isolation: Session classification reads are outside the approval SQL boundary.
vi.mock("../../agents/sandbox/runtime-status.js", () => ({
  resolveSandboxRuntimeStatus: () => ({ sandboxed: false, sandboxRequired: false }),
}));
// mock-isolation: Remote node discovery is outside the approval-read boundary.
vi.mock("../../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: () => undefined,
}));
// mock-isolation: Capture eligibility without filesystem scans or skill watchers.
vi.mock("../../skills/runtime/session-snapshot.js", () => ({
  resolveReusableWorkspaceSkillSnapshot: vi.fn(async () => ({
    snapshot: { prompt: "", skills: [] },
    shouldRefresh: false,
    snapshotVersion: 0,
  })),
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENCLAW_TEST_FAST", "0");
});

function prepare(root: string, config: OpenClawConfig) {
  return ensureSkillSnapshot({
    cfg: config,
    agentId: "main",
    sessionKey: "agent:main:exec-preparation",
    workspaceDir: path.join(root, "workspace"),
    isFirstTurnInSession: false,
  });
}

const config: OpenClawConfig = {
  tools: { exec: { host: "node", node: "build-node", mode: "full" } },
};

it("persists first-turn skills without caller-thread session SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:skill-persistence",
      storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
    };
    const sessionEntry = { sessionId: "skill-session", updatedAt: 1 };
    await replaceSessionEntry(scope, sessionEntry);
    const sql = observeHostDataSql();
    const result = await ensureSkillSnapshot({
      ...scope,
      cfg: {},
      sessionEntry,
      sessionStore: { [scope.sessionKey]: sessionEntry },
      sessionId: sessionEntry.sessionId,
      workspaceDir: state.statePath("workspace"),
      isFirstTurnInSession: true,
    }).finally(sql.restore);

    expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
    expect(result).toMatchObject({
      systemSent: true,
      sessionEntry: {
        sessionId: sessionEntry.sessionId,
        systemSent: true,
        skillsSnapshot: { prompt: "", skills: [] },
      },
    });
    expect(loadSessionEntry(scope)).toEqual(result.sessionEntry);
  });
});

it("prepares current skill eligibility without caller-thread approval SQL and retains its store", async () => {
  const root = tempDirs.make("openclaw-skill-exec-");
  const source = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  for (const security of ["full", "deny"] as const) {
    writeExecApprovalsConfigRow({ db: source.db, file: { version: 1, defaults: { security } } });
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const calls = observeMainThreadSql();
    const pending = prepare(root, config);
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-foreign-skill-exec-"));
    await pending;
    expect(
      vi.mocked(resolveReusableWorkspaceSkillSnapshot).mock.lastCall?.[0].resolveEligibility?.(),
    ).toMatchObject({ nodeSkills: { canExec: security === "full", node: "build-node" } });
    calls.expectIdle();
    calls.restore();
  }
});

it("does not advertise node skills after the approval worker read fails", async () => {
  const root = tempDirs.make("openclaw-skill-exec-failure-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const source = openOpenClawStateDatabase();
  writeExecApprovalsConfigRow({
    db: source.db,
    file: { version: 1, defaults: { security: "full" } },
  });
  vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockRejectedValue(
    new Error("synthetic approval reader unavailable"),
  );
  const calls = observeMainThreadSql();
  await prepare(root, config);
  expect(
    vi.mocked(resolveReusableWorkspaceSkillSnapshot).mock.lastCall?.[0].resolveEligibility?.(),
  ).toMatchObject({ nodeSkills: { canExec: false, node: "build-node" } });
  calls.expectIdle();
});
