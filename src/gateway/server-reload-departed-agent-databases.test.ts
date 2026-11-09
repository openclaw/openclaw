import fs from "node:fs";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isDeletedAgentDatabasePath } from "../infra/agent-database-readers.js";
import { retainSqliteDatabaseAdmissionLocation } from "../infra/sqlite-database-admission.js";
import {
  assertAgentSessionWriteAdmission,
  sessionWorkAdmissionClosures,
} from "../sessions/session-agent-work-admission.js";
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
  expect(() => assertAgentSessionWriteAdmission({ agentId: "worker", env: process.env })).toThrow(
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

it("settles an active turn before closing the removed agent's database", async () => {
  const { opened } = installState(["main", "worker"]);
  const worker = opened.find((database) => database.agentId === "worker");
  if (!worker) {
    throw new Error("fixture did not open worker");
  }
  const interrupted = createDeferred();
  let openWhenInterrupted = false;
  const turn = await beginSessionEffect({
    agentId: "worker",
    env: process.env,
    scope: worker.path,
    identities: ["agent:worker:live"],
    owner: Symbol("live-turn"),
    assertAllowed: () => {},
    onInterrupt: () => {
      openWhenInterrupted = worker.database.db.isOpen;
      interrupted.resolve();
      turn.release();
    },
  });
  const removal = commitRoster(createHandlers(), roster(["main"]));
  const winner = await Promise.race([
    interrupted.promise.then(() => "interrupted" as const),
    removal.then(() => "closed" as const),
  ]);
  expect(winner).toBe("interrupted");
  expect(openWhenInterrupted).toBe(true);
  await removal;
  expect(holderIds()).not.toContain("worker");
  expect(isDeletedAgentDatabasePath(worker.path)).toBe(true);
});

it("clears the session-write block when cleanup fails and the agent is re-added", async () => {
  const { env } = installState(["main", "worker"]);
  const memory = await import("../plugins/memory-runtime.js");
  const closeMemory = vi
    .spyOn(memory, "closeActiveMemorySearchManagerCore")
    .mockRejectedValueOnce(new Error("memory close failed"));
  try {
    await commitRoster(createHandlers(), roster(["main"]));
    const workerWriteBlocked = () =>
      [...sessionWorkAdmissionClosures].some(
        (closure) => closure.agent?.agentId === "worker" && closure.identities.length === 0,
      );
    expect(workerWriteBlocked()).toBe(true);
    await commitRoster(createHandlers(), roster(["main", "worker"]));
    expect(workerWriteBlocked()).toBe(false);
    expect(() => assertAgentSessionWriteAdmission({ agentId: "worker", env })).not.toThrow();
  } finally {
    closeMemory.mockRestore();
  }
});
