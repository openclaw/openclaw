import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import * as archives from "./session-accessor.sqlite-archive.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { purgeDeletedAgentSessionEntries } from "./session-accessor.sqlite-projection.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { appendTranscriptEventSync } from "./session-accessor.sqlite-transcript-write.js";
import { SessionMaintenancePreservationConflictError } from "./session-mutation-conflict-error.js";
import { withNativeBindingFixture } from "./session-native-binding.test-support.js";
import { registerSessionMaintenancePreserveKeysProvider } from "./store-maintenance-preserve.js";

vi.mock("./session-accessor.sqlite-maintenance-kick.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-accessor.sqlite-maintenance-kick.js")>()),
  kickSessionEntryMaintenanceAfterWrite() {},
}));
vi.mock("./session-history-eviction.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-history-eviction.js")>()),
  kickSessionHistoryDiskBudgetMaintenance() {},
}));

// Collection owns plugin loading; each native-binding fixture retains its normal deadline.
await loadBundledPluginFacade({
  pluginId: "codex",
  artifactBasename: "native-session-binding.test-api.js",
});

afterEach(() => vi.restoreAllMocks());

function fixture(storePath: string) {
  const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
  const cfg = {
    agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
    session: { store: database.path, maintenance: { mode: "warn" } },
  } satisfies OpenClawConfig;
  const scope = { agentId: "ops", sessionKey: "agent:ops:chat", storePath: database.path };
  const sharedScope = { ...scope, agentId: "main", sessionKey: "agent:main:survivor" };
  const write = (
    agentId: "main" | "ops",
    sessionKey: string,
    sessionId: string,
    previousSessionId?: string,
  ) => {
    replaceSessionEntrySync(
      { ...scope, agentId, sessionKey },
      { sessionId, updatedAt: Date.now(), ...(previousSessionId ? { previousSessionId } : {}) },
    );
  };
  const transcriptScope = (sessionId: string) => ({
    ...(sessionId === "shared" ? sharedScope : scope),
    sessionId,
  });
  const append = (sessionId: string) =>
    appendTranscriptEventSync(transcriptScope(sessionId), { type: "proof", data: sessionId });
  write("ops", scope.sessionKey, "historical");
  append("historical");
  write("ops", scope.sessionKey, "current", "shared");
  append("current");
  write("main", sharedScope.sessionKey, "shared");
  append("shared");
  return {
    cfg,
    scope,
    write,
    purge: () =>
      purgeDeletedAgentSessionEntries({
        cfg,
        agentId: "ops",
        storeAgentId: "main",
        storePath: database.path,
      }),
    read: (sessionKey = scope.sessionKey) => readExactSessionEntryRow(database, sessionKey)?.entry,
    transcript: (sessionId: string) => loadTranscriptEventsSync(transcriptScope(sessionId)),
  };
}

it("purges only entry-referenced generations off the host and retains history and surviving references", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const f = fixture(state.statePath("shared.sqlite"));
    await state.writeConfig(f.cfg);
    const sql = observeHostDataSql();
    try {
      await f.purge();
      expect(
        sql.queries.filter((query) =>
          /\b(?:session_nodes|session_windows|session_events|session_transcript_archives)\b/i.test(
            query,
          ),
        ),
      ).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(f.read()).toBeUndefined();
    expect(f.read("agent:main:survivor")?.sessionId).toBe("shared");
    expect(f.transcript("current")).toEqual([]);
    expect(f.transcript("historical")).toEqual([{ type: "proof", data: "historical" }]);
    expect(f.transcript("shared")).toEqual([{ type: "proof", data: "shared" }]);
  });
});

it.each(["changed entry", "added owned key", "added survivor reference"] as const)(
  "revalidates a foreign commit with %s after planning",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = fixture(state.statePath("shared.sqlite"));
      await state.writeConfig(f.cfg);
      const materialize = archives.materializeSessionStateDeletePlans;
      let changed = false;
      vi.spyOn(archives, "materializeSessionStateDeletePlans").mockImplementation(
        async (...args) => {
          const result = await materialize(...args);
          if (!changed) {
            changed = true;
            if (change === "changed entry") {
              f.write("ops", f.scope.sessionKey, "concurrent");
            } else if (change === "added owned key") {
              f.write("ops", "agent:ops:concurrent", "concurrent");
            } else {
              f.write("main", "agent:main:concurrent", "current");
            }
          }
          return result;
        },
      );
      if (change === "added survivor reference") {
        await expect(f.purge()).resolves.toBeUndefined();
        expect(f.read()).toBeUndefined();
        expect(f.read("agent:main:concurrent")?.sessionId).toBe("current");
      } else {
        await expect(f.purge()).rejects.toThrow(/changed/i);
        expect(f.read()?.sessionId).toBe(change === "changed entry" ? "concurrent" : "current");
      }
      expect(changed).toBe(true);
      const transcript =
        change === "added survivor reference"
          ? loadTranscriptEventsSync({
              agentId: "main",
              sessionKey: "agent:main:concurrent",
              sessionId: "current",
              storePath: f.scope.storePath,
            })
          : f.transcript("current");
      expect(transcript).toEqual([{ type: "proof", data: "current" }]);
    });
  },
);

it.each([false, true])(
  "enforces maintenance during purge with new survivor protection: %s",
  async (protectAtCommit) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = fixture(state.statePath("shared.sqlite"));
      const oldKey = "agent:main:maintenance-old";
      replaceSessionEntrySync(
        { ...f.scope, agentId: "main", sessionKey: oldKey },
        { sessionId: "maintenance-old", updatedAt: Date.now() - 86_400_000 },
      );
      await state.writeConfig({
        ...f.cfg,
        session: {
          ...f.cfg.session,
          maintenance: { mode: "enforce", maxEntries: 1, preserveRecent: false },
        },
      });
      const previous = [f.read(), f.read(oldKey), f.read("agent:main:survivor")];
      let protectedKeys: string[] = [];
      let sawCommit = false;
      const unregister = registerSessionMaintenancePreserveKeysProvider(async () => ({
        capture: () => protectedKeys,
        dispose() {},
      }));
      const create = admission.createSqliteWorkerOperationAdmission;
      vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (callback, attachment) =>
          create((request, grant) => {
            const publication =
              isRecord(request.facts) && isRecord(request.facts.publication)
                ? request.facts.publication
                : undefined;
            if (
              request.stage === "commit" &&
              publication?.kind === "session-entry-patch-committed"
            ) {
              sawCommit = true;
              if (protectAtCommit) {
                protectedKeys = [oldKey];
              }
            }
            callback(request, grant);
          }, attachment),
      );
      try {
        const purge = f.purge();
        if (protectAtCommit) {
          await expect(purge).rejects.toBeInstanceOf(SessionMaintenancePreservationConflictError);
          expect([f.read(), f.read(oldKey), f.read("agent:main:survivor")]).toEqual(previous);
          expect(f.transcript("current")).toEqual([{ type: "proof", data: "current" }]);
        } else {
          await purge;
          expect(f.read()).toBeUndefined();
          expect(f.read(oldKey)).toMatchObject({ archiveReason: "active-session-cap" });
          expect(f.read("agent:main:survivor")).toEqual(previous[2]);
        }
        expect(sawCommit).toBe(true);
      } finally {
        unregister();
      }
    });
  },
);

it.each([false, true])(
  "settles the purge's typed native binding when the agent commit is refused: %s",
  async (refuse) => {
    await withNativeBindingFixture("codex", async (f) => {
      const previous = f.readBinding();
      const error = new Error("purge commit refused");
      let refused = false;
      const create = admission.createSqliteWorkerOperationAdmission;
      vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (callback, attachment) =>
          create((request, grant) => {
            const publication =
              isRecord(request.facts) && isRecord(request.facts.publication)
                ? request.facts.publication
                : undefined;
            if (
              refuse &&
              request.stage === "commit" &&
              publication?.kind === "session-native-binding" &&
              publication.agent === "committed"
            ) {
              refused = true;
              throw error;
            }
            callback(request, grant);
          }, attachment),
      );
      const purge = withPluginRuntimeRegistryScope(f.registry, () =>
        purgeDeletedAgentSessionEntries({
          cfg: { agents: { ownership: "explicit", entries: { main: {} } } },
          agentId: "main",
          storeAgentId: "main",
          storePath: f.database.path,
          env: f.scope.env,
        }),
      );
      if (refuse) {
        await expect(purge).rejects.toThrow("purge commit refused");
        expect(refused).toBe(true);
        expect(f.readEntry()).toBeDefined();
        expect(f.readBinding()).toEqual(previous);
      } else {
        await purge;
        expect(f.readEntry()).toBeUndefined();
        expect(f.readBinding()).toBeUndefined();
      }
    });
  },
);
