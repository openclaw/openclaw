import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { loadSessionEntry, replaceSessionEntry } from "./session-accessor.js";
import { runSessionStartupMigration } from "./startup-migration.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

it("rejects startup when session-store discovery fails", async () => {
  const stateDir = tempDirs.make("openclaw-startup-discovery-");
  await expect(
    runSessionStartupMigration({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: stateDir },
      log: { info: vi.fn(), warn: vi.fn() },
      deps: {
        resolveAllAgentSessionStoreTargetsSync() {
          throw new Error("session-store discovery failed");
        },
      },
    }),
  ).rejects.toThrow("session-store discovery failed");
});

it("detects from startup and surfaces unresolved warnings", async () => {
  const log = { info: vi.fn(), warn: vi.fn() };
  const migrate = vi.fn(async () => ({
    armed: false,
    changes: [],
    complete: false,
    ledgerComplete: false,
    legacyAgentId: "main",
    mainKey: "main",
    outcomes: [{ kind: "not-armed" as const }],
    warnings: ["owner unresolved"],
  }));
  await runSessionStartupMigration({
    cfg: { session: { store: "/tmp/fixed.sqlite" } },
    log,
    deps: {
      migrateLegacyMainSessionKeys: migrate,
      resolveAllAgentSessionStoreTargetsSync: () => [],
    },
  });

  expect(migrate).toHaveBeenCalledWith({
    cfg: { session: { store: "/tmp/fixed.sqlite" } },
    env: process.env,
    mode: "detect",
  });
  expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("owner unresolved"));
});

it("runs the armed startup engine even when no legacy session directory remains", async () => {
  const root = fs.realpathSync.native(tempDirs.make("openclaw-legacy-main-startup-"));
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const cfg = { agents: { entries: { ops: {} } } };
  const env = { ...process.env, OPENCLAW_AGENT_DIR: undefined, OPENCLAW_STATE_DIR: stateDir };
  const migrate = vi.fn(async () => ({
    armed: true,
    changes: [],
    complete: true,
    ledgerComplete: true,
    legacyAgentId: "main",
    mainKey: "main",
    outcomes: [{ kind: "no-legacy-rows" as const }],
    ownerAgentId: "ops",
    warnings: [],
  }));
  const handoffDatabase = vi.fn(async () => {});
  await runSessionStartupMigration({
    cfg,
    env,
    log: { info: vi.fn(), warn: vi.fn() },
    handoffDatabase,
    deps: {
      migrateLegacyMainSessionKeys: migrate,
      resolveAllAgentSessionStoreTargetsSync: vi.fn(() => []),
    },
  });

  expect(handoffDatabase).not.toHaveBeenCalled();
  expect(migrate).toHaveBeenCalledWith({ cfg, env, mode: "detect" });
});

it("reports legacy session repairs without rewriting stored claims at startup", async () => {
  const root = fs.realpathSync.native(tempDirs.make("openclaw-startup-doctor-only-"));
  const stateDir = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  await withEnvAsync({ OPENCLAW_AGENT_DIR: undefined, OPENCLAW_STATE_DIR: stateDir }, async () => {
    const env = { ...process.env };
    const cfg = { agents: { entries: { ops: { workspace } } } };
    const legacy = { agentId: "main", env, sessionKey: "agent:main:retained" };
    const canonical = { agentId: "ops", env, sessionKey: "agent:ops:retained" };
    const worktree = { agentId: "ops", env, sessionKey: "agent:ops:workspace" };
    await replaceSessionEntry(legacy, { sessionId: "retained-history", updatedAt: Date.now() });
    await replaceSessionEntry(worktree, {
      sessionId: "workspace-history",
      updatedAt: Date.now(),
      worktree: { id: "legacy", branch: "openclaw/legacy", repoRoot: workspace },
    });
    const beforeLegacy = loadSessionEntry(legacy);
    const beforeWorktree = loadSessionEntry(worktree);
    const log = { info: vi.fn(), warn: vi.fn() };
    const handoffDatabase = vi.fn(async () => {});
    await runSessionStartupMigration({ cfg, env, log, handoffDatabase });
    expect.soft(loadSessionEntry(legacy)).toEqual(beforeLegacy);
    expect.soft(loadSessionEntry(canonical)).toBeUndefined();
    expect.soft(loadSessionEntry(worktree)).toEqual(beforeWorktree);
    expect(handoffDatabase).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
  });
});
