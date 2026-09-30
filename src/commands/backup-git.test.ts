import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as lifecycleWriteCustody from "../infra/lifecycle-write-custody.js";
import { readLifecycleWriteCustody } from "../infra/lifecycle-write-custody.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  createGitBackup: vi.fn(),
  getRuntimeConfig: vi.fn(),
  recordBackupRunOutcome: vi.fn(),
  restoreGitBackupRef: vi.fn(),
  verifyGitBackupRef: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, getRuntimeConfig: mocks.getRuntimeConfig };
});

vi.mock("../snapshot/git-backup.js", () => ({
  createGitBackup: mocks.createGitBackup,
  initializeGitBackupRepository: vi.fn(),
  readGitBackupLog: vi.fn(),
  restoreGitBackupRef: mocks.restoreGitBackupRef,
  verifyGitBackupRef: mocks.verifyGitBackupRef,
}));

vi.mock("../state/backup-run-records.js", () => ({
  recordBackupRunOutcome: mocks.recordBackupRunOutcome,
}));

import {
  backupGitCreateCommand,
  backupGitRestoreCommand,
  backupGitVerifyCommand,
} from "./backup-git.js";

describe("Git backup command agent selection", () => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    // Isolates OPENCLAW_STATE_DIR so canonical agent database paths are per-test.
    state = await createOpenClawTestState({
      prefix: "openclaw-backup-git-",
      layout: "state-only",
    });
    mocks.createGitBackup.mockReset().mockResolvedValue({
      commit: "backup-commit",
      noChanges: false,
      pushed: false,
      warnings: [],
      repositoryPath: "/tmp/repository",
    });
    mocks.getRuntimeConfig.mockReset().mockReturnValue({
      agents: { list: [{ id: "main" }, { id: "ops-team" }] },
    });
    mocks.recordBackupRunOutcome.mockReset();
    mocks.restoreGitBackupRef.mockReset().mockResolvedValue({
      commit: "backup-commit",
      excludedTables: [],
      excludedConfigStateKeyPrefixes: [],
      targetPath: "/tmp/restored.sqlite",
    });
    mocks.verifyGitBackupRef.mockReset().mockResolvedValue({
      commit: "backup-commit",
      tables: [],
    });
    vi.spyOn(fs, "realpath").mockImplementation(async (value) => path.resolve(String(value)));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await state.cleanup();
  });

  it.each(["success", "failure", "uncertain"] as const)(
    "retains backup custody through artifact and outcome settlement: %s",
    async (outcome) => {
      const beginCustody = lifecycleWriteCustody.beginLifecycleWriteCustody;
      let releaseCustody: (() => void) | undefined;
      vi.spyOn(lifecycleWriteCustody, "beginLifecycleWriteCustody").mockImplementation((phase) => {
        releaseCustody = beginCustody(phase);
        return releaseCustody;
      });
      const entered = createDeferred();
      const settled = createDeferred();
      const failure = new Error("backup failed", {
        cause: new AggregateError([new CommandProcessCleanupError()], "nested cleanup"),
      });
      mocks.createGitBackup.mockImplementation(async () => {
        entered.resolve();
        await settled.promise;
        if (outcome === "uncertain") {
          throw failure;
        }
        if (outcome === "failure") {
          throw new Error("backup failed");
        }
        return { commit: "fixture", noChanges: false, pushed: false, warnings: [] };
      });
      mocks.recordBackupRunOutcome.mockImplementation(async () => {
        expect(readLifecycleWriteCustody()).toEqual([{ phase: "backup", count: 1 }]);
      });
      const running = backupGitCreateCommand(createTestRuntime(), {
        repository: "/tmp/repository",
        global: true,
      }).catch((error: unknown) => error);
      await entered.promise;
      try {
        expect(readLifecycleWriteCustody()).toEqual([{ phase: "backup", count: 1 }]);
        settled.resolve();
        const result = await running;
        expect(result instanceof Error).toBe(outcome !== "success");
        if (outcome === "uncertain") {
          expect(result).toBe(failure);
        }
        expect(readLifecycleWriteCustody()).toEqual(
          outcome === "uncertain" ? [{ phase: "backup", count: 1 }] : [],
        );
      } finally {
        settled.resolve();
        await running;
        releaseCustody?.();
      }
      expect(readLifecycleWriteCustody()).toEqual([]);
    },
  );

  it("creates a backup for a configured normalized agent", async () => {
    const agentDir = path.join(state.root, "external-agent");
    mocks.getRuntimeConfig.mockReturnValue({
      agents: { entries: { "ops-team": { agentDir } } },
    });
    // The Gateway session database stays under the canonical state root even
    // when agentDir moves; the configured directory holds only a stray store.
    const canonicalPath = resolveOpenClawAgentSqlitePath({ agentId: "ops-team" });
    await fs.mkdir(path.dirname(canonicalPath), { recursive: true });
    await fs.writeFile(canonicalPath, "live");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "openclaw-agent.sqlite"), "stray");
    await backupGitCreateCommand(createTestRuntime(), {
      repository: "/tmp/repository",
      agents: ["Ops Team"],
    });

    expect(mocks.createGitBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        databases: [
          {
            identity: { role: "agent", agentId: "ops-team" },
            path: canonicalPath,
          },
        ],
      }),
    );
  });

  it("falls back to a configured-only agent database for an agentDir root", async () => {
    const agentDir = path.join(state.root, "external-configured-only");
    mocks.getRuntimeConfig.mockReturnValue({
      agents: { entries: { "ops-team": { agentDir } } },
    });
    const configuredPath = path.join(agentDir, "openclaw-agent.sqlite");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(configuredPath, "live");

    await backupGitCreateCommand(createTestRuntime(), {
      repository: "/tmp/repository",
      agents: ["Ops Team"],
    });

    expect(mocks.createGitBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        databases: [
          {
            identity: { role: "agent", agentId: "ops-team" },
            path: configuredPath,
          },
        ],
      }),
    );
  });

  it.each([
    [
      "unknown",
      "nope-agent",
      'Unknown agent id "nope-agent". Run openclaw agents list to see configured agents.',
    ],
    ["empty", "", "--agent must not be blank"],
    ["whitespace-only", "   ", "--agent must not be blank"],
  ])("rejects an %s Git create agent", async (_label, agent, message) => {
    await expect(
      backupGitCreateCommand(createTestRuntime(), {
        repository: "/tmp/repository",
        agents: [agent],
      }),
    ).rejects.toThrow(message);

    expect(mocks.createGitBackup).not.toHaveBeenCalled();
  });

  it("keeps the global Git create scope independent of configured agents", async () => {
    await backupGitCreateCommand(createTestRuntime(), {
      repository: "/tmp/repository",
      global: true,
    });

    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.createGitBackup).toHaveBeenCalledOnce();
  });

  it("preserves the Git-specific warning when outcome recording fails", async () => {
    mocks.recordBackupRunOutcome.mockRejectedValue(new Error("record failed"));
    const runtime = createTestRuntime();

    await backupGitCreateCommand(runtime, {
      repository: "/tmp/repository",
      global: true,
    });

    expect(runtime.error).toHaveBeenCalledWith(
      "Warning: the Git backup outcome could not be recorded: record failed",
    );
  });

  it("resolves every current agent preferring its canonical session database", async () => {
    const mainAgentDir = path.resolve("/tmp/external-main");
    const opsAgentDir = path.resolve("/tmp/external-ops");
    mocks.getRuntimeConfig.mockReturnValue({
      agents: {
        entries: {
          main: { agentDir: mainAgentDir },
          "ops-team": { agentDir: opsAgentDir },
        },
      },
    });
    // main's live session database is canonical (Gateway-owned); ops-team only
    // ever ran SDK sessions against its configured root.
    const mainCanonical = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    await fs.mkdir(path.dirname(mainCanonical), { recursive: true });
    await fs.writeFile(mainCanonical, "live");
    await fs.mkdir(path.join(opsAgentDir), { recursive: true });
    await fs.writeFile(path.join(opsAgentDir, "openclaw-agent.sqlite"), "live");

    await backupGitCreateCommand(createTestRuntime(), {
      repository: "/tmp/repository",
      all: true,
    });

    expect(mocks.getRuntimeConfig).toHaveBeenCalledOnce();
    expect(mocks.createGitBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        databases: [
          expect.objectContaining({ identity: { role: "global" } }),
          {
            identity: { role: "agent", agentId: "main" },
            path: mainCanonical,
          },
          {
            identity: { role: "agent", agentId: "ops-team" },
            path: path.join(opsAgentDir, "openclaw-agent.sqlite"),
          },
        ],
      }),
    );
  });

  it("keeps the --all plus explicit-scope conflict ahead of agent validation", async () => {
    await expect(
      backupGitCreateCommand(createTestRuntime(), {
        repository: "/tmp/repository",
        all: true,
        agents: ["nope-agent"],
      }),
    ).rejects.toThrow("Use --all by itself, or select --global and --agent scopes explicitly.");

    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.createGitBackup).not.toHaveBeenCalled();
  });

  it("keeps artifact verify and restore available for an unconfigured agent", async () => {
    await backupGitVerifyCommand(createTestRuntime(), {
      repository: "/tmp/repository",
      agent: "retired-agent",
    });
    await backupGitRestoreCommand(createTestRuntime(), {
      repository: "/tmp/repository",
      agent: "retired-agent",
      target: "/tmp/restored.sqlite",
    });

    expect(mocks.verifyGitBackupRef).toHaveBeenCalledWith(
      expect.objectContaining({ identity: { role: "agent", agentId: "retired-agent" } }),
    );
    expect(mocks.restoreGitBackupRef).toHaveBeenCalledWith(
      expect.objectContaining({ identity: { role: "agent", agentId: "retired-agent" } }),
    );
    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
  });
});
