import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { writeExecApprovalsConfigRow } from "../../infra/exec-approvals-sqlite.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../../skills/runtime/session-snapshot.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { ensureSkillSnapshot } from "./session-updates.js";

// Session classification belongs to the session reader; this boundary covers approval SQL.
vi.mock("../../agents/sandbox/runtime-status.js", () => ({
  resolveSandboxRuntimeStatus: () => ({ sandboxed: false, sandboxRequired: false }),
}));
vi.mock("../../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: () => undefined,
}));
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
