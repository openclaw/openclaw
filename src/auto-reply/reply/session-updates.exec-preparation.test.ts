import { randomUUID } from "node:crypto";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  applySessionEntryLifecycleMutation,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as sessionReaders from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { writeExecApprovalsConfigRow } from "../../infra/exec-approvals-sqlite.js";
import * as approvalStore from "../../infra/exec-approvals-store.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../../skills/runtime/session-snapshot.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createReplySessionEntryHandle } from "./session-entry-handle.js";
import { ensureSkillSnapshot, incrementCompactionCount } from "./session-updates.js";

// mock-isolation: Remote node discovery is outside the approval-read boundary.
vi.mock("../../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: () => undefined,
}));
// mock-isolation: Capture eligibility without filesystem scans or skill watchers.
vi.mock("../../skills/runtime/session-snapshot.js", () => ({
  resolveReusableWorkspaceSkillSnapshot: vi.fn(async () => ({
    snapshot: { prompt: "", skills: [] },
    shouldRefresh: false,
  })),
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENCLAW_TEST_FAST", "0");
  setRuntimeConfigSnapshot(config);
});

function prepare(
  root: string,
  config: OpenClawConfig,
  assertCurrent?: () => void,
  reader?: SessionEntryCohortReader,
) {
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
    reader,
  });
}

async function admitSkillSession(root: string, patch: Partial<InternalSessionEntry> = {}) {
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const scope = { agentId: "main", sessionKey: "agent:main:exec-preparation" };
  await upsertSessionEntryCore(scope, { sessionId: "skill-exec", updatedAt: 1, ...patch });
  const { databaseClaim } = await loadSessionEntryForAdmission(scope);
  if (!("kind" in databaseClaim) || !databaseClaim.reader) {
    await databaseClaim.release();
    throw new Error("Expected the admitted skill session reader");
  }
  return { scope, databaseClaim, reader: databaseClaim.reader };
}

function preparationGate(phase: "approvals" | "skills") {
  const entered = createDeferredCore();
  const resume = createDeferredCore();
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
      return { snapshot: { prompt: "", skills: [] }, shouldRefresh: false };
    });
  }
  return { entered, resume };
}

const config: OpenClawConfig = {
  tools: { exec: { host: "node", node: "build-node", mode: "full" } },
};

it.each([false, true])(
  "persists first-turn skills only while the caller is current without caller-thread session SQL (revoked: %s)",
  async (revokeAtCommit) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
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
        probe.admission(workerAdmission, (request, grant, callback) => {
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
        });
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
  const executionConfig: OpenClawConfig = {
    agents: { defaults: { sandbox: { mode: "all" } } },
    tools: { exec: { host: "auto", node: "build-node", mode: "full" } },
  };
  const source = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  const approvals = vi.spyOn(approvalStore, "loadExecApprovalsReadOnlyAsync");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  setRuntimeConfigSnapshot(executionConfig);
  const { databaseClaim, reader } = await admitSkillSession(root);
  const standalone = vi.spyOn(sessionReaders, "withSessionEntriesFromStoreInWorker");
  try {
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
      const pending = prepare(root, executionConfig, undefined, reader);
      vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-foreign-skill-exec-"));
      await pending;
      expect(approvals).toHaveBeenCalledTimes(approvalReads);
      expect(
        vi.mocked(resolveReusableWorkspaceSkillSnapshot).mock.lastCall?.[0].resolveEligibility?.(),
      ).toMatchObject({ nodeSkills: { canExec, node: "build-node" } });
      calls.expectIdle();
      calls.restore();
    }
    expect(standalone).not.toHaveBeenCalled();
  } finally {
    standalone.mockRestore();
    await databaseClaim.release();
  }
});

it.each([true, false])("refreshes only owned skill fields (first turn: %s)", async (firstTurn) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:skill-cohort",
      storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
    };
    const entry = {
      sessionId: "skill-cohort",
      lifecycleRevision: "original",
      updatedAt: 1,
      pinnedAt: 1,
      modelOverride: "gpt-5.5",
      label: "Before rename",
      skillsSnapshot: { prompt: "prepared skills", skills: [] },
    };
    await replaceSessionEntry(scope, entry);
    const { databaseClaim } = await loadSessionEntryForAdmission(scope);
    if (!("kind" in databaseClaim) || !databaseClaim.reader) {
      await databaseClaim.release();
      throw new Error("Expected an admitted skill reader");
    }
    const reader = databaseClaim.reader;
    const handle = createReplySessionEntryHandle({
      sessionKey: scope.sessionKey,
      sessionEntry: entry,
    });
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const skillsSnapshot = { prompt: "refreshed skills", skills: [] };
    vi.mocked(resolveReusableWorkspaceSkillSnapshot).mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return { snapshot: skillsSnapshot, shouldRefresh: true };
    });
    const pending = ensureSkillSnapshot({
      ...scope,
      cfg: {},
      workspaceDir: state.statePath("workspace"),
      isFirstTurnInSession: firstTurn,
      sessionEntry: entry,
      sessionEntryHandle: handle,
      reader,
    });
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "skill preparation did not start");
      await replaceSessionEntry(scope, {
        ...entry,
        pinnedAt: undefined,
        updatedAt: 2,
        systemSent: !firstTurn,
        modelOverride: "sonnet-4.6",
        label: "After rename",
        sendPolicy: "deny",
      });
      resume.resolve();
      const result = await pending;
      expect(result).toMatchObject({
        systemSent: true,
        skillsSnapshot,
        sessionEntry: {
          sessionId: entry.sessionId,
          updatedAt: expect.any(Number),
          systemSent: true,
          skillsSnapshot,
          modelOverride: "sonnet-4.6",
          label: "After rename",
          sendPolicy: "deny",
        },
      });
      expect(result.sessionEntry).not.toHaveProperty("pinnedAt");
      expect(handle.getCurrent()).toEqual(result.sessionEntry);
      expect(loadSessionEntry(scope)).toMatchObject({ skillsSnapshot, systemSent: true });
    } finally {
      resume.resolve();
      await Promise.allSettled([pending, databaseClaim.release()]);
    }
  });
});

it.each([
  ["reader", "approvals"],
  ["policy", "approvals"],
  ["policy", "skills"],
  ["caller", "approvals"],
  ["caller", "skills"],
] as const)("refuses eligibility when %s retires during %s preparation", async (retired, phase) => {
  const root = tempDirs.make("openclaw-skill-retired-");
  const executionConfig: OpenClawConfig =
    retired === "policy"
      ? { ...config, agents: { defaults: { sandbox: { mode: "all" } } } }
      : config;
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  setRuntimeConfigSnapshot(executionConfig);
  const admitted =
    retired === "caller"
      ? undefined
      : await admitSkillSession(root, retired === "policy" ? { sandboxMode: "off" } : {});
  const controller = new AbortController();
  const { entered, resume } = preparationGate(phase);
  const pending = prepare(
    root,
    executionConfig,
    retired === "caller" ? () => controller.signal.throwIfAborted() : undefined,
    admitted?.reader,
  );
  try {
    await awaitGateBeforeSettlement(entered.promise, pending, "preparation did not reach its wait");
    if (admitted) {
      if (retired === "reader") {
        await admitted.databaseClaim.release();
      } else {
        await upsertSessionEntryCore(admitted.scope, { sandboxMode: undefined });
      }
    } else {
      controller.abort(new Error("skill caller retired"));
    }
    resume.resolve();
    if (retired === "reader") {
      await expect(pending).rejects.toThrow();
    } else {
      await expect(pending).rejects.toThrow(
        retired === "policy" ? "changed" : "skill caller retired",
      );
    }
    if (retired === "reader" || (retired === "caller" && phase === "approvals")) {
      expect(resolveReusableWorkspaceSkillSnapshot).not.toHaveBeenCalled();
    }
  } finally {
    resume.resolve();
    await Promise.allSettled([pending, admitted?.databaseClaim.release()]);
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

async function accountingFixture(state: OpenClawTestState) {
  setRuntimeConfigSnapshot({});
  const scope = {
    agentId: "main",
    storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
    sessionKey: "agent:main:compaction-accounting",
  };
  const entry: InternalSessionEntry = {
    sessionId: randomUUID(),
    lifecycleRevision: randomUUID(),
    updatedAt: 1,
    compactionCount: 0,
  };
  await replaceSessionEntry(scope, entry);
  const sessionStore = { [scope.sessionKey]: entry };
  return {
    params: { ...scope, sessionEntry: entry, sessionStore, expectedSession: entry },
    entry,
    cached: () => sessionStore[scope.sessionKey],
    read: () => loadSessionEntry({ ...scope, readConsistency: "latest" }),
    replace: (patch: Partial<InternalSessionEntry>) =>
      replaceSessionEntry(scope, { ...entry, ...patch }),
    remove: () =>
      applySessionEntryLifecycleMutation({
        agentId: scope.agentId,
        storePath: scope.storePath,
        removals: [{ sessionKey: scope.sessionKey }],
        skipMaintenance: true,
      }),
  };
}

function withAccountingFixture(
  body: (fixture: Awaited<ReturnType<typeof accountingFixture>>) => Promise<void>,
) {
  return withOpenClawTestState(
    { label: "compaction-accounting", scenario: "minimal" },
    async (state) => body(await accountingFixture(state)),
  );
}

describe("completed compaction accounting", () => {
  it.each([80, undefined])(
    "invalidates prior run accounting with tokensAfter=%s",
    async (tokensAfter) => {
      await withAccountingFixture(async (fixture) => {
        await fixture.replace({
          inputTokens: 18_420,
          outputTokens: 840,
          cacheRead: 76_500,
          cacheWrite: 300,
          estimatedCostUsd: 0.023,
          totalTokens: 95_760,
          totalTokensFresh: true,
        });
        expect(await incrementCompactionCount({ ...fixture.params, tokensAfter })).toBe(1);
        for (const row of [fixture.read(), fixture.cached()]) {
          expect(row?.inputTokens).toBeUndefined();
          expect(row?.outputTokens).toBeUndefined();
          expect(row?.cacheRead).toBeUndefined();
          expect(row?.cacheWrite).toBeUndefined();
          expect(row?.estimatedCostUsd).toBeUndefined();
        }
        expect(fixture.read()?.totalTokens).toBe(tokensAfter ?? 95_760);
        expect(fixture.read()?.totalTokensFresh).toBe(tokensAfter !== undefined);
      });
    },
  );
  it("increments the authoritative count without a caller cache", async () => {
    await withAccountingFixture(async (fixture) => {
      await fixture.replace({ compactionCount: 7 });

      const count = await incrementCompactionCount({
        ...fixture.params,
        sessionEntry: undefined,
        sessionStore: undefined,
        tokensAfter: 123,
      });

      expect(count).toBe(8);
      expect(fixture.read()).toMatchObject({
        sessionId: fixture.entry.sessionId,
        compactionCount: 8,
        totalTokens: 123,
      });
      expect(fixture.cached()?.compactionCount).toBe(0);
    });
  });

  it("records and clears byte-compaction progress with authoritative accounting", async () => {
    await withAccountingFixture(async (fixture) => {
      const latch = { activeBytes: 60_000, sessionId: fixture.entry.sessionId, maxBytes: 50_000 };

      expect(
        await incrementCompactionCount({ ...fixture.params, transcriptByteCompactionLatch: latch }),
      ).toBe(1);
      expect(fixture.read()?.transcriptByteCompactionLatch).toEqual(latch);

      expect(await incrementCompactionCount(fixture.params)).toBe(2);
      expect(fixture.read()?.transcriptByteCompactionLatch).toEqual(latch);

      await incrementCompactionCount({ ...fixture.params, transcriptByteCompactionLatch: null });
      expect(fixture.read()?.transcriptByteCompactionLatch).toBeUndefined();
    });
  });

  it.each([
    {
      name: "newer writer",
      patch: {
        activeWriterRunId: "new-writer",
        compactionCount: 7,
        totalTokens: 666,
        totalTokensFresh: true,
      },
    },
    { name: "deleted row", patch: undefined },
    { name: "replaced session", patch: { sessionId: "replacement-session" } },
    { name: "replaced lifecycle", patch: { lifecycleRevision: "replacement-revision" } },
  ])("does not account compaction against a $name", async ({ name, patch }) => {
    await withAccountingFixture(async (fixture) => {
      if (patch) {
        await fixture.replace(patch);
      } else {
        await fixture.remove();
      }
      const before = fixture.read();
      const expectedSession =
        name === "deleted row"
          ? undefined
          : name === "newer writer"
            ? { ...fixture.entry, activeWriterRunId: "old-writer" }
            : fixture.entry;
      expect(
        await incrementCompactionCount({
          ...fixture.params,
          expectedSession,
          ...(patch ? { tokensAfter: 123 } : {}),
        }),
      ).toBeUndefined();
      expect(fixture.read()).toEqual(before);
      if (name.startsWith("replaced")) {
        expect(fixture.cached()).toBe(fixture.entry);
      }
    });
  });

  it("does not commit compaction accounting when authority closes after admission", async () => {
    await withAccountingFixture(async (fixture) => {
      let authorized = true;
      const authorize = () => {
        queueMicrotask(() => {
          authorized = false;
        });
        return authorized;
      };
      const result = await incrementCompactionCount({
        ...fixture.params,
        tokensAfter: 123,
        authorize,
      });

      expect(result).toBeUndefined();
      expect(fixture.cached()).toBe(fixture.entry);
      expect(fixture.read()?.compactionCount).toBe(0);
      expect(fixture.read()?.totalTokens).toBeUndefined();
    });
  });
});
