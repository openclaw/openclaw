import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabaseByPathAsync as closeDatabase,
  closeOpenClawAgentDatabasesAsync,
} from "../../state/openclaw-agent-db-lifecycle.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db-registry.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { OpenClawConfig } from "../config.js";
import { resolveSessionStorePathCore } from "./paths.js";
import {
  listSessionEntriesReadOnly as listEntries,
  replaceSessionEntry,
} from "./session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath as resolveTarget } from "./session-sqlite-target.js";
import { resolveExistingAgentSessionStoreTargetsSync as existingTargets } from "./targets-discovery.native.js";
import { resolveSessionStoreTargets as selectStores } from "./targets.js";
import { EXPLICIT_MAIN_CONFIG } from "./targets.test-support.js";

async function withSessionStoreHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHome(async (home) => {
    try {
      return await fn(home);
    } finally {
      // Fixed-store fixtures also open databases outside the default .openclaw directory.
      await closeOpenClawAgentDatabasesAsync(home);
    }
  });
}

function fixedStoreConfig(
  store: string,
  entries: NonNullable<OpenClawConfig["agents"]>["entries"] = { main: {}, ops: {} },
  owner = "main",
): OpenClawConfig {
  return {
    session: { store },
    agents: {
      entries,
      defaults: { sessionStore: { agentId: owner } },
    },
  };
}

function storeScope(home: string, storePath: string, agentId = "main", defaultAgentId = "main") {
  return {
    agentId,
    defaultAgentId,
    storePath,
    env: { ...process.env, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") },
  };
}

const targets = (storePath: string, ...agents: string[]) =>
  agents.map((agentId) => ({ agentId, storePath }));

function fixedStoreFixture(home: string, name: string) {
  const storePath = path.join(home, name);
  const scope = (agentId = "main", defaultAgentId = "main") =>
    storeScope(home, storePath, agentId, defaultAgentId);
  return {
    home,
    storePath,
    scope,
    env: scope().env,
    register: (agentId: string, databasePath: string) =>
      registerOpenClawAgentDatabase({ agentId, path: databasePath, env: scope().env }),
    write: (agentId: string, updatedAt = 1, model?: string, defaultAgentId = "main") =>
      replaceSessionEntry(
        { ...scope(agentId, defaultAgentId), sessionKey: `agent:${agentId}:main` },
        { sessionId: `${agentId}-session`, updatedAt, ...(model ? { model } : {}) },
      ),
  };
}
const withFixedStore = (
  run: (fixture: ReturnType<typeof fixedStoreFixture>) => Promise<void>,
  name = "shared.json",
) =>
  withSessionStoreHome(async (home) => {
    await run(fixedStoreFixture(home, name));
    return home;
  });

describe("resolveSessionStoreTargets", () => {
  it("includes configured ACP harness stores for all-agent session views", async () => {
    await withTempHome(async () => {
      const cfg: OpenClawConfig = {
        session: {
          store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
        },
        agents: {
          entries: {
            ops: {},
            review: { runtime: { type: "acp", acp: { agent: "opencode" } } },
          },
        },
        acp: { defaultAgent: "claude", allowedAgents: ["gemini", "*"] },
      };

      const env = { ...process.env };
      const selected = selectStores(cfg, { allAgents: true }, { env });
      expect(selected).toEqual(
        ["ops", "review", "claude", "gemini", "opencode"].map((agentId) => ({
          agentId,
          storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId, env }),
        })),
      );
    });
  });

  it("lands colliding fixed-store writes in distinct owner databases", async () => {
    const fixtureHome = await withFixedStore(async ({ env, storePath, scope, write }) => {
      await write("main");
      await write("ops", 2);

      const cfg = fixedStoreConfig(storePath);
      cfg.agents!.ownership = "explicit";
      expect(selectStores(cfg, { allAgents: true }, { env })).toEqual(
        targets(storePath, "main", "ops"),
      );

      const mainPath = resolveTarget(storePath, scope("main")).path;
      const opsPath = resolveTarget(storePath, scope("ops")).path;
      expect(mainPath).not.toBe(opsPath);
      await expect(fs.stat(mainPath)).resolves.toBeDefined();
      await expect(fs.stat(opsPath)).resolves.toBeDefined();
      expect(listEntries(scope("main")).map(({ sessionKey }) => sessionKey)).toEqual([
        "agent:main:main",
      ]);
      expect(listEntries(scope("ops")).map(({ sessionKey }) => sessionKey)).toEqual([
        "agent:ops:main",
      ]);
    }, "ops.json");
    await expect(fs.stat(fixtureHome)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a promoted default on its registered suffixed database", async () => {
    await withFixedStore(async ({ home, storePath, scope, write }) => {
      await write("worker", 1, "before-promotion");
      const beforePromotionPath = resolveTarget(storePath, scope("worker")).path;
      await closeDatabase(beforePromotionPath);
      await write("worker", 2, "after-promotion", "worker");
      const afterPromotionPath = resolveTarget(storePath, scope("worker", "worker")).path;

      expect(afterPromotionPath).toBe(beforePromotionPath);
      expect(afterPromotionPath).toBe(path.join(home, "shared.worker.sqlite"));
      await expect(fs.stat(path.join(home, "shared.sqlite"))).rejects.toThrow();
      await closeDatabase(afterPromotionPath);
      expect(listEntries(scope("worker", "worker"))).toEqual([
        {
          sessionKey: "agent:worker:main",
          entry: expect.objectContaining({ model: "after-promotion", sessionId: "worker-session" }),
        },
      ]);
    });
  });

  it("does not let durable metadata override ambiguous suffix registration", async () => {
    await withFixedStore(async ({ home, env, storePath, scope, write }) => {
      await write("worker");
      const occupiedPath = resolveTarget(storePath, scope("worker")).path;
      await closeDatabase(occupiedPath);
      registerOpenClawAgentDatabase({ agentId: "ops", env, path: occupiedPath });

      expect(
        resolveTarget(storePath, {
          agentId: "worker",
          defaultAgentId: "main",
          env,
        }).path,
      ).toBe(path.join(home, "shared.worker.2.sqlite"));
    });
  });

  it("retains a shared-store claimant when the physical owner left the roster", async () => {
    await withFixedStore(async ({ env, storePath, write }) => {
      await write("main");
      await write("ops", 2);
      const cfg = fixedStoreConfig(storePath, { ops: {}, other: {} }, "ops");
      expect(selectStores(cfg, { allAgents: true }, { env })).toEqual(targets(storePath, "ops"));
      expect(existingTargets(cfg, "ops", { env })).toEqual(targets(storePath, "ops"));
    }, "shared.sqlite");
  });

  it("honors a registered owner over the configured default for a fixed-store collision", async () => {
    await withFixedStore(async ({ env, storePath, register }) => {
      const cfg = fixedStoreConfig(storePath);
      const unsuffixedPath = resolveTarget(storePath).path;
      register("ops", unsuffixedPath);
      await replaceSessionEntry(
        { agentId: "ops", defaultAgentId: "main", env, storePath, sessionKey: "main" },
        { sessionId: "ops-session", updatedAt: 1 },
      );
      expect(selectStores(cfg, { allAgents: true }, { env })).toEqual(
        targets(storePath, "main", "ops"),
      );
      expect(existingTargets(cfg, "main", { env })).toEqual([]);
    }, "ops.json");
  });

  it("does not let a scoped losing owner claim an unregistered fixed-store database", async () => {
    await withFixedStore(async ({ env, storePath }) => {
      const databasePath = resolveTarget(storePath, {
        agentId: "main",
      }).path;
      const cfg = fixedStoreConfig(storePath);
      await replaceSessionEntry(
        { agentId: "main", env, storePath, sessionKey: "main" },
        { sessionId: "main-session", updatedAt: 1 },
      );
      unregisterOpenClawAgentDatabase({ agentId: "main", env, path: databasePath });

      expect(existingTargets(cfg, "ops", { env })).toEqual([]);
      expect(existingTargets(cfg, "main", { env })).toEqual(targets(storePath, "main"));
    }, "ops.json");
  });

  it("keeps ambiguous registry ownership off the unsuffixed target", async () => {
    await withFixedStore(async ({ env, storePath, register }) => {
      const databasePath = resolveTarget(storePath).path;
      register("ops", databasePath);
      register("main", databasePath);
      const cfg = fixedStoreConfig(storePath);
      expect(selectStores(cfg, { allAgents: true }, { env })).toEqual(
        targets(storePath, "main", "ops"),
      );
    }, "ops.json");
  });

  it("prefers a canonical database-path owner over a conflicting registry row", async () => {
    await withTempHome(async (home) => {
      const { env } = storeScope(home, "");
      const storePath = path.join(home, ".openclaw", "agents", "main", "sessions", "sessions.json");
      const databasePath = resolveTarget(storePath).path;
      registerOpenClawAgentDatabase({ agentId: "ops", env, path: databasePath });
      const cfg = fixedStoreConfig(storePath);

      expect(selectStores(cfg, { allAgents: true }, { env })).toEqual(targets(storePath, "main"));
    });
  });

  it("fails closed when the ownership registry cannot be read", async () => {
    await withTempHome(async (home) => {
      const { env } = storeScope(home, "");
      const registryPath = resolveOpenClawStateSqlitePath(env);
      await fs.mkdir(path.dirname(registryPath), { recursive: true });
      await fs.writeFile(registryPath, "not a sqlite database", "utf-8");
      const cfg = fixedStoreConfig(path.join(home, "ops.json"));

      expect(() => selectStores(cfg, { allAgents: true }, { env })).toThrow();
    });
  });

  it("keeps arbitrary explicit store paths on the default agent", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "backups", "sessions", "sessions.json");

      expect(selectStores(EXPLICIT_MAIN_CONFIG, { store: storePath })).toEqual(
        targets(storePath, "main"),
      );
    });
  });

  it("uses the persisted owner when --store targets the configured fixed store", () => {
    const storePath = path.resolve("/tmp/restart-shaped-shared.sqlite");
    const cfg = fixedStoreConfig(storePath, { research: {}, ops: {} }, "ops");
    cfg.agents!.ownership = "explicit";

    expect(selectStores(cfg, { store: storePath })).toEqual(targets(storePath, "ops"));
    expect(() => selectStores(cfg, { agent: "research", store: storePath })).toThrow(
      'Session store belongs to agent "ops", not requested agent "research"',
    );
  });

  it("rejects a path-inferred agent that conflicts with the persisted fixed-store owner", () => {
    const storePath = path.resolve("/tmp/agents/research/sessions/sessions.json");
    const cfg = fixedStoreConfig(storePath, { ops: {}, research: {} }, "ops");
    cfg.agents!.ownership = "explicit";

    expect(() => selectStores(cfg, { store: storePath })).toThrow(
      'Session store belongs to agent "research", not requested agent "ops"',
    );
  });

  it("allows an explicit store path with an explicit fleet agent", () => {
    const storePath = path.resolve("/tmp/explicit-fleet-sessions.json");
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { Ops: {}, research: {} } },
    };

    expect(selectStores(cfg, { agent: "ops", store: storePath })).toEqual(
      targets(storePath, "ops"),
    );
    expect(() =>
      selectStores(cfg, {
        agent: "ops",
        store: path.resolve("/tmp/agents/research/sessions/sessions.json"),
      }),
    ).toThrow('Session store belongs to agent "research", not requested agent "ops"');
  });

  it("accepts case-insensitive legacy main paths but rejects aliases", () => {
    const cfg: OpenClawConfig = { agents: { entries: { ops: {} } } };
    const mainPath = path.resolve("/tmp/agents/Main/sessions/sessions.json");

    expect(selectStores(cfg, { store: mainPath })).toEqual(targets(mainPath, "main"));
    for (const alias of ["main!", "main "]) {
      const storePath = path.resolve("/tmp/agents", alias, "sessions", "sessions.json");
      expect(selectStores(cfg, { store: storePath })).toEqual(targets(storePath, "ops"));
    }
  });

  it("rejects unknown agent ids", () => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {}, work: {} } } };

    expect(() => selectStores(cfg, { agent: "ghost" })).toThrow(/Unknown agent id/);
  });

  it("rejects conflicting selectors", () => {
    expect(() => selectStores({}, { agent: "main", allAgents: true })).toThrow(
      /cannot be used together/i,
    );
    expect(() => selectStores({}, { store: "/tmp/sessions.json", allAgents: true })).toThrow(
      /cannot be combined/i,
    );
  });
});
