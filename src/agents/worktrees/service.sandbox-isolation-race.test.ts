import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as stateLease from "../../state/openclaw-state-lease.js";
import { registerSandboxBackend } from "../sandbox/backend.js";
import { insertRegistryWorktree } from "./registry.js";
import { markRegistryRepositorySandboxGitByRoot } from "./repository-provenance.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";
import type { ManagedWorktreeRecord } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const initializeRepository = useManagedWorktreeTestRepository();
const cleanups: Array<() => void> = [];

function sandboxConfig(stateDir: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          scope: "session",
          workspaceAccess: "rw",
        },
      },
    },
    worktreeRoot: path.join(stateDir, "worktrees"),
  };
}

describe("managed worktree isolation admission", () => {
  let root: string;
  let repo: string;
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let config: OpenClawConfig;
  let service: ManagedWorktreeService;

  beforeEach(async () => {
    root = tempDirs.make("openclaw-worktree-isolation-race-");
    repo = await initializeRepository(root);
    stateDir = path.join(root, "state");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    config = sandboxConfig(stateDir);
    service = new ManagedWorktreeService({
      env,
      getConfig: () => config,
      getRuntimeConfig: () => config,
    });
    cleanups.push(
      registerSandboxBackend("docker", async () => {
        throw new Error("sandbox selected after admission");
      }),
    );
  });

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
  });

  it("rereads repository isolation after a waiting create is admitted", async () => {
    const admissionEntered = createDeferred();
    const releaseAdmission = createDeferred();
    vi.spyOn(stateLease, "withOpenClawStateLease").mockImplementation(async (_options, run) => {
      admissionEntered.resolve();
      await releaseAdmission.promise;
      return await run({
        signal: new AbortController().signal,
        assertOwned: vi.fn(),
        assertOwnedInTransaction: vi.fn(),
      });
    });

    const pending = service.create({ repoRoot: repo, name: "waiting-create" });
    await admissionEntered.promise;
    markRegistryRepositorySandboxGitByRoot({
      env,
      repoRoot: repo,
      isolation: { sessionKey: "agent:main:subagent:writer" },
    });
    releaseAdmission.resolve();

    await expect(pending).rejects.toThrow("sandbox selected after admission");
  });

  it.each(["remove", "restore"] as const)(
    "uses durable repository isolation for a stale unmarked record during %s",
    async (operation) => {
      const record: ManagedWorktreeRecord = {
        id: `stale-${operation}`,
        name: `stale-${operation}`,
        repoFingerprint: "0123456789abcdef",
        repoRoot: repo,
        path: path.join(root, `stale-${operation}`),
        branch: `openclaw/stale-${operation}`,
        baseRef: "HEAD",
        ownerKind: "manual",
        createdAt: 1,
        lastActiveAt: 1,
        ...(operation === "restore"
          ? { removedAt: 2, snapshotRef: "refs/openclaw/worktree-snapshots/stale" }
          : {}),
      };
      await fs.mkdir(record.path, { recursive: true });
      insertRegistryWorktree(env, record);
      markRegistryRepositorySandboxGitByRoot({
        env,
        repoRoot: repo,
        isolation: { sessionKey: "agent:main:subagent:writer" },
      });

      const pending =
        operation === "remove"
          ? service.remove({ id: record.id, reason: "isolation-race-test" })
          : service.restore({ id: record.id });
      await expect(pending).rejects.toThrow("sandbox selected after admission");
    },
  );
});
