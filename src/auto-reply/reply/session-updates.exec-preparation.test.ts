import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { writeExecApprovalsConfigRow } from "../../infra/exec-approvals-sqlite.js";
import * as approvalStore from "../../infra/exec-approvals-store.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../../skills/runtime/session-snapshot.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { ensureSkillSnapshot } from "./session-updates.js";

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
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENCLAW_TEST_FAST", "0");
});

function prepare(root: string, config: OpenClawConfig, assertCurrent?: () => void) {
  return ensureSkillSnapshot({
    cfg: config,
    agentId: "main",
    sessionKey: "agent:main:exec-preparation",
    workspaceDir: path.join(root, "workspace"),
    isFirstTurnInSession: false,
    sessionEntry: {
      sessionId: "skill-exec",
      updatedAt: 1,
      skillsSnapshot: { prompt: "", skills: [] },
    },
    assertCurrent,
  });
}

const config: OpenClawConfig = {
  tools: { exec: { host: "node", node: "build-node", mode: "full" } },
};

it.each([false, true])(
  "persists first-turn skills only while the caller is current without caller-thread session SQL (revoked: %s)",
  async (revokeAtCommit) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:skill-persistence",
        storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
      };
      const sessionEntry = { sessionId: "skill-session", updatedAt: 1 };
      await replaceSessionEntry(scope, sessionEntry);
      const originalEntry = loadSessionEntry(scope);
      const sessionStore = { [scope.sessionKey]: sessionEntry };
      const controller = new AbortController();
      const refusal = new Error("skill caller retired before commit");
      let commitReached = false;
      if (revokeAtCommit) {
        const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
        vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
          (callback, attachment) =>
            createAdmission((request, grant) => {
              if (
                request.stage === "commit" &&
                isRecord(request.facts) &&
                isRecord(request.facts.publication) &&
                request.facts.publication.kind === "session-entry-patch-committed"
              ) {
                commitReached = true;
                controller.abort(refusal);
              }
              callback(request, grant);
            }, attachment),
        );
      }
      const sql = observeHostDataSql();
      const pending = ensureSkillSnapshot({
        ...scope,
        cfg: {},
        sessionEntry,
        sessionStore,
        sessionId: sessionEntry.sessionId,
        workspaceDir: state.statePath("workspace"),
        isFirstTurnInSession: true,
        assertCurrent: () => controller.signal.throwIfAborted(),
      }).finally(sql.restore);

      if (revokeAtCommit) {
        await expect(pending).rejects.toBe(refusal);
        expect(commitReached).toBe(true);
        expect(loadSessionEntry(scope)).toEqual(originalEntry);
        expect(sessionStore[scope.sessionKey]).toEqual(sessionEntry);
      } else {
        const result = await pending;
        expect(result).toMatchObject({
          systemSent: true,
          sessionEntry: {
            sessionId: sessionEntry.sessionId,
            systemSent: true,
            skillsSnapshot: { prompt: "", skills: [] },
          },
        });
        expect(loadSessionEntry(scope)).toEqual(result.sessionEntry);
      }
      expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
    });
  },
);

it("prepares current sandbox and approval skill eligibility without caller-thread SQL", async () => {
  const root = tempDirs.make("openclaw-skill-exec-");
  const source = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  const approvals = vi.spyOn(approvalStore, "loadExecApprovalsReadOnlyAsync");
  for (const [security, sandboxMode, canExec, approvalReads] of [
    ["full", "off", true, 1],
    ["full", undefined, false, 0],
    ["deny", "off", false, 1],
  ] as const) {
    writeExecApprovalsConfigRow({ db: source.db, file: { version: 1, defaults: { security } } });
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:exec-preparation" },
      { sessionId: "skill-exec", updatedAt: 1, sandboxMode },
    );
    approvals.mockClear();
    const calls = observeMainThreadSql();
    const pending = prepare(root, {
      agents: { defaults: { sandbox: { mode: "all" } } },
      tools: { exec: { host: "auto", node: "build-node", mode: "full" } },
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-foreign-skill-exec-"));
    await pending;
    expect(approvals).toHaveBeenCalledTimes(approvalReads);
    expect(
      vi.mocked(resolveReusableWorkspaceSkillSnapshot).mock.lastCall?.[0].resolveEligibility?.(),
    ).toMatchObject({ nodeSkills: { canExec, node: "build-node" } });
    calls.expectIdle();
    calls.restore();
  }
});

it.each(["approvals", "skills"] as const)(
  "refuses a skill snapshot when its caller closes during %s preparation",
  async (phase) => {
    const root = tempDirs.make("openclaw-skill-retired-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const controller = new AbortController();
    const wait = async () => {
      entered.resolve();
      await resume.promise;
    };
    if (phase === "approvals") {
      vi.spyOn(approvalStore, "loadExecApprovalsReadOnlyAsync").mockImplementationOnce(async () => {
        await wait();
        return { version: 1, defaults: { security: "full" } };
      });
    } else {
      vi.mocked(resolveReusableWorkspaceSkillSnapshot).mockImplementationOnce(async () => {
        await wait();
        return {
          snapshot: { prompt: "", skills: [] },
          shouldRefresh: false,
          snapshotVersion: 0,
        };
      });
    }
    const pending = prepare(root, config, () => controller.signal.throwIfAborted());
    await awaitGateBeforeSettlement(
      entered.promise,
      pending,
      "skill preparation did not reach its wait",
    );
    controller.abort(new Error("skill caller retired"));
    resume.resolve();
    await expect(pending).rejects.toThrow("skill caller retired");
    if (phase === "approvals") {
      expect(resolveReusableWorkspaceSkillSnapshot).not.toHaveBeenCalled();
    }
  },
);

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
