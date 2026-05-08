import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  resolveAgentSessionDatabaseTargetsSync,
  resolveSessionDatabaseTargets,
} from "./targets.js";

function createEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: `${home}/.openclaw`,
  };
}

function withTempStateHome<T>(callback: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-targets-"));
  return callback(home);
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

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

describe("resolveSessionDatabaseTargets", () => {
  it("resolves configured agent databases", async () => {
    await withTempStateHome(async (home) => {
      const env = createEnv(home);
      const cfg: OpenClawConfig = {
        session: {},
        agents: {
          list: [{ id: "main", default: true }, { id: "work" }],
        },
      };

      expect(resolveSessionDatabaseTargets(cfg, { allAgents: true }, { env })).toEqual([
        expectedTarget({ agentId: "main", env }),
        expectedTarget({ agentId: "work", env }),
      ]);
    });
  });

  it("includes SQLite-registered agents for all-agent selection", async () => {
    await withTempStateHome(async (home) => {
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

  it("rejects unknown explicit agent ids", () => {
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
  it("resolves the requested per-agent database target", async () => {
    await withTempStateHome(async (home) => {
      const env = createEnv(home);

      expect(resolveAgentSessionDatabaseTargetsSync({}, "codex", { env })).toEqual([
        expectedTarget({ agentId: "codex", env }),
      ]);
    });
  });

  it("uses a registered database path for the requested agent", async () => {
    await withTempStateHome(async (home) => {
      const env = createEnv(home);
      const registered = openOpenClawAgentDatabase({ agentId: "retired", env });

      expect(resolveAgentSessionDatabaseTargetsSync({}, "retired", { env })).toEqual([
        expectedTarget({ agentId: "retired", env, databasePath: registered.path }),
      ]);
    });
  });
});
