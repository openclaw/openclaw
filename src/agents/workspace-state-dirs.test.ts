import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resolveSandboxWorkspaceLayoutPaths } from "./sandbox/shared.js";
import { assertConfiguredWorkspaceStateReady } from "./workspace-state-dirs.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let restoreEnv: (() => void) | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  restoreEnv?.();
  restoreEnv = undefined;
});

function setup(mode: "all" | "non-main" = "all") {
  const home = fs.realpathSync(tempDirs.make("openclaw-workspace-readiness-"));
  const envSnapshot = captureEnv(["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
  restoreEnv = () => envSnapshot.restore();
  setTestEnvValue("HOME", home);
  setTestEnvValue("OPENCLAW_HOME", home);
  setTestEnvValue("OPENCLAW_STATE_DIR", path.join(home, "state"));
  const env = { ...process.env };
  const workspaceDir = path.join(home, "workspace");
  const workspaceRoot = path.join(home, "sandboxes");
  fs.mkdirSync(workspaceDir);
  const scope = { agentId: "main", env };
  const databasePath = resolveOpenClawAgentSqlitePath(scope);
  const cfg = {
    session: { store: databasePath },
    agents: {
      entries: { main: { default: true } },
      defaults: {
        workspace: workspaceDir,
        sandbox: { mode, scope: "session", workspaceAccess: "ro", workspaceRoot },
      },
    },
  } satisfies OpenClawConfig;
  return {
    cfg,
    env,
    scope,
    databasePath,
    seed(sessionKey: string, required = false) {
      replaceSessionEntrySync(
        { ...scope, sessionKey },
        {
          sessionId: sessionKey,
          updatedAt: 1,
          ...(required
            ? {
                sandbox: "required",
                createdActor: { type: "human", source: "profile", id: "test-creator" },
              }
            : {}),
        },
      );
    },
    addLegacyWorkspace(sessionKey: string) {
      const layout = resolveSandboxWorkspaceLayoutPaths({
        cfg: cfg.agents.defaults.sandbox,
        agentId: "main",
        rawSessionKey: sessionKey,
        workspaceDir,
      });
      fs.mkdirSync(layout.sandboxWorkspaceDir, { recursive: true });
      fs.writeFileSync(
        path.join(layout.sandboxWorkspaceDir, "openclaw-workspace-state.json"),
        JSON.stringify({ version: 1 }),
      );
      return layout.sandboxWorkspaceDir;
    },
  };
}

function observeColdSessionReads() {
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  const iterate = vi.spyOn(StatementSync.prototype, "iterate");
  return {
    get handles() {
      return new Set(
        prepare.mock.calls.flatMap(([sql], index) =>
          /from\s+"session_nodes"/i.test(sql) ? [prepare.mock.contexts[index]] : [],
        ),
      );
    },
    scans: () =>
      prepare.mock.calls.reduce((count, [sql], index) => {
        if (!sql.includes('"retained_window"')) {
          return count;
        }
        const result = prepare.mock.results[index];
        return (
          count +
          iterate.mock.contexts.filter(
            (statement) => result?.type === "return" && statement === result.value,
          ).length
        );
      }, 0),
  };
}

describe("Gateway configured workspace readiness", () => {
  it.each([8, 32])(
    "validates one cold session store once and reports all %i blocked workspaces",
    async (count) => {
      const state = setup();
      const workspaces = Array.from({ length: count }, (_, index) => {
        const sessionKey = `agent:main:readiness-${index}`;
        state.seed(sessionKey);
        return state.addLegacyWorkspace(sessionKey);
      });
      closeOpenClawAgentDatabasesForTest();
      const reads = observeColdSessionReads();
      const readiness = assertConfiguredWorkspaceStateReady(state);
      await expect(readiness).rejects.toThrow("Legacy workspace setup state requires migration");
      for (const workspace of workspaces) {
        await expect(readiness).rejects.toThrow(workspace);
      }
      expect(reads.scans()).toBe(1);
      expect(reads.handles.size).toBe(1);
    },
  );

  it.each([false, true])(
    "classifies a main session in non-main mode with required sandbox: %s",
    async (required) => {
      const state = setup("non-main");
      const sessionKey = "agent:main:main";
      state.seed(sessionKey, required);
      const workspace = state.addLegacyWorkspace(sessionKey);
      closeOpenClawAgentDatabasesForTest();
      const readiness = assertConfiguredWorkspaceStateReady(state);
      if (required) {
        await expect(readiness).rejects.toThrow(workspace);
      } else {
        await expect(readiness).resolves.toBeUndefined();
      }
    },
  );

  it("does not create a missing session store during readiness", async () => {
    const state = setup();
    await expect(assertConfiguredWorkspaceStateReady(state)).resolves.toBeUndefined();
    expect(fs.existsSync(state.databasePath)).toBe(false);
  });

  it("revalidates persisted rows after an earlier readiness check", async () => {
    const state = setup();
    const sessionKey = "agent:main:readiness";
    state.seed(sessionKey);
    closeOpenClawAgentDatabasesForTest();
    await expect(assertConfiguredWorkspaceStateReady(state)).resolves.toBeUndefined();

    const database = new DatabaseSync(state.databasePath);
    try {
      database
        .prepare("UPDATE session_nodes SET entry_json = '{' WHERE session_key = ?")
        .run(sessionKey);
    } finally {
      database.close();
    }
    await expect(assertConfiguredWorkspaceStateReady(state)).rejects.toThrow(
      "invalid persisted session row",
    );
  });
});
