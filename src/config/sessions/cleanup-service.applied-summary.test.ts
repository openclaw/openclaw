import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import type { SessionMaintenanceConfig } from "../types.base.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { setCleanupDeleteFault } from "./cleanup-service.delete-fault.test-support.js";
import { afterCleanupRead } from "./cleanup-service.test-support.js";
import { resolveSessionWorkStartError } from "./lifecycle.js";

const cleanupRace = vi.hoisted(() => ({
  postCommitFailureStorePath: undefined as string | undefined,
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const { cleanupFaultWorker } = await import("./cleanup-service.delete-fault.test-support.js");
  return cleanupFaultWorker(await importOriginal<typeof import("node:worker_threads")>());
});

vi.mock("./disk-budget.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./disk-budget.js")>();
  return {
    ...actual,
    pruneUnreferencedSessionArtifacts: vi.fn(async (params) => {
      const result = await actual.pruneUnreferencedSessionArtifacts(params);
      if (!params.dryRun && cleanupRace.postCommitFailureStorePath === params.storePath) {
        throw new Error("injected post-commit artifact failure");
      }
      return result;
    }),
  };
});

import { runSessionsCleanup } from "./cleanup-service.js";
import {
  appendTranscriptMessageSync,
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  listSessionEntriesCore,
  loadTranscriptEventsSync,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { appendTranscriptEventSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import type { SessionEntry } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionScope = (storePath: string, name: string, agentId = "main") => ({
  agentId,
  storePath,
  sessionKey: `agent:${agentId}:${name}`,
  sessionId: name,
});
const activeCount = (storePath: string) =>
  listSessionEntriesCore({ storePath }).filter(({ entry }) => entry.archivedAt === undefined)
    .length;
async function writeConfig(state: OpenClawTestState, cfg: OpenClawConfig) {
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
}
async function configuredCleanup(state: OpenClawTestState, maintenance: SessionMaintenanceConfig) {
  const cfg = { session: { maintenance } };
  await writeConfig(state, cfg);
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  const target = { agentId: "main", storePath };
  return (dryRun = false) =>
    runSessionsCleanup({
      cfg,
      opts: { enforce: true, dryRun },
      targets: [target],
      commitGuard: () => {},
    });
}

afterEach(async () => {
  setCleanupDeleteFault(undefined);
  cleanupRace.postCommitFailureStorePath = undefined;
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
});

it.each(["age", "count"] as const)(
  "archives durable conversations under %s pressure and agrees with its preview after reopening",
  async (pressure) => {
    await withOpenClawTestState({}, async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const run = await configuredCleanup(state, {
        mode: "enforce",
        archiveDashboardAfter: false,
        maxDiskBytes: false,
        maxEntries: pressure === "count" ? 1 : 5,
        pruneAfter: pressure === "age" ? "30d" : "365d",
      });
      const now = Date.now();
      const old = now - 31 * 24 * 60 * 60_000;
      const scope = (name: string) => sessionScope(storePath, name);
      for (const [name, updatedAt, archivedAt] of [
        ["existing-archive", old - 2, old],
        ["hook:disposable", old - 1, undefined],
        ["conversation", old, undefined],
        ["recent", now, undefined],
      ] as const) {
        replaceSessionEntrySync(scope(name), { sessionId: name, updatedAt, archivedAt });
      }
      appendTranscriptMessageSync(scope("conversation"), {
        eventId: "retained-message",
        message: { role: "user", content: [{ type: "text", text: "Keep my conversation" }] },
      });
      const history = loadTranscriptEventsSync(scope("conversation"));
      expect(activeCount(storePath)).toBe(3);
      const preview = await run(true);
      const sql = observeHostDataSql();
      const result = await run().finally(sql.restore);
      expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
      expect(activeCount(storePath)).toBe(1);
      const expected = {
        beforeCount: 4,
        afterCount: 3,
        archived: pressure === "age" ? 1 : 0,
        capArchived: pressure === "count" ? 1 : 0,
        pruned: pressure === "age" ? 1 : 0,
        capped: pressure === "count" ? 2 : 0,
        wouldMutate: true,
      };
      expect(preview.previewResults[0]?.summary).toMatchObject(expected);
      expect(result.previewResults).toEqual([]);
      expect(result.appliedSummaries[0]).toMatchObject(expected);
      expect(loadSessionEntry(scope("hook:disposable"))).toBeUndefined();
      let resourceRetired = false;
      registerOpenClawAgentDatabaseAsyncResource({
        agentId: "main",
        path: resolveSqliteTargetFromSessionStorePath(storePath).path,
        revoke: () => {},
        close: async () => {
          await Promise.resolve();
          resourceRetired = true;
        },
      });
      // Reopening must follow native retirement, not only synchronous revocation.
      await closeOpenClawAgentDatabasesAsync(state.root);
      closeOpenClawAgentDatabasesForTest(state.root);
      expect(resourceRetired).toBe(true);
      expect(loadSessionEntry(scope("conversation"))).toMatchObject({
        sessionId: "conversation",
        archivedAt: expect.any(Number),
        archiveReason: pressure === "age" ? "age-retention" : "active-session-cap",
      });
      expect(loadTranscriptEventsSync(scope("conversation"))).toEqual(history);
      const repeated = await run();
      expect(repeated.appliedSummaries[0]).toMatchObject({
        beforeCount: 3,
        afterCount: 3,
        archived: 0,
        pruned: 0,
        capped: 0,
        wouldMutate: false,
      });
      expect(loadTranscriptEventsSync(scope("conversation"))).toEqual(history);
    });
  },
);

it("skips protected conversations and restores usable history under continuing cap pressure", async () => {
  await withOpenClawTestState({}, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const old = Date.now() - 31 * 24 * 60 * 60_000;
    const protectedEntries: Record<string, Partial<SessionEntry>> = {
      main: {},
      running: {},
      pinned: { pinnedAt: old },
      locked: { modelSelectionLocked: true },
      "custom:direct:peer": {},
      "direct:peer": {},
      routed: {
        delivery: normalizeSessionDeliveryState({
          context: { channel: "custom", to: "peer" },
          origin: { chatType: "direct" },
        }),
      },
      admitted: {},
    };
    const scope = (name: string) => sessionScope(storePath, name);
    for (const [name, extra] of Object.entries({ ...protectedEntries, conversation: {} })) {
      replaceSessionEntrySync(scope(name), { sessionId: name, updatedAt: old, ...extra });
    }
    appendTranscriptMessageSync(scope("conversation"), {
      eventId: "original-message",
      message: { role: "user", content: "Original conversation" },
    });
    const history = loadTranscriptEventsSync(scope("conversation"));
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [scope("admitted").sessionKey],
      assertAllowed: () => {},
    });
    registerAgentRunContext("cleanup-protected-live", {
      agentId: "main",
      sessionKey: scope("running").sessionKey,
      projectSessionActive: true,
    });
    const maintenanceOverride = {
      mode: "enforce" as const,
      maxEntries: 1,
      archiveDashboardAfterMs: null,
    };
    try {
      expect(activeCount(storePath)).toBe(9);
      const result = await applySessionEntryLifecycleMutation({ storePath, maintenanceOverride });
      expect(activeCount(storePath)).toBe(8);
      expect(result).toMatchObject({
        archived: 1,
        pruned: 0,
        capped: 0,
        beforeCount: 9,
        afterCount: 9,
      });
      for (const name of Object.keys(protectedEntries)) {
        expect(
          resolveSessionWorkStartError(scope(name).sessionKey, loadSessionEntry(scope(name))),
        ).toBeUndefined();
      }
      const archived = loadSessionEntry(scope("conversation"))!;
      expect(archived.archivedAt).toEqual(expect.any(Number));
      await applySessionEntryLifecycleMutation({
        storePath,
        activeSessionKey: scope("conversation").sessionKey,
        upserts: [
          {
            sessionKey: scope("conversation").sessionKey,
            entry: { ...archived, archivedAt: undefined, updatedAt: Date.now() },
          },
        ],
        maintenanceOverride,
      });
      expect(
        resolveSessionWorkStartError(
          scope("conversation").sessionKey,
          loadSessionEntry(scope("conversation")),
        ),
      ).toBeUndefined();
      expect(loadSessionEntry(scope("conversation"))?.archiveReason).toBeUndefined();
      expect(loadSessionEntry(scope("conversation"))?.archivedBy).toBeUndefined();
      appendTranscriptMessageSync(scope("conversation"), {
        eventId: "restored-message",
        message: { role: "user", content: [{ type: "text", text: "Continue after restore" }] },
      });
      expect(loadTranscriptEventsSync(scope("conversation"))).toEqual([
        ...history,
        expect.objectContaining({ id: "restored-message" }),
      ]);
    } finally {
      clearAgentRunContext("cleanup-protected-live");
      admission.release();
    }
  });
});

it.each([true, false])("reports a sole empty orphan as a mutation (dryRun=%s)", async (dryRun) => {
  await withOpenClawTestState({}, async (state) => {
    const run = await configuredCleanup(state, {
      mode: "enforce",
      maxDiskBytes: false,
      pruneAfter: "1s",
    });
    await fs.mkdir(state.sessionsDir(), { recursive: true });
    const orphan = path.join(state.sessionsDir(), "orphan.jsonl");
    await fs.writeFile(orphan, "");
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(orphan, old, old);

    const result = await run(dryRun);

    const expected = {
      beforeCount: 0,
      afterCount: 0,
      wouldMutate: true,
      diskBudget: null,
      unreferencedArtifacts: { removedFiles: 1, freedBytes: 0 },
    };
    if (dryRun) {
      expect(result.previewResults[0]?.summary).toMatchObject({ ...expected, dryRun });
      expect(result.appliedSummaries).toEqual([]);
      await expect(fs.readFile(orphan, "utf8")).resolves.toBe("");
    } else {
      expect(result.appliedSummaries).toMatchObject([
        { ...expected, applied: true, dryRun: false },
      ]);
      await expect(fs.stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

it("cleans the selected agent without pruning a sibling behind the same selector", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async (state) => {
    const storePath = state.statePath("shared.json");
    const cfg = {
      agents: { ownership: "explicit", entries: { main: {}, beta: {} } },
      session: { store: storePath, maintenance: { mode: "warn", pruneAfter: "1d" } },
    } satisfies OpenClawConfig;
    await writeConfig(state, cfg);
    const scopes = ["main", "beta"].map((agentId) => ({
      agentId,
      sessionKey: `agent:${agentId}:hook:stale`,
      storePath,
    }));
    const updatedAt = Date.now() - 2 * 24 * 60 * 60_000;
    for (const scope of scopes) {
      await replaceSessionEntry(scope, {
        sessionId: `${scope.agentId}-stale`,
        updatedAt,
      });
      expect(loadSessionEntry(scope)?.updatedAt).toBe(updatedAt);
    }

    const result = await runSessionsCleanup({ cfg, opts: { agent: "beta", enforce: true } });

    expect(result.appliedSummaries[0]).toMatchObject({
      agentId: "beta",
      beforeCount: 1,
      afterCount: 0,
      pruned: 1,
      applied: true,
    });
    expect(loadSessionEntry(scopes[0]!)).toMatchObject({ sessionId: "main-stale" });
    expect(loadSessionEntry(scopes[1]!)).toBeUndefined();
  });
});

it("preserves sessions when cleanup authority is revoked after classification", async () => {
  await withOpenClawTestState({}, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const scope = { sessionKey: "agent:main:hook:guard", storePath };
    await replaceSessionEntry(scope, { sessionId: "guarded-cleanup", updatedAt: Date.now() });
    let authorized = true;
    afterCleanupRead(() => {
      authorized = false;
    });

    await expect(
      runSessionsCleanup({
        cfg: {},
        opts: { enforce: true, fixMissing: true },
        targets: [{ agentId: "main", storePath }],
        commitGuard: () => {
          if (!authorized) {
            throw new Error("cleanup authority revoked");
          }
        },
      }),
    ).rejects.toMatchObject({
      name: "SessionsCleanupFailureError",
      failure: {
        lifecycleCommitted: false,
        message: expect.stringContaining("cleanup authority revoked"),
      },
    });
    expect(loadSessionEntry(scope)).toMatchObject({ sessionId: "guarded-cleanup" });
  });
});

it.each([
  { fault: "before commit", lifecycleCommitted: false },
  { fault: "after commit", lifecycleCommitted: true },
])(
  "returns earlier committed summaries when a later store fails $fault",
  async ({ lifecycleCommitted }) => {
    const rootDir = tempDirs.make("openclaw-cleanup-partial-");
    const target = (agentId: string) => ({
      ...sessionScope(
        path.join(rootDir, "agents", agentId, "sessions", "sessions.json"),
        "message-free",
        agentId,
      ),
      sessionId: `${agentId}-message-free`,
    });
    const main = target("main");
    const failing = target("work");
    const stores = [main, failing];
    if (!lifecycleCommitted) {
      setCleanupDeleteFault({
        databasePath: resolveSqliteTargetFromSessionStorePath(failing.storePath, {
          agentId: failing.agentId,
        }).path!,
        sessionId: failing.sessionId,
        message: "injected second-store lifecycle failure",
      });
    }
    for (const store of stores) {
      await replaceSessionEntry(store, {
        sessionId: store.sessionId,
        updatedAt: Date.now() - 100_000_000,
      });
      appendTranscriptEventSync(store, { type: "proof", content: store.agentId });
    }
    if (lifecycleCommitted) {
      cleanupRace.postCommitFailureStorePath = failing.storePath;
    }

    const outcome = await runSessionsCleanup({
      cfg: {},
      opts: { enforce: true, fixMissing: true },
      targets: stores,
    });

    expect(loadSessionEntry(main)).toBeUndefined();
    if (lifecycleCommitted) {
      expect(loadSessionEntry(failing)).toBeUndefined();
    } else {
      expect(loadSessionEntry(failing)).toMatchObject({ sessionId: failing.sessionId });
    }
    expect(outcome).toMatchObject({
      appliedSummaries: [expect.objectContaining({ agentId: "main", applied: true })],
      failure: expect.objectContaining({
        target: expect.objectContaining({ agentId: "work" }),
        lifecycleCommitted,
        message: expect.stringContaining(
          lifecycleCommitted
            ? "injected post-commit artifact failure"
            : "injected second-store lifecycle failure",
        ),
      }),
    });
  },
);
