import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import {
  assertNoUnmigratedWorkspaceState,
  LEGACY_WORKSPACE_ATTESTATION_HEADER,
  resolveLegacyWorkspaceSourcePaths,
  WORKSPACE_DOCTOR_CLAIM_SUFFIX,
} from "./workspace-legacy-state.js";
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
      entries: { main: {} },
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
    addLegacyWorkspace(sessionKey: string, attested = true) {
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
      if (attested) {
        const attestation = resolveLegacyWorkspaceSourcePaths(layout.sandboxWorkspaceDir, { env })
          .stateDirAttestationPaths[0]!;
        fs.mkdirSync(path.dirname(attestation), { recursive: true });
        fs.writeFileSync(attestation, "");
      }
      return layout.sandboxWorkspaceDir;
    },
  };
}

function observeMainThreadSessionReads() {
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  return () => prepare.mock.calls.filter(([sql]) => /from\s+"session_nodes"/i.test(sql));
}

describe("Gateway configured workspace readiness", () => {
  it("reports all blocked workspaces without reading sessions on the main thread", async () => {
    const state = setup();
    const workspaces = Array.from({ length: 32 }, (_, index) => {
      const sessionKey = `agent:main:readiness-${index}`;
      state.seed(sessionKey);
      return state.addLegacyWorkspace(sessionKey);
    });
    closeOpenClawAgentDatabasesForTest();
    const reads = observeMainThreadSessionReads();
    const readiness = assertConfiguredWorkspaceStateReady(state);
    await expect(readiness).rejects.toThrow("Legacy workspace setup state requires migration");
    for (const workspace of workspaces) {
      await expect(readiness).rejects.toThrow(workspace);
    }
    expect(reads()).toEqual([]);
  });

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

  it.each(["setup", "sibling", "setup claim", "sibling claim"])(
    "ignores sandbox-written %s globally but retains local and Doctor refusal",
    async (kind) => {
      const state = setup();
      const sessionKey = "agent:main:guest";
      state.seed(sessionKey);
      const copy = state.addLegacyWorkspace(sessionKey, false);
      const sources = resolveLegacyWorkspaceSourcePaths(copy, { env: state.env });
      fs.unlinkSync(sources.setupStatePaths[0]!);
      const source = kind.startsWith("setup")
        ? sources.setupStatePaths[0]!
        : sources.siblingAttestationPaths[0]!;
      const marker = kind.endsWith("claim") ? `${source}${WORKSPACE_DOCTOR_CLAIM_SUFFIX}` : source;
      fs.writeFileSync(marker, `${LEGACY_WORKSPACE_ATTESTATION_HEADER}\n`);
      closeOpenClawAgentDatabasesForTest();
      await expect(assertConfiguredWorkspaceStateReady(state)).resolves.toBeUndefined();
      expect(() => assertNoUnmigratedWorkspaceState({ workspaceDir: copy })).toThrow(
        "Legacy workspace setup state requires migration",
      );
      await expect(
        assertConfiguredWorkspaceStateReady({ ...state, operation: "doctor" }),
      ).rejects.toThrow("Legacy workspace setup state requires migration");
      expect(fs.existsSync(marker)).toBe(true);
    },
  );

  it("does not create a missing session store during readiness", async () => {
    const state = setup();
    await expect(assertConfiguredWorkspaceStateReady(state)).resolves.toBeUndefined();
    expect(fs.existsSync(state.databasePath)).toBe(false);
  });
});
