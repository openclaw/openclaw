import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import * as configEnv from "../config/config-env-vars.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  readSessionIdentityEvidenceBatch,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { createWorkerPlacementSessionEvidenceResolver } from "./server-worker-placement-session-evidence.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const boundary = vi.hoisted(
  (): {
    afterReply?: (reply: unknown) => Promise<void>;
    afterCleanup?: () => Promise<void>;
    failRetirement: boolean;
  } => ({ failRetirement: false }),
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
          if (observedRead && boundary.failRetirement) {
            throw new Error("synthetic retirement failure");
          }
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
  boundary.failRetirement = false;
  vi.restoreAllMocks();
});

async function placement(
  sessionId = "subject",
  agentId = "main",
  sessionKey = `agent:${agentId}:${sessionId}`,
) {
  return await createWorkerSessionPlacementStore({
    database: openOpenClawStateDatabase(),
  }).startDispatch({
    sessionId,
    sessionKey,
    agentId,
  });
}

function pauseRegistry() {
  const resume = createDeferredCore();
  const entered = createDeferredCore();
  const prepare = registry.prepareOpenClawAgentDatabaseRegistrySnapshotRead;
  const spy = vi
    .spyOn(registry, "prepareOpenClawAgentDatabaseRegistrySnapshotRead")
    .mockImplementationOnce((...args) => {
      const prepared = prepare(...args);
      return {
        assertCurrent: prepared.assertCurrent,
        read: async () => {
          entered.resolve();
          await resume.promise;
          return await prepared.read();
        },
      };
    });
  return {
    entered: entered.promise,
    resume: () => resume.resolve(),
    restore: () => spy.mockRestore(),
  };
}

function pauseInventory() {
  const resume = createDeferredCore();
  const entered = createDeferredCore();
  boundary.afterReply = async (reply) => {
    if (
      isRecord(reply) &&
      reply.ok === true &&
      isRecord(reply.value) &&
      reply.value.kind === "session-target-inventory"
    ) {
      boundary.afterReply = undefined;
      entered.resolve();
      await resume.promise;
    }
  };
  return {
    entered: entered.promise,
    resume: () => resume.resolve(),
    restore: () => {
      boundary.afterReply = undefined;
    },
  };
}

function isEvidenceReply(reply: unknown): boolean {
  return (
    isRecord(reply) &&
    reply.ok === true &&
    isRecord(reply.value) &&
    reply.value.kind === "session-identity-evidence"
  );
}

it.each([false, true])(
  "retains only requested registry currency after invalidation (registered=%s)",
  async (registered) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const subject = await placement();
      const store = registered ? state.statePath("custom", "shared.json") : undefined;
      const cfg: OpenClawConfig = store ? { session: { store } } : {};
      setRuntimeConfigSnapshot(cfg, cfg);
      replaceSessionEntrySync(
        { ...subject, ...(store ? { storePath: store } : {}) },
        { sessionId: subject.sessionId, updatedAt: 1 },
      );
      registry.readOpenClawAgentDatabaseRegistryToken();
      const prepare = registry.prepareOpenClawAgentDatabaseRegistrySnapshotRead;
      let registryReads = 0;
      vi.spyOn(registry, "prepareOpenClawAgentDatabaseRegistrySnapshotRead").mockImplementation(
        (...args) => {
          const captured = prepare(...args);
          return {
            ...captured,
            read: () => {
              registryReads += 1;
              return captured.read();
            },
          };
        },
      );
      let observedEvidence = false;
      boundary.afterReply = async (reply) => {
        if (isEvidenceReply(reply)) {
          observedEvidence = true;
          expect(registry.invalidateRegisteredAgentDatabasesMemo({})).toBeDefined();
        }
      };
      const resolve = await createWorkerPlacementSessionEvidenceResolver([subject]);
      expect(observedEvidence).toBe(true);
      expect(registryReads).toBe(registered ? 1 : 0);
      expect(await resolve(subject)).toBe(registered ? "unknown" : "current");
    });
  },
);

it.each(["path", "root", "agent"] as const)(
  "revokes unresolved discovery before a %s close can finish",
  async (selection) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const subject = await placement();
      replaceSessionEntrySync(subject, { sessionId: subject.sessionId, updatedAt: 1 });
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const gate = pauseInventory();
      const pending = createWorkerPlacementSessionEvidenceResolver([subject]);
      try {
        await gate.entered;
        if (selection === "path") {
          await closeOpenClawAgentDatabaseByPathAsync(database.path, "main");
        } else if (selection === "root") {
          await closeOpenClawAgentDatabasesAsync(path.dirname(database.path));
        } else {
          await drainAgentDatabaseResources({ agentId: "main" }, async () => {});
        }
        gate.resume();
        expect(await (await pending)(subject)).toBe("unknown");
        expect(await (await createWorkerPlacementSessionEvidenceResolver([subject]))(subject)).toBe(
          "current",
        );
      } finally {
        gate.resume();
        await pending;
        gate.restore();
      }
    });
  },
);

it.each([false, true])(
  "retains a newly resolved legacy suffix during registry discovery (close=%s)",
  async (close) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const store = state.statePath("custom", "shared.json");
      const cfg: OpenClawConfig = { session: { store } };
      setRuntimeConfigSnapshot(cfg, cfg);
      const subject = await placement();
      openOpenClawAgentDatabase({
        agentId: "other",
        path: state.statePath("custom", "shared.sqlite"),
      });
      const gate = pauseRegistry();
      const pending = createWorkerPlacementSessionEvidenceResolver([subject]);
      try {
        await gate.entered;
        const suffix = state.statePath("custom", "shared.main.2.sqlite");
        replaceSessionEntrySync(
          { ...subject, storePath: suffix },
          { sessionId: subject.sessionId, updatedAt: 1 },
        );
        if (close) {
          await closeOpenClawAgentDatabaseByPathAsync(suffix, "main");
        }
        gate.resume();
        expect(await (await pending)(subject)).toBe(close ? "unknown" : "current");
      } finally {
        gate.resume();
        await pending;
        gate.restore();
      }
    });
  },
);

it("captures config, environment, cwd and placement identity before discovery yields", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const store = path.relative(process.cwd(), state.statePath("captured.sqlite"));
    const cfg: OpenClawConfig = { session: { store } };
    setRuntimeConfigSnapshot(cfg, cfg);
    const subject = await placement();
    replaceSessionEntrySync(
      { ...subject, storePath: store },
      { sessionId: subject.sessionId, updatedAt: 1 },
    );
    const gate = pauseRegistry();
    const pending = createWorkerPlacementSessionEvidenceResolver([subject]);
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
  });
});

it.each(["evidence write", "settlement write", "alias retarget"] as const)(
  "rejects stale absence after %s",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const physical = state.statePath("physical.sqlite");
      const alias = state.statePath("alias.sqlite");
      openOpenClawAgentDatabase({ agentId: "main", path: physical });
      fs.symlinkSync(physical, alias);
      const cfg: OpenClawConfig = { session: { store: alias } };
      setRuntimeConfigSnapshot(cfg, cfg);
      const subject = await placement();
      // A fixed shared store is selected only for agents with persisted scoped rows.
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:anchor", storePath: physical },
        { sessionId: "anchor", updatedAt: 1 },
      );
      const replacement = state.statePath("replacement.sqlite");
      if (change === "alias retarget") {
        replaceSessionEntrySync(
          { ...subject, storePath: replacement },
          { sessionId: subject.sessionId, updatedAt: 1 },
        );
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
          replaceSessionEntrySync(
            { ...subject, storePath: physical },
            { sessionId: subject.sessionId, updatedAt: 2 },
          );
        }
      };
      let evidenceRead = false;
      boundary.afterReply = async (reply) => {
        if (isEvidenceReply(reply)) {
          evidenceRead = true;
          if (change !== "settlement write") {
            boundary.afterReply = undefined;
            mutate();
          }
        }
      };
      boundary.afterCleanup = async () => {
        if (change === "settlement write" && evidenceRead) {
          mutate();
        }
      };
      try {
        expect(await (await createWorkerPlacementSessionEvidenceResolver([subject]))(subject)).toBe(
          "unknown",
        );
        expect(evidenceRead).toBe(true);
        expect(changed).toBe(true);
      } finally {
        boundary.afterReply = undefined;
        boundary.afterCleanup = undefined;
      }
      expect(await (await createWorkerPlacementSessionEvidenceResolver([subject]))(subject)).toBe(
        "current",
      );
    });
  },
);

it.each(["path", "root"] as const)(
  "retains lexical alias custody through failed physical retirement for a %s close",
  async (selection) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const physical = state.statePath("physical.sqlite");
      const aliasDir = state.statePath("aliases");
      fs.mkdirSync(aliasDir);
      const alias = path.join(aliasDir, "session.sqlite");
      const subject = await placement();
      replaceSessionEntrySync(
        { ...subject, storePath: physical },
        { sessionId: subject.sessionId, updatedAt: 1 },
      );
      fs.symlinkSync(physical, alias);
      const cfg: OpenClawConfig = { session: { store: alias } };
      setRuntimeConfigSnapshot(cfg, cfg);
      boundary.afterReply = async (reply) => {
        if (isEvidenceReply(reply)) {
          boundary.failRetirement = true;
          throw new Error("synthetic reply failure");
        }
      };
      try {
        expect(await (await createWorkerPlacementSessionEvidenceResolver([subject]))(subject)).toBe(
          "unknown",
        );
        boundary.afterReply = undefined;
        const close = () =>
          selection === "path"
            ? closeOpenClawAgentDatabaseByPathAsync(alias, "main")
            : closeOpenClawAgentDatabasesAsync(aliasDir);
        // An alias-only close must still find the failed physical reader's custody.
        const resourceFailure = {
          message: "Agent database resource drainage failed",
          errors: expect.arrayContaining([
            expect.objectContaining({ message: "synthetic retirement failure" }),
          ]),
        };
        await expect(close()).rejects.toMatchObject(
          selection === "path"
            ? resourceFailure
            : {
                message: "Agent database close failed",
                errors: expect.arrayContaining([expect.objectContaining(resourceFailure)]),
              },
        );
        boundary.failRetirement = false;
        await close();
        expect(await (await createWorkerPlacementSessionEvidenceResolver([subject]))(subject)).toBe(
          "current",
        );
      } finally {
        boundary.afterReply = undefined;
        boundary.failRetirement = false;
      }
    });
  },
);

it("rejects discovery revoked during final reader cleanup", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const subject = await placement();
    replaceSessionEntrySync(subject, { sessionId: subject.sessionId, updatedAt: 1 });
    let revoke: Promise<void> | undefined;
    boundary.afterCleanup = async () => {
      boundary.afterCleanup = undefined;
      // Close joins native cleanup; do not wait for ourselves here.
      revoke = drainAgentDatabaseResources({ agentId: "main" }, async () => {});
    };
    try {
      expect(await (await createWorkerPlacementSessionEvidenceResolver([subject]))(subject)).toBe(
        "unknown",
      );
      expect(revoke).toBeDefined();
      await revoke;
    } finally {
      boundary.afterCleanup = undefined;
      await revoke;
    }
  });
});

it("transfers a Windows-normalized environment through inventory and evidence workers", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const subject = await placement();
    replaceSessionEntrySync(subject, { sessionId: subject.sessionId, updatedAt: 1 });
    const { OPENCLAW_STATE_DIR, ...otherEnv } = process.env;
    const normalized = withMockedPlatform("win32", () =>
      configEnv.cloneEnvWithPlatformSemantics({
        ...otherEnv,
        OpenClaw_State_Dir: OPENCLAW_STATE_DIR,
      }),
    );
    expect(() => structuredClone(normalized)).toThrow();
    const clone = vi
      .spyOn(configEnv, "cloneEnvWithPlatformSemantics")
      .mockReturnValueOnce(normalized);
    try {
      expect(await (await createWorkerPlacementSessionEvidenceResolver([subject]))(subject)).toBe(
        "current",
      );
    } finally {
      clone.mockRestore();
    }
  });
});

it("rereads incognito absence when a row appears in the same native owner during disk work", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const disk = await placement("disk-current");
    const incognito = await placement(
      "private-created",
      "main",
      "agent:main:dashboard:incognito-created",
    );
    replaceSessionEntrySync(disk, { sessionId: disk.sessionId, updatedAt: 1 });
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:dashboard:incognito-anchor" },
      {
        sessionId: "private-anchor",
        updatedAt: 1,
      },
    );
    let wrote = false;
    boundary.afterReply = async (reply) => {
      if (isEvidenceReply(reply)) {
        boundary.afterReply = undefined;
        replaceSessionEntrySync(incognito, { sessionId: incognito.sessionId, updatedAt: 2 });
        wrote = true;
      }
    };
    try {
      const resolve = await createWorkerPlacementSessionEvidenceResolver([disk, incognito]);
      expect(wrote).toBe(true);
      expect(await Promise.all([disk, incognito].map(resolve))).toEqual(["current", "current"]);
    } finally {
      boundary.afterReply = undefined;
    }
  });
});

it("keeps the fixed physical owner and current precedence across canonical and malformed legacy rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const store = state.statePath("shared.sqlite");
    const database = openOpenClawAgentDatabase({ agentId: "main", path: store });
    const cfg: OpenClawConfig = {
      agents: { entries: { ops: {} } },
      session: { store },
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    const subject = await placement("shared-subject", "ops");
    subject.sessionKey = "agent:main:main";
    for (const agentId of ["main", "ops"]) {
      replaceSessionEntrySync(
        { agentId, sessionKey: `agent:${agentId}:main`, storePath: store },
        {
          sessionId: subject.sessionId,
          updatedAt: 1,
        },
      );
    }
    expect(
      readSessionIdentityEvidenceBatch([
        {
          agentId: "ops",
          sessionId: subject.sessionId,
          sessionKey: "agent:ops:main",
          storePath: store,
        },
      ]),
    ).toEqual([{ status: "current", sessionKey: "agent:ops:main" }]);
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ?, entry_valid = 1 WHERE session_key = ?")
      .run("{", "agent:main:main");
    const resolve = await createWorkerPlacementSessionEvidenceResolver([subject]);
    expect(await resolve(subject)).toBe("current");
  });
});
