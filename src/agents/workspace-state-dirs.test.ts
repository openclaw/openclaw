import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveSandboxWorkspaceLayoutPaths } from "./sandbox/shared.js";
import { assertConfiguredWorkspaceStateReady } from "./workspace-state-dirs.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

function setup(mode: "all" | "non-main" = "all") {
  const home = fs.realpathSync(tempDirs.make("openclaw-workspace-readiness-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("OPENCLAW_HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, "state"));
  const env = { ...process.env };
  const workspaceDir = path.join(home, "workspace");
  const workspaceRoot = path.join(home, "sandboxes");
  fs.mkdirSync(workspaceDir);
  const scope = { agentId: "main", env };
  const databasePath = resolveOpenClawAgentSqlitePath(scope);
  const cfg = {
    session: { store: databasePath },
    agents: {
      entries: { main: {} },
      defaults: {
        workspace: workspaceDir,
        sandbox: { mode, scope: "session", workspaceAccess: "ro", workspaceRoot },
      },
    },
  } satisfies OpenClawConfig;
  return {
    ready: () => assertConfiguredWorkspaceStateReady({ cfg, env }),
    databasePath,
    addLegacyWorkspace(sessionKey: string, required = false) {
      const entry = {
        sessionId: sessionKey,
        updatedAt: 1,
        ...(required ? { sandbox: "required", createdActor: creator } : {}),
      } satisfies Parameters<typeof replaceSessionEntrySync>[1];
      replaceSessionEntrySync({ ...scope, sessionKey }, entry);
      const { sandboxWorkspaceDir: dir } = resolveSandboxWorkspaceLayoutPaths({
        cfg: cfg.agents.defaults.sandbox,
        agentId: "main",
        rawSessionKey: sessionKey,
        workspaceDir,
      });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "openclaw-workspace-state.json"), '{"version":1}');
      return dir;
    },
  };
}

const creator = { type: "human", source: "profile", id: "test-creator" } as const;

it("reports all blocked workspaces without reading sessions on the main thread", async () => {
  const state = setup();
  const workspaces = Array.from({ length: 32 }, (_, index) =>
    state.addLegacyWorkspace(`agent:main:readiness-${index}`),
  );
  closeOpenClawAgentDatabasesForTest();
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  const readiness = state.ready();
  await expect(readiness).rejects.toThrow("Legacy workspace setup state requires migration");
  for (const workspace of workspaces) {
    await expect(readiness).rejects.toThrow(workspace);
  }
  expect(prepare.mock.calls.filter(([sql]) => /from\s+"session_nodes"/i.test(sql))).toEqual([]);
});

it.each([false, true])("classifies non-main mode (required: %s)", async (required) => {
  const state = setup("non-main");
  const workspace = state.addLegacyWorkspace("agent:main:main", required);
  closeOpenClawAgentDatabasesForTest();
  const readiness = state.ready();
  if (required) {
    await expect(readiness).rejects.toThrow(workspace);
  } else {
    await expect(readiness).resolves.toBeUndefined();
  }
});

it("does not create a missing session store during readiness", async () => {
  const state = setup();
  await expect(state.ready()).resolves.toBeUndefined();
  expect(fs.existsSync(state.databasePath)).toBe(false);
});
