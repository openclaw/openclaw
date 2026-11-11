import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  attachActiveEmbeddedRun,
  detachActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../agents/embedded-agent-runner/runs.test-support.js";
import { createResourceLoader } from "../agents/sessions/agent-session-loop-resource-loader.test-support.js";
import { AuthStorage } from "../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../agents/sessions/model-registry.js";
import { createAgentSession } from "../agents/sessions/sdk.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { SettingsManager } from "../agents/sessions/settings-manager.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { createZeroUsageFixture } from "../agents/test-helpers/usage-fixtures.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { readSessionEntrySnapshotInWorker } from "../config/sessions/session-transcript-read-worker-runtime.js";
import {
  historyLane,
  maintenanceLane,
  type SessionHistoryWorkerLane,
} from "../config/sessions/session-transcript-worker-resources.js";
import {
  retainSessionHistoryWorkerDatabase,
  trackSessionHistoryHostEffect,
  withSessionHistoryWorkerDatabase,
} from "../config/sessions/session-transcript-worker-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isDeletedAgentDatabasePath } from "../infra/agent-database-readers.js";
import { getSqliteRuntimeCapabilities } from "../infra/bun-sqlite-library.js";
import { retainSqliteDatabaseAdmissionLocation } from "../infra/sqlite-database-admission.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { assertAgentSessionWriteAdmission } from "../sessions/session-agent-work-admission.js";
import { beginSessionEffect } from "../sessions/session-controller.lifecycle.js";
import { useAgentDatabaseDirectories } from "../state/openclaw-agent-db-lifecycle.test-support.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "../state/openclaw-agent-db-resources.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { listOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.test-support.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";
import { createRecoveryRestartMock } from "./config-reload.test-support.js";
import { waitForDepartedAgentDatabaseRelease } from "./server-reload-agent-databases.js";
import {
  createHotReloadHandlerTestParams,
  createTestCronState,
} from "./server-reload-handlers.config.test-support.js";
import { createGatewayReloadHandlers } from "./server-reload-hot.js";

const directories = useAgentDatabaseDirectories();

function roster(agentIds: readonly string[], level: "info" | "debug" = "info"): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      entries: Object.fromEntries(agentIds.map((agentId) => [agentId, {}])),
    },
    logging: { level },
  };
}

function installState(agentIds: readonly string[]) {
  const stateDir = fs.realpathSync(directories.make("departed-agent-db-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousSnapshot = getRuntimeConfigSnapshot();
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const config = roster(agentIds);
  setRuntimeConfigSnapshot(config, config);
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const opened = agentIds.map((agentId) => {
    const database = openOpenClawAgentDatabase({ agentId, env });
    const version = database.db.prepare("PRAGMA user_version").get();
    return { agentId, database, path: database.path, version };
  });
  onTestFinished(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousSnapshot) {
      setRuntimeConfigSnapshot(previousSnapshot);
    } else {
      clearRuntimeConfigSnapshot();
    }
  });
  return { env, opened, config };
}

function createHandlers() {
  const { requestRecoveryRestart } = createRecoveryRestartMock();
  const handlers = createGatewayReloadHandlers(
    createHotReloadHandlerTestParams({
      scheduler: createTestGatewayScheduler("fake-timers"),
      deps: {} as never,
      requestRecoveryRestart,
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        cronState: createTestCronState(),
      }),
    }),
  );
  onTestFinished(() => handlers.stopRestartRetries());
  return handlers;
}

async function commitRoster(
  handlers: ReturnType<typeof createHandlers>,
  next: OpenClawConfig,
  publish: (commit: () => Promise<void>) => Promise<void> = async (commit) => {
    setRuntimeConfigSnapshot(next, next);
    await commit();
  },
) {
  await handlers.applyHotReload(buildGatewayReloadPlan(["agents.entries"]), next, {
    sourceConfig: next,
    isCurrent: () => true,
    publish,
  });
}

function holderIds(): string[] {
  return listOpenClawAgentDatabasesForTest().map((database) => database.agentId);
}

function readHistoryPresence(pathname: string, lane: SessionHistoryWorkerLane = historyLane) {
  return withSessionHistoryWorkerDatabase(
    { agentId: "worker", path: pathname, env: process.env },
    (owner) =>
      owner.readEntryPresence({
        agentId: "worker",
        sessionKey: "agent:worker:main",
        storePath: pathname,
        databaseAgentId: "worker",
        env: process.env,
      }),
    lane,
  );
}

function readClosedAgentDatabase(pathname: string): {
  sessionKey: string | undefined;
  transcript: string;
} {
  const db = new DatabaseSync(pathname, { readOnly: true });
  try {
    const node = db
      .prepare("SELECT session_key FROM session_nodes WHERE session_key = ?")
      .get("agent:worker:main") as { session_key: string } | undefined;
    const events = db
      .prepare(
        "SELECT event_json FROM transcript_events WHERE session_id = ? AND event_json IS NOT NULL",
      )
      .all("worker-held-model") as Array<{ event_json: string }>;
    return {
      sessionKey: node?.session_key,
      transcript: events.map((event) => event.event_json).join("\n"),
    };
  } finally {
    db.close();
  }
}

function readOnlyIdentityDescriptors(pathname: string): string[] {
  if (process.platform !== "linux") {
    return [];
  }
  const wanted = fs.realpathSync(pathname);
  const found: string[] = [];
  for (const entry of fs.readdirSync("/proc/self/fd")) {
    let target: string;
    try {
      target = fs.readlinkSync(path.join("/proc/self/fd", entry));
    } catch {
      continue;
    }
    if (target !== wanted) {
      continue;
    }
    const flags = Number.parseInt(
      fs
        .readFileSync(path.join("/proc/self/fdinfo", entry), "utf8")
        .match(/^flags:\s*(\S+)/m)?.[1] ?? "",
      8,
    );
    if ((flags & 3) === 0) {
      found.push(entry);
    }
  }
  return found;
}

it("closes a removed agent's database holders and leaves the other agent open", async () => {
  const { opened } = installState(["main", "worker"]);
  const worker = opened.find((database) => database.agentId === "worker");
  const main = opened.find((database) => database.agentId === "main");
  if (!worker || !main) {
    throw new Error("fixture did not open both agents");
  }
  await commitRoster(createHandlers(), roster(["main"]));

  expect(holderIds()).toEqual(["main"]);
  expect(hasOpenClawAgentDatabaseAsyncResources({ agentId: "worker", path: worker.path })).toBe(
    false,
  );
  expect(isDeletedAgentDatabasePath(worker.path)).toBe(true);
  expect(fs.existsSync(worker.path)).toBe(true);
  expect(fs.statSync(worker.path).size).toBeGreaterThan(0);
  expect(main.database.db.isOpen).toBe(true);
  expect(main.database.db.prepare("PRAGMA user_version").get()).toEqual(main.version);
  retainSqliteDatabaseAdmissionLocation(worker.path);
  expect(readOnlyIdentityDescriptors(worker.path)).toEqual([]);
  expect(() => openOpenClawAgentDatabase({ agentId: "worker", env: process.env })).toThrow(
    /left the roster/,
  );
  expect(() =>
    assertAgentSessionWriteAdmission({ agentId: "main", env: process.env }),
  ).not.toThrow();
});

it("keeps both databases open when the committed roster still admits them", async () => {
  const { opened } = installState(["main", "worker"]);
  await commitRoster(createHandlers(), roster(["main", "worker"], "debug"));
  expect(holderIds()).toEqual(opened.map((database) => database.agentId).toSorted());
  expect(opened.every((database) => !isDeletedAgentDatabasePath(database.path))).toBe(true);
});

it("keeps the removed agent's database open when config publication fails", async () => {
  const { opened } = installState(["main", "worker"]);
  const handlers = createHandlers();
  await expect(
    commitRoster(handlers, roster(["main"]), async () => {
      throw new Error("config publication rejected");
    }),
  ).rejects.toThrow("config publication rejected");
  expect(holderIds()).toEqual(opened.map((database) => database.agentId).toSorted());
});

it("admits a re-added agent's retained database after reload closed it", async () => {
  const { env, opened } = installState(["main", "worker"]);
  const worker = opened.find((database) => database.agentId === "worker");
  if (!worker) {
    throw new Error("fixture did not open worker");
  }
  const handlers = createHandlers();
  await commitRoster(handlers, roster(["main"]));
  expect(isDeletedAgentDatabasePath(worker.path)).toBe(true);

  await commitRoster(handlers, roster(["main", "worker"]));
  expect(isDeletedAgentDatabasePath(worker.path)).toBe(false);
  expect(() => assertAgentSessionWriteAdmission({ agentId: "worker", env })).not.toThrow();
  const reopened = openOpenClawAgentDatabase({ agentId: "worker", env });
  expect(reopened.db.isOpen).toBe(true);
  expect(reopened.path).toBe(worker.path);
  expect(reopened.db.prepare("PRAGMA user_version").get()).toEqual(worker.version);
});

it("follows the later committed roster when two reloads overlap", async () => {
  const { env, opened } = installState(["main", "worker"]);
  const worker = opened.find((database) => database.agentId === "worker");
  if (!worker) {
    throw new Error("fixture did not open worker");
  }
  const removalEntered = createDeferred();
  const releaseRemoval = createDeferred();
  const removal = commitRoster(createHandlers(), roster(["main"]), async (commit) => {
    removalEntered.resolve();
    await releaseRemoval.promise;
    const next = roster(["main"]);
    setRuntimeConfigSnapshot(next, next);
    await commit();
  });
  try {
    await removalEntered.promise;
    await commitRoster(createHandlers(), roster(["main", "worker"]));
    expect(isDeletedAgentDatabasePath(worker.path)).toBe(false);
  } finally {
    releaseRemoval.resolve();
  }
  await removal;

  expect(holderIds()).not.toContain("worker");
  expect(isDeletedAgentDatabasePath(worker.path)).toBe(true);
  expect(fs.existsSync(worker.path)).toBe(true);
  const survivorPath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
  expect(holderIds()).toContain("main");
  expect(path.resolve(survivorPath)).toBe(
    opened.find((database) => database.agentId === "main")?.path,
  );
});

it("leaves a journaled agents.delete cleanup in charge of the open database", async () => {
  const { env, opened } = installState(["main", "worker"]);
  const worker = opened.find((database) => database.agentId === "worker");
  if (!worker) {
    throw new Error("fixture did not open worker");
  }
  beginAgentDeletionJournal(
    {
      agentId: "worker",
      operationId: "worker-delete-journal",
      agentDir: path.dirname(worker.path),
      workspaceDir: path.dirname(worker.path),
      sessionsDir: path.dirname(worker.path),
      deleteFiles: false,
      phase: "retiring",
    },
    { env },
  );
  await commitRoster(createHandlers(), roster(["main"]));
  expect(worker.database.db.isOpen).toBe(true);
  expect(isDeletedAgentDatabasePath(worker.path)).toBe(false);
  expect(() => assertAgentSessionWriteAdmission({ agentId: "worker", env })).not.toThrow();
});

it("keeps the database open until an in-flight turn finishes", async () => {
  const { opened } = installState(["main", "worker"]);
  const worker = opened.find((database) => database.agentId === "worker");
  if (!worker) {
    throw new Error("fixture did not open worker");
  }
  const turn = await beginSessionEffect({
    agentId: "worker",
    env: process.env,
    scope: worker.path,
    identities: ["agent:worker:live"],
    owner: Symbol("live-turn"),
    assertAllowed: () => {},
  });
  try {
    await commitRoster(createHandlers(), roster(["main"]));
    expect(turn.isActive()).toBe(true);
    expect(worker.database.db.isOpen).toBe(true);
    expect(holderIds()).toContain("worker");
    const closed = waitForDepartedAgentDatabaseRelease("worker");
    turn.release();
    await closed;
    expect(worker.database.db.isOpen).toBe(false);
    expect(fs.existsSync(worker.path)).toBe(true);
  } finally {
    turn.release();
  }
});

it("cancels a pending database release when the agent is re-added", async () => {
  const { opened } = installState(["main", "worker"]);
  const worker = opened.find((database) => database.agentId === "worker");
  if (!worker) {
    throw new Error("fixture did not open worker");
  }
  const turn = await beginSessionEffect({
    agentId: "worker",
    env: process.env,
    scope: worker.path,
    identities: ["agent:worker:returning"],
    owner: Symbol("returning-turn"),
    assertAllowed: () => {},
  });
  try {
    const handlers = createHandlers();
    await commitRoster(handlers, roster(["main"]));
    expect(worker.database.db.isOpen).toBe(true);
    const release = waitForDepartedAgentDatabaseRelease("worker");
    await commitRoster(handlers, roster(["main", "worker"]));
    turn.release();
    await release;
    expect(holderIds()).toContain("worker");
    expect(isDeletedAgentDatabasePath(worker.path)).toBe(false);
    expect(worker.database.db.isOpen).toBe(true);
  } finally {
    turn.release();
  }
});

it("lets a held embedded turn finish before closing its database", async () => {
  const { opened } = installState(["main", "worker"]);
  const worker = opened.find((database) => database.agentId === "worker");
  if (!worker) {
    throw new Error("fixture did not open worker");
  }
  const target = {
    agentId: "worker",
    sessionId: "worker-held-model",
    sessionKey: "agent:worker:main",
    storePath: worker.path,
  };
  await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
  const held = createDeferred();
  const releaseHold = createDeferred();
  const streamAbort = new AbortController();
  const sessionId = "worker-held-model";
  const handle = createEmbeddedRunHandle({
    runId: "held-embedded-turn",
    abort: () => streamAbort.abort(),
  });
  attachActiveEmbeddedRun(sessionId, handle, undefined, undefined, "worker");
  onTestFinished(() => {
    detachActiveEmbeddedRun(sessionId, handle);
  });
  const model = makeProviderModelFixture({
    id: "held-model",
    provider: "held-provider",
    api: "openai-responses",
    baseUrl: "https://example.test",
  });
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(model.provider, "test-api-key");
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider(model.provider, {
    api: model.api,
    streamSimple: (_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      held.resolve();
      let finished = false;
      const finish = (outcome: "completed" | "aborted") => {
        if (finished) {
          return;
        }
        finished = true;
        const message = {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: outcome === "completed" ? "STUB_OK" : "" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: outcome === "completed" ? ("stop" as const) : ("aborted" as const),
          timestamp: 1,
          usage: createZeroUsageFixture(),
        };
        if (outcome === "completed") {
          stream.push({ type: "done", reason: "stop", message });
        } else {
          stream.push({ type: "error", reason: "aborted", error: message });
        }
        stream.end();
      };
      const signal = options?.signal;
      const abort = () => finish("aborted");
      if (signal?.aborted || streamAbort.signal.aborted) {
        abort();
      } else {
        signal?.addEventListener("abort", abort, { once: true });
        streamAbort.signal.addEventListener("abort", abort, { once: true });
        void releaseHold.promise.then(() => finish("completed"));
      }
      return stream;
    },
  });
  const { session } = await createAgentSession({
    cwd: path.dirname(worker.path),
    systemPrompt: "Test session prompt",
    model,
    thinkingLevel: "off",
    tools: [],
    sessionManager: SessionManager.open(target, path.dirname(worker.path)),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    modelRegistry,
    resourceLoader: await createResourceLoader(),
  });
  onTestFinished(() => {
    void session.abort().catch(() => undefined);
    session.dispose();
  });
  const records: Array<{ text: string; stopReason: string; open: boolean }> = [];
  let turnAborted = false;
  session.subscribe((event) => {
    if (event.type !== "message_end") {
      return;
    }
    const message = event.message;
    if (message.role === "assistant") {
      const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      records.push({
        text,
        stopReason: message.stopReason,
        open: worker.database.db.isOpen,
      });
    }
    if (message.role === "custom" && message.customType === "openclaw:turn-aborted") {
      turnAborted = true;
    }
  });
  const prompt = session.prompt("active-held-inspect").finally(() => {
    detachActiveEmbeddedRun(sessionId, handle);
  });
  await held.promise;
  await commitRoster(createHandlers(), roster(["main"]));
  expect(worker.database.db.isOpen).toBe(true);
  expect(holderIds()).toContain("worker");
  releaseHold.resolve();
  await prompt;
  expect(records).toContainEqual({ text: "STUB_OK", stopReason: "stop", open: true });
  expect(turnAborted).toBe(false);
  await waitForDepartedAgentDatabaseRelease("worker");
  expect(worker.database.db.isOpen).toBe(false);
  expect(fs.existsSync(worker.path)).toBe(true);
  const persisted = readClosedAgentDatabase(worker.path);
  expect(persisted.sessionKey).toBe("agent:worker:main");
  expect(persisted.transcript).toContain("STUB_OK");
  expect(persisted.transcript).toContain('"stopReason":"stop"');
});

it("closes idle native history lanes when their close latch is false", async () => {
  const { opened } = installState(["main", "worker"]);
  const worker = opened.find((database) => database.agentId === "worker");
  if (!worker) {
    throw new Error("fixture did not open worker");
  }
  // One latched history lane and one WorkerTaskPool read lane. Starting every
  // history lane is worker-process startup, which is the multi-second cost on CI.
  // The product close itself gives up after 1s; this test waits for the promise.
  await readHistoryPresence(worker.path);
  await readSessionEntrySnapshotInWorker(
    worker.path,
    {
      agentId: "worker",
      sessionId: "missing-session",
      storePath: worker.path,
      sessionKey: "agent:worker:main",
    },
    false,
  );
  expect(getSqliteRuntimeCapabilities().explicitSqliteCloseReleasesNativeResources).toBe(true);
  const latch = vi.spyOn(historyLane.pool, "canCloseNativeResources").mockReturnValue(false);
  try {
    await commitRoster(createHandlers(), roster(["main"]));
    expect(worker.database.db.isOpen).toBe(false);
    expect(fs.existsSync(worker.path)).toBe(true);
  } finally {
    latch.mockRestore();
  }
});

it("waits for a trajectory retention retain that finishes inside the reload budget", async () => {
  const { opened } = installState(["main", "worker"]);
  const worker = opened.find((database) => database.agentId === "worker");
  if (!worker) {
    throw new Error("fixture did not open worker");
  }
  const target = { agentId: "worker", path: worker.path, env: process.env };
  const retained = retainSessionHistoryWorkerDatabase(target, maintenanceLane);
  let released = false;
  const sweep = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      retained.release();
      released = true;
      resolve();
    }, 150);
    timer.unref();
  });
  trackSessionHistoryHostEffect(target, sweep);
  onTestFinished(() => {
    if (!released) {
      retained.release();
    }
  });
  await commitRoster(createHandlers(), roster(["main"]));
  expect(released).toBe(true);
  expect(worker.database.db.isOpen).toBe(false);
  expect(fs.existsSync(worker.path)).toBe(true);
});

it("does not block reload when a history read has no completion promise", async () => {
  const { opened } = installState(["main", "worker"]);
  const worker = opened.find((database) => database.agentId === "worker");
  if (!worker) {
    throw new Error("fixture did not open worker");
  }
  const retained = retainSessionHistoryWorkerDatabase({
    agentId: "worker",
    path: worker.path,
    env: process.env,
  });
  onTestFinished(() => retained.release());
  await retained.owner.readEntryPresence({
    agentId: "worker",
    sessionKey: "agent:worker:main",
    storePath: worker.path,
    databaseAgentId: "worker",
    env: process.env,
  });
  await commitRoster(createHandlers(), roster(["main"]));
  expect(worker.database.db.isOpen).toBe(true);
});
