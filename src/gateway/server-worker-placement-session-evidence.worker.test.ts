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
import type { WorkerTaskPoolOptions } from "../infra/worker-task-pool.types.js";
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
    afterRotate?: () => Promise<void>;
    failRetirement: boolean;
  } => ({ failRetirement: false }),
);
vi.mock("../infra/worker-task-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/worker-task-pool.js")>();
  return {
    ...actual,
    WorkerTaskPool: class<Input, Output> extends actual.WorkerTaskPool<Input, Output> {
      constructor(options: WorkerTaskPoolOptions<Output>) {
        // Exercise real queue admission without retaining hundreds of megabytes.
        super({ ...options, maxPendingBytes: 256 * 1024 });
      }
      override run(...args: Parameters<WorkerTaskPool<Input, Output>["run"]>) {
        const result = super.run(...args);
        const observe = boundary.afterReply;
        return observe
          ? result.then(async (reply) => {
              await observe(reply);
              return reply;
            })
          : result;
      }
      override async rotate(...args: Parameters<WorkerTaskPool<Input, Output>["rotate"]>) {
        if (boundary.failRetirement) {
          throw new Error("synthetic retirement failure");
        }
        await super.rotate(...args);
        await boundary.afterRotate?.();
      }
    },
  };
});

afterEach(() => {
  boundary.afterReply = undefined;
  boundary.afterRotate = undefined;
  boundary.failRetirement = false;
  vi.restoreAllMocks();
});

function placement(
  sessionId = "subject",
  agentId = "main",
  sessionKey = `agent:${agentId}:${sessionId}`,
) {
  return createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() }).startDispatch(
    {
      sessionId,
      sessionKey,
      agentId,
    },
  );
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

it("charges captured discovery paths to queue capacity and recovers after refusal", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const subject = placement();
    replaceSessionEntrySync(subject, { sessionId: subject.sessionId, updatedAt: 1 });
    const small: OpenClawConfig = { agents: { list: [{ id: "main" }] } };
    const large: OpenClawConfig = {
      agents: {
        list: [
          { id: "main" },
          ...Array.from({ length: 1000 }, (_, index) => ({
            id: `configured-worker-${index}`,
          })),
        ],
      },
    };
    setRuntimeConfigSnapshot(large, large);
    expect(await (await createWorkerPlacementSessionEvidenceResolver([subject]))(subject)).toBe(
      "unknown",
    );
    setRuntimeConfigSnapshot(small, small);
    expect(await (await createWorkerPlacementSessionEvidenceResolver([subject]))(subject)).toBe(
      "current",
    );
  });
});

it.each(["path", "root", "agent"] as const)(
  "revokes unresolved discovery before a %s close can finish",
  async (selection) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const subject = placement();
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
      const subject = placement();
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

it("keeps a different legacy family usable while another family closes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const store = state.statePath("custom", "shared.json");
    const cfg: OpenClawConfig = { session: { store } };
    setRuntimeConfigSnapshot(cfg, cfg);
    const subject = placement();
    replaceSessionEntrySync(
      { ...subject, storePath: store },
      { sessionId: subject.sessionId, updatedAt: 1 },
    );
    const gate = pauseRegistry();
    const pending = createWorkerPlacementSessionEvidenceResolver([subject]);
    try {
      await gate.entered;
      await closeOpenClawAgentDatabaseByPathAsync(
        state.statePath("custom", "unrelated.main.sqlite"),
        "main",
      );
      gate.resume();
      expect(await (await pending)(subject)).toBe("current");
    } finally {
      gate.resume();
      await pending;
      gate.restore();
    }
  });
});

it("captures config, environment, cwd and placement identity before discovery yields", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const store = path.relative(process.cwd(), state.statePath("captured.sqlite"));
    const cfg: OpenClawConfig = { session: { store } };
    setRuntimeConfigSnapshot(cfg, cfg);
    const subject = placement();
    replaceSessionEntrySync(
      { ...subject, storePath: store },
      { sessionId: subject.sessionId, updatedAt: 1 },
    );
    const gate = pauseRegistry();
    const pending = createWorkerPlacementSessionEvidenceResolver([subject]);
    const originalRoot = process.env.OPENCLAW_STATE_DIR;
    const originalCwd = process.cwd();
    try {
      await gate.entered;
      process.chdir(state.stateDir);
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
      process.chdir(originalCwd);
      gate.resume();
      await pending;
      gate.restore();
    }
  });
});

it.each(["evidence", "settlement"] as const)(
  "does not publish stale absence after a physical-alias write during %s",
  async (phase) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const physical = state.statePath("physical.sqlite");
      const alias = state.statePath("alias.sqlite");
      openOpenClawAgentDatabase({ agentId: "main", path: physical });
      fs.symlinkSync(physical, alias);
      const cfg: OpenClawConfig = { session: { store: alias } };
      setRuntimeConfigSnapshot(cfg, cfg);
      const subject = placement();
      // A fixed shared store is selected only for agents with persisted scoped rows.
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:anchor", storePath: physical },
        { sessionId: "anchor", updatedAt: 1 },
      );
      let wrote = false;
      const write = async () => {
        if (wrote) {
          return;
        }
        wrote = true;
        replaceSessionEntrySync(
          { ...subject, storePath: physical },
          { sessionId: subject.sessionId, updatedAt: 2 },
        );
      };
      let evidenceRead = false;
      boundary.afterReply = async (reply) => {
        if (isEvidenceReply(reply)) {
          evidenceRead = true;
          if (phase === "evidence") {
            await write();
          }
        }
      };
      boundary.afterRotate = async () => {
        if (phase === "settlement" && evidenceRead) {
          await write();
        }
      };
      try {
        expect(await (await createWorkerPlacementSessionEvidenceResolver([subject]))(subject)).toBe(
          "unknown",
        );
        expect(evidenceRead).toBe(true);
        expect(wrote).toBe(true);
      } finally {
        boundary.afterReply = undefined;
        boundary.afterRotate = undefined;
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
      const subject = placement();
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
        await expect(close()).rejects.toMatchObject({
          message: "Agent database resource drainage failed",
          errors: expect.arrayContaining([
            expect.objectContaining({ message: "synthetic retirement failure" }),
          ]),
        });
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

it("rejects discovery revoked during final reader retirement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const subject = placement();
    replaceSessionEntrySync(subject, { sessionId: subject.sessionId, updatedAt: 1 });
    let revoke: Promise<void> | undefined;
    boundary.afterRotate = async () => {
      boundary.afterRotate = undefined;
      // Close joins the same in-flight retirement; do not wait for ourselves here.
      revoke = drainAgentDatabaseResources({ agentId: "main" }, async () => {});
    };
    try {
      expect(await (await createWorkerPlacementSessionEvidenceResolver([subject]))(subject)).toBe(
        "unknown",
      );
      expect(revoke).toBeDefined();
      await revoke;
    } finally {
      boundary.afterRotate = undefined;
      await revoke;
    }
  });
});

it("transfers a Windows-normalized environment through inventory and evidence workers", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const subject = placement();
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
    const disk = placement("disk-current");
    const incognito = placement(
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

it("rejects absence when the configured alias selects another database after the worker read", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const previous = state.statePath("previous.sqlite");
    const replacement = state.statePath("replacement.sqlite");
    const alias = state.statePath("selected.sqlite");
    const subject = placement("alias-retarget");
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:anchor", storePath: previous },
      {
        sessionId: "anchor",
        updatedAt: 1,
      },
    );
    replaceSessionEntrySync(
      { ...subject, storePath: replacement },
      { sessionId: subject.sessionId, updatedAt: 1 },
    );
    fs.symlinkSync(previous, alias);
    const cfg: OpenClawConfig = { session: { store: alias } };
    setRuntimeConfigSnapshot(cfg, cfg);
    let retargeted = false;
    boundary.afterReply = async (reply) => {
      if (isEvidenceReply(reply)) {
        boundary.afterReply = undefined;
        fs.unlinkSync(alias);
        fs.symlinkSync(replacement, alias);
        retargeted = true;
      }
    };
    try {
      const resolve = await createWorkerPlacementSessionEvidenceResolver([subject]);
      expect(retargeted).toBe(true);
      expect(await resolve(subject)).toBe("unknown");
    } finally {
      boundary.afterReply = undefined;
    }
    expect(await (await createWorkerPlacementSessionEvidenceResolver([subject]))(subject)).toBe(
      "current",
    );
  });
});

it("keeps the fixed physical owner and current precedence across canonical and malformed legacy rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const store = state.statePath("shared.sqlite");
    const database = openOpenClawAgentDatabase({ agentId: "main", path: store });
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "ops", default: true }] },
      session: { store },
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    const subject = placement("shared-subject", "ops");
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
