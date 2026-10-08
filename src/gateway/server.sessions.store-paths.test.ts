import fsSync from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { expect, test, vi } from "vitest";
import * as sessionDirs from "../agents/session-dirs.js";
import * as runtimePaths from "../config/paths.js";
import type { InternalSessionEntry } from "../config/sessions.js";
import {
  deleteSessionEntryLifecycle,
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { getGatewayContextResolver } from "../plugins/runtime/gateway-context-binding.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawAgentDatabaseWrite } from "../state/openclaw-agent-db-write.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import * as agentDatabasePaths from "../state/openclaw-agent-db.paths.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import * as stateDatabase from "../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withEnvAsync } from "../test-utils/env.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import { getGatewayRecoveryRuntime } from "./server-recovery-runtime-context.js";
import * as readContexts from "./session-read-contexts.test-support.js";
import {
  bindSessionRowProjection,
  getSessionRowProjection,
} from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import { releaseGatewaySessionStoreFixture } from "./test/server-sessions-resources.test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient, withSessionTestState } =
  setupGatewaySessionsTestHarness();

test.each([false, true])(
  "nested state cleanup joins suite ACP reads (disposal fails=%s)",
  async (disposalFails) => {
    const suiteStateDir = runtimePaths.resolveStateDir();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const boundary = createDeferredCore<"joined" | "closed">();
    let preparing: Promise<void> | undefined;
    let closing = false;
    let sharedPath: string | undefined;
    const close = stateDatabase.closeOpenClawStateDatabaseByPathAsync;
    const closeSpy = vi
      .spyOn(stateDatabase, "closeOpenClawStateDatabaseByPathAsync")
      .mockImplementation((...args) => {
        if (closing && args[0] === sharedPath) {
          boundary.resolve("closed");
        }
        return close(...args);
      });
    let restoreRead: (() => void) | undefined;
    let restoreJoin: (() => void) | undefined;
    const disposalFailure = new Error("synthetic read-context disposal failure");
    const disposal = disposalFails
      ? vi.spyOn(readContexts, "disposeSessionReadContexts").mockRejectedValueOnce(disposalFailure)
      : undefined;
    const fixture = withSessionTestState({ layout: "state-only" }, async (state) => {
      sharedPath = state.statePath("state", "openclaw.sqlite");
      const fixtureSignal = getAsyncWorkSignal();
      ensureProfileForEmail("nested-state-reader@example.test");
      const { storePath } = await createSessionStoreDir();
      await writeSessionStore({
        entries: { main: { sessionId: "nested-state-reader", updatedAt: 1 } },
      });
      const runtime = getGatewayRecoveryRuntime();
      const projection = getSessionRowProjection(runtime && getGatewayContextResolver(runtime)?.());
      if (!projection) {
        throw new Error("Suite Gateway projection is missing");
      }
      await projection.ensureMaterialized();
      const read = stateReads.executeExistingOpenClawStateRead;
      let held = false;
      const reads = vi
        .spyOn(stateReads, "executeExistingOpenClawStateRead")
        .mockImplementation((...args) => {
          if (
            !held &&
            args[1].type === "sessionRows.sharedFacts" &&
            args[0].env?.OPENCLAW_STATE_DIR === suiteStateDir &&
            getAsyncWorkSignal() !== fixtureSignal
          ) {
            held = true;
            entered.resolve();
            // The suite continuation has not admitted its shared-state read yet.
            return release.promise.then(() => read(...args));
          }
          return read(...args);
        });
      restoreRead = () => reads.mockRestore();
      sessionChanges.emit({ all: true, scope: { storePath }, factsInvalidated: true });
      preparing = projection.ensureMaterialized();
      void preparing.catch(() => {});
      await Promise.race([
        entered.promise,
        preparing.then(() => {
          throw new Error("Suite projection completed without its ACP metadata read");
        }),
      ]);
      const ensure = projection.ensureMaterialized;
      const join = vi.spyOn(projection, "ensureMaterialized").mockImplementation(() => {
        if (closing) {
          boundary.resolve("joined");
        }
        return ensure();
      });
      restoreJoin = () => join.mockRestore();
      closing = true;
    });
    void fixture.catch(() => {});
    try {
      const first = await Promise.race([
        boundary.promise,
        fixture.then(() => {
          throw new Error("Fixture completed without joining or closing its database");
        }),
      ]);
      expect(first).toBe("joined");
      release.resolve();
      await expect(preparing).resolves.toBeUndefined();
      if (disposalFails) {
        await expect(fixture).rejects.toBe(disposalFailure);
      } else {
        await fixture;
      }
    } finally {
      release.resolve();
      await Promise.allSettled([preparing, fixture]);
      restoreRead?.();
      restoreJoin?.();
      closeSpy.mockRestore();
      disposal?.mockRestore();
    }
  },
);

test("sessions.list reads completed models from each physical agent store", async () => {
  const { dir: stateDir } = await createSessionStoreDir();
  testState.sessionStorePath = undefined;
  const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json");
  testState.sessionConfig = { store: storeTemplate };
  testState.agentsConfig = { entries: { main: {}, ops: {} } };
  for (const agentId of ["main", "ops"]) {
    const sessionId = `session-${agentId}`;
    const sessionKey = `agent:${agentId}:main`;
    const storePath = storeTemplate.replace("{agentId}", agentId);
    const runId = `run-${agentId}`;
    const entry: InternalSessionEntry = {
      sessionId,
      updatedAt: 10,
      status: "done",
      lastRunId: runId,
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      modelProvider: "openai",
      model: "gpt-5.4",
      fallbackNotice: {
        kind: "active",
        selectedModel: "openai/gpt-5.4",
        activeModel: "anthropic/claude-sonnet-4-6",
      },
    };
    await writeSessionStore({
      agentId,
      entries: { [sessionKey]: entry },
      storePath,
    });
    const scope = { agentId, sessionId, sessionKey, storePath };
    await appendTranscriptEvent(scope, { type: "session", version: 3, id: sessionId });
    await appendTranscriptMessage(scope, {
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Completed ${agentId}` }],
        provider: agentId === "main" ? "anthropic" : "openai",
        model: agentId === "main" ? "claude-sonnet-4-6" : "gpt-5.4",
        stopReason: "stop",
        __openclaw: { runId },
      },
    });
  }

  const projection = await createSessionRowProjection({
    cfg: (await getGatewayConfigModule()).getRuntimeConfig(),
  });
  // A bad relative selector must stay inside the disposable fixture if it regresses.
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(stateDir);
  try {
    await vi.waitFor(() =>
      expect(
        projection.snapshot({ agentId: "main", key: "agent:main:main" }).row?.activeModel,
      ).toBe("claude-sonnet-4-6"),
    );
    const listed = await directSessionReq<{
      path: string;
      sessions: Array<{ key: string; activeModelProvider?: string; activeModel?: string }>;
    }>("sessions.list", {}, { context: bindSessionRowProjection({}, () => projection) });
    expect(listed).toMatchObject({ ok: true, payload: { path: "(multiple)" } });
    expect(listed.payload?.sessions.find((row) => row.key === "agent:main:main")).toMatchObject({
      activeModelProvider: "anthropic",
      activeModel: "claude-sonnet-4-6",
    });
    expect(
      listed.payload?.sessions.find((row) => row.key === "agent:ops:main")?.activeModel,
    ).toBeUndefined();
    expect(fsSync.readdirSync(stateDir).filter((name) => name.startsWith("(multiple)"))).toEqual(
      [],
    );
  } finally {
    projection.dispose();
    cwd.mockRestore();
  }
});

test.runIf(process.platform !== "win32")(
  "requested-agent path projection collapses physical store aliases",
  async () => {
    const { dir: stateDir } = await createSessionStoreDir();
    testState.sessionStorePath = undefined;
    const aliasStateDir = `${stateDir}-alias`;
    fsSync.symlinkSync(stateDir, aliasStateDir, "dir");
    try {
      const realStore = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      const aliasTemplate = path.join(
        aliasStateDir,
        "agents",
        "{agentId}",
        "sessions",
        "sessions.json",
      );
      testState.sessionConfig = {
        store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
      };
      testState.agentsConfig = { entries: { main: {} } };
      await writeSessionStore({
        agentId: "main",
        entries: {
          "agent:main:main": { sessionId: "alias-main", updatedAt: 10 },
        },
        storePath: realStore,
      });
      testState.sessionConfig = { store: aliasTemplate };
      const { clearRuntimeConfigSnapshot, getRuntimeConfig } = await getGatewayConfigModule();
      clearRuntimeConfigSnapshot();
      getRuntimeConfig();
      const listed = await directSessionReq<{
        path: string;
        sessions: Array<{ key: string }>;
      }>("sessions.list", {
        agentId: "main",
      });

      expect(listed).toMatchObject({
        ok: true,
        payload: {
          path: resolveSqliteTargetFromSessionStorePath(realStore, { agentId: "main" }).path,
          sessions: [expect.objectContaining({ key: "agent:main:main" })],
        },
      });
    } finally {
      await disposeSessionReadContexts();
      await releaseGatewaySessionStoreFixture(aliasStateDir);
      fsSync.rmSync(aliasStateDir, { force: true });
    }
  },
);

test("configured-only multi-store target preparation is reused across distinct lists", async () => {
  const { dir: stateDir } = await createSessionStoreDir();
  testState.sessionStorePath = undefined;
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    const agentIds = Array.from({ length: 29 }, (_, index) => `agent-${index}`);
    const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json");
    testState.sessionConfig = { store: storeTemplate };
    testState.agentsConfig = { entries: Object.fromEntries(agentIds.map((id) => [id, {}])) };
    (await getGatewayConfigModule()).getRuntimeConfig();
    for (const agentId of agentIds) {
      const storePath = storeTemplate.replace("{agentId}", agentId);
      // Seed list metadata without running unrelated lifecycle deletion workers.
      await withOpenClawAgentDatabaseWrite(
        {
          agentId,
          path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId }).path,
        },
        () =>
          replaceSessionEntrySync(
            { agentId, sessionKey: `agent:${agentId}:main`, storePath },
            { sessionId: `session-${agentId}`, updatedAt: 10 },
          ),
      );
    }

    expect((await directSessionReq("sessions.list", { configuredAgentsOnly: true })).ok).toBe(true);
    const matcher = vi.spyOn(agentDatabasePaths, "createOpenClawAgentDatabasePathMatcher");
    const lstat = vi.spyOn(fsSync, "lstatSync");
    const readlink = vi.spyOn(fsSync, "readlinkSync");
    const realpath = vi.spyOn(fsSync.realpathSync, "native");
    const stat = vi.spyOn(fsSync, "statSync");
    syncBuiltinESMExports();
    try {
      const first = await directSessionReq<{ path: string }>("sessions.list", {
        configuredAgentsOnly: true,
        includeGlobal: false,
      });
      expect(first).toMatchObject({ ok: true, payload: { path: "(multiple)" } });
      expect(matcher).not.toHaveBeenCalled();
      expect({
        realpath: realpath.mock.calls.length,
        stat: stat.mock.calls.length,
      }).toEqual({ realpath: 0, stat: 0 });

      for (const spy of [matcher, lstat, readlink, realpath, stat]) {
        spy.mockClear();
      }
      const second = await directSessionReq<{ path: string }>("sessions.list", {
        configuredAgentsOnly: true,
        includeUnknown: false,
      });

      expect(second).toMatchObject({ ok: true, payload: { path: "(multiple)" } });
      expect({
        lstat: lstat.mock.calls.length,
        matcher: matcher.mock.calls.length,
        readlink: readlink.mock.calls.length,
        realpath: realpath.mock.calls.length,
        stat: stat.mock.calls.length,
      }).toEqual({ lstat: 0, matcher: 0, readlink: 0, realpath: 0, stat: 0 });
    } finally {
      matcher.mockRestore();
      lstat.mockRestore();
      readlink.mockRestore();
      realpath.mockRestore();
      stat.mockRestore();
      syncBuiltinESMExports();
    }
  });
});

test("configured-only parent-owned stores keep lineage children without directory discovery", async () => {
  const { dir: stateDir } = await createSessionStoreDir();
  testState.sessionStorePath = undefined;
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json");
    const storePath = storeTemplate.replace("{agentId}", "ops");
    const mainKey = "agent:ops:main";
    const childKey = "agent:codex:subagent:fixed-child";
    testState.sessionConfig = { store: storeTemplate };
    testState.agentsConfig = { ownership: "explicit", entries: { ops: {} } };
    testState.agentConfig = { sessionStore: { agentId: "ops" } };
    await writeSessionStore({
      agentId: "ops",
      storePath,
      entries: {
        [childKey]: { sessionId: "session-child", updatedAt: 30, parentSessionKey: mainKey },
        [mainKey]: { sessionId: "session-main", updatedAt: 20 },
        "agent:local:main": { sessionId: "session-local", updatedAt: 10 },
      },
    });

    expect((await directSessionReq("sessions.list", { configuredAgentsOnly: true })).ok).toBe(true);
    const enumerateAgentDirs = vi.spyOn(sessionDirs, "resolveAgentSessionDirsFromAgentsDirSync");
    try {
      const listed = await directSessionReq<{ sessions: Array<{ key: string }> }>("sessions.list", {
        includeGlobal: false,
        includeUnknown: false,
        configuredAgentsOnly: true,
      });

      expect(listed.ok).toBe(true);
      expect(listed.payload?.sessions.map((session) => session.key)).toEqual([childKey, mainKey]);
      expect(enumerateAgentDirs).not.toHaveBeenCalled();
    } finally {
      enumerateAgentDirs.mockRestore();
    }
  });
});

test("resolves and patches main alias to default agent main key", async () => {
  // Remove the shared server's bootstrap main before changing its canonical main key.
  await deleteSessionEntryLifecycle({
    agentId: "main",
    storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
    archiveTranscript: false,
    target: { canonicalKey: "agent:main:main", storeKeys: ["agent:main:main"] },
  });
  const { storePath } = await createSessionStoreDir();
  testState.agentsConfig = { entries: { ops: {} } };
  testState.sessionConfig = { mainKey: "work" };

  await writeSessionStore({
    storePath,
    agentId: "ops",
    mainKey: "work",
    entries: {
      main: {
        sessionId: "sess-ops-main",
        updatedAt: Date.now(),
      },
    },
  });

  const { ws } = await openClient();
  try {
    const resolved = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
      key: "main",
    });
    expect(resolved.ok, JSON.stringify(resolved)).toBe(true);
    expect(resolved.payload?.key).toBe("agent:ops:work");

    const patched = await rpcReq<{ ok: true; key: string; path: string }>(ws, "sessions.patch", {
      key: "main",
      thinkingLevel: "medium",
    });
    expect(patched.ok).toBe(true);
    expect(patched.payload?.key).toBe("agent:ops:work");
    expect(patched.payload?.path).toBe(
      resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "ops" }).path,
    );

    expect(
      loadSessionEntry({ agentId: "ops", sessionKey: "agent:ops:work", storePath })?.thinkingLevel,
    ).toBe("medium");
    expect(loadSessionEntry({ agentId: "ops", sessionKey: "main", storePath })).toBeUndefined();
  } finally {
    ws.close();
  }
});
