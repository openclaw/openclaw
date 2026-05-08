import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { OpenClawConfig } from "../config.js";
import {
  resolveAgentSessionDatabaseTargetsSync,
  resolveAllAgentSessionDatabaseTargets,
  resolveAllAgentSessionDatabaseTargetsSync,
  resolveSessionDatabaseTargets,
} from "./targets.js";

function createCustomRootCfg(customRoot: string, defaultAgentId = "ops"): OpenClawConfig {
  return {
    session: {},
    agents: {
      list: [{ id: defaultAgentId, default: true }],
    },
  };
}

function createEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
  };
}

function expectedTarget(params: {
  agentId: string;
  env: NodeJS.ProcessEnv;
  databasePath?: string;
}) {
  return {
    agentId: params.agentId,
    databasePath:
      params.databasePath ??
      resolveOpenClawAgentSqlitePath({ agentId: params.agentId, env: params.env }),
  };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("resolveSessionDatabaseTargets", () => {
  it("resolves all configured agent databases", async () => {
    await withTempHome(async (home) => {
      const env = createEnv(home);
      const cfg: OpenClawConfig = {
        session: {},
        agents: {
          list: [{ id: "main", default: true }, { id: "work" }],
        },
      };

      const targets = resolveSessionDatabaseTargets(cfg, { allAgents: true }, { env });
      expect(targets).toEqual([
        expectedTarget({ agentId: "main", env }),
        expectedTarget({ agentId: "work", env }),
      ]);
    });
  });

  it("keeps per-agent database targets when legacy store paths are shared", async () => {
    await withTempHome(async (home) => {
      const env = createEnv(home);
      const cfg: OpenClawConfig = {
        session: {},
        agents: {
          list: [{ id: "main", default: true }, { id: "work" }],
        },
      };

      expect(resolveSessionDatabaseTargets(cfg, { allAgents: true }, { env })).toEqual([
        {
          agentId: "main",
          databasePath: resolveOpenClawAgentSqlitePath({ agentId: "main", env }),
        },
        {
          agentId: "work",
          databasePath: resolveOpenClawAgentSqlitePath({ agentId: "work", env }),
        },
      ]);
    });
  });

  it("includes SQLite-registered agents for --all-agents", async () => {
    await withTempHome(async (home) => {
      const env = createEnv(home);
      const cfg: OpenClawConfig = {
        agents: {
          list: [{ id: "main", default: true }],
        },
      };
      const registered = openOpenClawAgentDatabase({ agentId: "retired", env });

      expect(resolveSessionDatabaseTargets(cfg, { allAgents: true }, { env })).toEqual([
        expectedTarget({ agentId: "main", env }),
        expectedTarget({ agentId: "retired", env, databasePath: registered.path }),
      ]);
    });
  });

  it("rejects unknown agent ids", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "work" }],
      },
    };

    expect(() => resolveSessionDatabaseTargets(cfg, { agent: "ghost" })).toThrow(
      /Unknown agent id/,
    );
  });

  it("rejects conflicting selectors", () => {
    expect(() => resolveSessionDatabaseTargets({}, { agent: "main", allAgents: true })).toThrow(
      /cannot be used together/i,
    );
  });
});

describe("resolveAgentSessionDatabaseTargetsSync", () => {
  it("resolves configured and default targets for one requested agent", async () => {
    await withTempHome(async (home) => {
      const env = createEnv(home);
      const customRoot = path.join(home, "custom-state");
      const cfg = createCustomRootCfg(customRoot, "main");

      expect(resolveAgentSessionDatabaseTargetsSync(cfg, "codex", { env })).toEqual([
        expectedTarget({ agentId: "codex", env }),
      ]);
    });
  });

  it("includes a SQLite-registered target without probing sessions.json", async () => {
    await withTempHome(async (home) => {
      const env = createEnv(home);
      const cfg: OpenClawConfig = {
        agents: {
          list: [{ id: "main", default: true }],
        },
      };
      const registered = openOpenClawAgentDatabase({ agentId: "retired", env });

      expect(resolveAgentSessionDatabaseTargetsSync(cfg, "retired", { env })).toEqual([
        expectedTarget({ agentId: "retired", env, databasePath: registered.path }),
      ]);
    });
  });
});

describe("resolveAllAgentSessionDatabaseTargets", () => {
  it("includes configured agents and SQLite-registered agents", async () => {
    await withTempHome(async (home) => {
      const env = createEnv(home);
      const cfg: OpenClawConfig = {
        agents: {
          list: [{ id: "ops", default: true }],
        },
      };
      const registered = openOpenClawAgentDatabase({ agentId: "retired", env });

      await expect(resolveAllAgentSessionDatabaseTargets(cfg, { env })).resolves.toEqual([
        expectedTarget({ agentId: "ops", env }),
        expectedTarget({ agentId: "retired", env, databasePath: registered.path }),
      ]);
      expect(resolveAllAgentSessionDatabaseTargetsSync(cfg, { env })).toEqual([
        expectedTarget({ agentId: "ops", env }),
        expectedTarget({ agentId: "retired", env, databasePath: registered.path }),
      ]);
    });
  });
});
