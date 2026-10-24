import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import * as configEnv from "../config/config-env-vars.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.entry.js";
import {
  readSessionIdentityEvidenceBatch,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runWithSqliteDatabaseAdmissionTurn } from "../infra/sqlite-database-admission-turn.js";
import type { WorkerTaskPool } from "../infra/worker-task-pool.js";
import type {
  WorkerTaskPoolOptions,
  WorkerTaskPoolOwnerOptions,
} from "../infra/worker-task-pool.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
} from "../state/openclaw-agent-db-lifecycle.js";
import * as registry from "../state/openclaw-agent-db-registry-listing.js";
import { drainAgentDatabaseResources } from "../state/openclaw-agent-db-resources.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { createWorkerPlacementSessionEvidenceResolver as createResolver } from "./server-worker-placement-session-evidence.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { sessionIdentity } from "./worker-environments/placement-suite.test-support.js";

const boundary = vi.hoisted(
  (): {
    afterReply?: (reply: unknown) => Promise<void>;
    afterCleanup?: () => Promise<void>;
  } => ({}),
);
vi.mock("../infra/worker-task-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/worker-task-pool.js")>();
  return {
    ...actual,
    createOwnedWorkerTaskPool: <Input, Output>(
      options: WorkerTaskPoolOptions<Output>,
      ownerOptions?: WorkerTaskPoolOwnerOptions,
    ) => {
      const pool = actual.createOwnedWorkerTaskPool<Input, Output>(options, ownerOptions);
      let observedRead = false;
      return {
        ...pool,
        run(...args: Parameters<WorkerTaskPool<Input, Output>["run"]>) {
          observedRead = true;
          const result = pool.run(...args);
          const observe = boundary.afterReply;
          return observe
            ? result.then(async (reply) => {
                await observe(reply);
                return reply;
              })
            : result;
        },
        async rotate() {
          await pool.rotate();
          if (observedRead) {
            await boundary.afterCleanup?.();
          }
        },
        async closeResources(...args: Parameters<typeof pool.closeResources>) {
          await pool.closeResources(...args);
          if (observedRead) {
            await boundary.afterCleanup?.();
          }
        },
      };
    },
  };
});

afterEach(() => {
  boundary.afterReply = undefined;
  boundary.afterCleanup = undefined;
  vi.restoreAllMocks();
});

async function placement(
  sessionId = "subject",
  agentId = "main",
  sessionKey = `agent:${agentId}:${sessionId}`,
) {
  return await createWorkerSessionPlacementStore({
    database: openOpenClawStateDatabase(),
  }).startDispatch({ sessionId, sessionKey, agentId });
}

function onReply(kind: string, run: () => void | Promise<void>, once = true) {
  boundary.afterReply = async (reply) => {
    if (isWorkerReply(reply, kind)) {
      if (once) {
        boundary.afterReply = undefined;
      }
      await run();
    }
  };
}

function pauseRead(phase: "registry" | "inventory") {
  const resume = createDeferredCore();
  const entered = createDeferredCore();
  const wait = () => {
    entered.resolve();
    return resume.promise;
  };
  let restore: () => void;
  if (phase === "registry") {
    const prepare = registry.prepareOpenClawAgentDatabaseRegistrySnapshotRead;
    const spy = vi
      .spyOn(registry, "prepareOpenClawAgentDatabaseRegistrySnapshotRead")
      .mockImplementationOnce((...args) => {
        const prepared = prepare(...args);
        return {
          ...prepared,
          read: async () => {
            await wait();
            return prepared.read();
          },
        };
      });
    restore = () => spy.mockRestore();
  } else {
    onReply("session-target-inventory", wait);
    restore = () => {
      boundary.afterReply = undefined;
    };
  }
  return {
    entered: entered.promise,
    resume: () => resume.resolve(),
    restore,
  };
}

function isWorkerReply(reply: unknown, kind: string): boolean {
  return isRecord(reply) && reply.ok === true && isRecord(reply.value) && reply.value.kind === kind;
}

function writeSession(
  identity: Parameters<typeof replaceSessionEntrySync>[0] & { sessionId: string },
  updatedAt = 1,
) {
  replaceSessionEntrySync(identity, { sessionId: identity.sessionId, updatedAt });
}

function writeMemorySession(
  identity: Parameters<typeof upsertSessionEntryCore>[0] & { sessionId: string },
  updatedAt = 1,
) {
  return upsertSessionEntryCore(identity, { sessionId: identity.sessionId, updatedAt });
}

async function resolveEvidence(subject: Awaited<ReturnType<typeof placement>>) {
  return (await createResolver([subject]))(subject);
}

function withState<T>(run: Parameters<typeof withOpenClawTestState<T>>[1]): Promise<T> {
  return withOpenClawTestState({ scenario: "minimal" }, run);
}

async function withDiscoveryPause(
  subject: Awaited<ReturnType<typeof placement>>,
  gate: ReturnType<typeof pauseRead>,
  run: (pending: ReturnType<typeof createResolver>) => Promise<void>,
) {
  const pending = createResolver([subject]);
  try {
    await gate.entered;
    await run(pending);
  } finally {
    gate.resume();
    await pending;
    gate.restore();
  }
}

it.for(["discovery", "identity"] as const)(
  "cancels placement evidence during %s admission without abandoning its writer",
  (phase, { signal }) =>
    withState(async () => {
      setRuntimeConfigSnapshot({});
      const subject = await placement();
      await writeMemorySession(subject);
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const databasePath = database.path;
      await closeOpenClawAgentDatabasesAsync();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const controller = new AbortController();
      const interrupted = new Error("placement evidence stopped");
      let writerSettled = false;
      let writer: Promise<void> | undefined;
      const holdWriter = () => {
        entered.resolve();
        return release.promise.then(() => {
          writerSettled = true;
        });
      };
      if (phase === "discovery") {
        writer = runWithSqliteDatabaseAdmissionTurn([], holdWriter, [path.dirname(databasePath)]);
        await withinTest(entered.promise, signal);
      } else {
        onReply("session-target-inventory", async () => {
          writer = runOpenClawAgentWriteAdmission(
            { agentId: "main", path: databasePath },
            holdWriter,
          );
          await entered.promise;
        });
      }
      const pending = createResolver([subject], controller.signal);
      void pending.catch(() => {});
      try {
        await withinTest(entered.promise, signal);
        controller.abort(interrupted);
        await expect(withinTest(pending, signal)).rejects.toBe(interrupted);
        expect(writerSettled).toBe(false);
      } finally {
        boundary.afterReply = undefined;
        release.resolve();
        await Promise.allSettled([writer, pending]);
      }
      expect(writerSettled).toBe(true);
      expect(await resolveEvidence(subject)).toBe("current");
    }),
);

it.each(["path", "root", "agent"] as const)(
  "revokes unresolved discovery before a %s close can finish",
  (selection) =>
    withState(async () => {
      setRuntimeConfigSnapshot({});
      const subject = await placement();
      writeSession(subject);
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const gate = pauseRead("inventory");
      await withDiscoveryPause(subject, gate, async (pending) => {
        if (selection === "path") {
          await closeOpenClawAgentDatabaseByPathAsync(database.path, "main");
        } else if (selection === "root") {
          await closeOpenClawAgentDatabasesAsync(path.dirname(database.path));
        } else {
          await drainAgentDatabaseResources({ agentId: "main" }, async () => {});
        }
        gate.resume();
        expect(await (await pending)(subject)).toBe("unknown");
        expect(await resolveEvidence(subject)).toBe("current");
      });
    }),
);

it.each([false, true])(
  "retains a newly resolved legacy suffix during registry discovery (close=%s)",
  (close) =>
    withState(async (state) => {
      const store = state.statePath("custom", "shared.json");
      const cfg: OpenClawConfig = { session: { store } };
      setRuntimeConfigSnapshot(cfg, cfg);
      const subject = await placement();
      openOpenClawAgentDatabase({
        agentId: "other",
        path: state.statePath("custom", "shared.sqlite"),
      });
      const gate = pauseRead("registry");
      await withDiscoveryPause(subject, gate, async (pending) => {
        const suffix = state.statePath("custom", "shared.main.2.sqlite");
        writeSession({ ...subject, storePath: suffix });
        if (close) {
          await closeOpenClawAgentDatabaseByPathAsync(suffix, "main");
        }
        gate.resume();
        expect(await (await pending)(subject)).toBe(close ? "unknown" : "current");
      });
    }),
);

it("captures config, environment, cwd and placement identity before discovery yields", () =>
  withState(async (state) => {
    const store = path.relative(process.cwd(), state.statePath("captured.sqlite"));
    const cfg: OpenClawConfig = { session: { store } };
    setRuntimeConfigSnapshot(cfg, cfg);
    const subject = await placement();
    writeSession({ ...subject, storePath: store });
    const gate = pauseRead("registry");
    const pending = createResolver([subject]);
    const originalRoot = process.env.OPENCLAW_STATE_DIR;
    const cwd = vi.spyOn(process, "cwd");
    try {
      await gate.entered;
      cwd.mockReturnValue(state.stateDir);
      cfg.session!.store = state.statePath("successor.sqlite");
      process.env.OPENCLAW_STATE_DIR = state.statePath("other-root");
      gate.resume();
      const resolve = await pending;
      expect(await resolve(subject)).toBe("current");
      subject.sessionId = "mutated-subject";
      expect(await resolve(subject)).toBe("unknown");
      expect(fs.existsSync(cfg.session!.store)).toBe(false);
      expect(fs.existsSync(process.env.OPENCLAW_STATE_DIR)).toBe(false);
    } finally {
      process.env.OPENCLAW_STATE_DIR = originalRoot;
      cwd.mockRestore();
      gate.resume();
      await pending;
      gate.restore();
    }
  }));

it.each(["evidence write", "settlement write", "alias retarget"] as const)(
  "rejects stale absence after %s",
  (change) =>
    withState(async (state) => {
      const physical = state.statePath("physical.sqlite");
      const alias = state.statePath("alias.sqlite");
      openOpenClawAgentDatabase({ agentId: "main", path: physical });
      fs.symlinkSync(physical, alias);
      const cfg: OpenClawConfig = { session: { store: alias } };
      setRuntimeConfigSnapshot(cfg, cfg);
      const subject = await placement();
      // A fixed shared store is selected only for agents with persisted scoped rows.
      writeSession({ ...sessionIdentity("anchor"), storePath: physical });
      const replacement = state.statePath("replacement.sqlite");
      if (change === "alias retarget") {
        writeSession({ ...subject, storePath: replacement });
      }
      let changed = false;
      const mutate = () => {
        if (changed) {
          return;
        }
        changed = true;
        if (change === "alias retarget") {
          fs.unlinkSync(alias);
          fs.symlinkSync(replacement, alias);
        } else {
          writeSession({ ...subject, storePath: physical }, 2);
        }
      };
      let evidenceRead = false;
      onReply(
        "session-identity-evidence",
        () => {
          evidenceRead = true;
          if (change !== "settlement write") {
            mutate();
          }
        },
        change !== "settlement write",
      );
      boundary.afterCleanup = async () => {
        if (change === "settlement write" && evidenceRead) {
          mutate();
        }
      };
      try {
        expect(await resolveEvidence(subject)).toBe("unknown");
        expect(evidenceRead).toBe(true);
        expect(changed).toBe(true);
      } finally {
        boundary.afterReply = undefined;
        boundary.afterCleanup = undefined;
      }
      expect(await resolveEvidence(subject)).toBe("current");
    }),
);

it("transfers a Windows-normalized environment through inventory and evidence workers", () =>
  withState(async () => {
    setRuntimeConfigSnapshot({});
    const subject = await placement();
    writeSession(subject);
    const { OPENCLAW_STATE_DIR, ...otherEnv } = process.env;
    const normalized = withMockedPlatform("win32", () =>
      configEnv.cloneEnvWithPlatformSemantics({
        ...otherEnv,
        OpenClaw_State_Dir: OPENCLAW_STATE_DIR,
      }),
    );
    expect(() => structuredClone(normalized)).toThrow();
    using _ = vi.spyOn(configEnv, "cloneEnvWithPlatformSemantics").mockReturnValueOnce(normalized);
    expect(await resolveEvidence(subject)).toBe("current");
  }));

it("reads memory evidence after an in-process write completes during disk work", () =>
  withState(async () => {
    setRuntimeConfigSnapshot({});
    const disk = await placement("disk-current");
    const incognito = await placement(
      "private-created",
      "main",
      "agent:main:dashboard:incognito-created",
    );
    writeSession(disk);
    await writeMemorySession({
      agentId: "main",
      sessionKey: "agent:main:dashboard:incognito-anchor",
      sessionId: "private-anchor",
    });
    let wrote = false;
    onReply("session-identity-evidence", async () => {
      await writeMemorySession(incognito, 2);
      wrote = true;
    });
    try {
      const resolve = await createResolver([disk, incognito]);
      expect(wrote).toBe(true);
      expect(await Promise.all([disk, incognito].map(resolve))).toEqual(["current", "current"]);
    } finally {
      boundary.afterReply = undefined;
    }
  }));

it("keeps the fixed physical owner and current precedence across canonical and malformed legacy rows", () =>
  withState(async (state) => {
    const store = state.statePath("shared.sqlite");
    const database = openOpenClawAgentDatabase({ agentId: "main", path: store });
    const cfg: OpenClawConfig = {
      agents: { entries: { ops: {} } },
      session: { store },
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    const subject = await placement("shared-subject", "ops");
    subject.sessionKey = "agent:main:main";
    const canonical = { ...subject, sessionKey: "agent:ops:main", storePath: store };
    for (const agentId of ["main", "ops"]) {
      writeSession({
        ...canonical,
        agentId,
        sessionKey: `agent:${agentId}:main`,
      });
    }
    expect(readSessionIdentityEvidenceBatch([canonical])).toEqual([
      { status: "current", sessionKey: "agent:ops:main" },
    ]);
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ?, entry_valid = 1 WHERE session_key = ?")
      .run("{", "agent:main:main");
    expect(await resolveEvidence(subject)).toBe("current");
  }));
