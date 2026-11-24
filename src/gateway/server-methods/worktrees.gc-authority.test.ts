import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  initializeManagedWorktreeTestRepository,
  materializeManagedWorktreeFixture,
  git,
} from "../../agents/worktrees/service.test-support.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import * as commands from "../../process/exec-runner.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import { startWorktreeMaintenance } from "../worktree-maintenance.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { worktreesHandlers } from "./worktrees.js";

const temps = useStateDatabaseTempDirs();
afterEach(() => {
  vi.unstubAllEnvs();
  clearRuntimeConfigSnapshot();
});

it.each(["write-only", "revoked", "replaced", "authorized"] as const)(
  "ordinary GC uses real state ownership and deletion: %s",
  async (kind) => {
    const root = temps.make("gc-branch-authority-");
    const stateDir = path.join(root, "state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const repo = await initializeManagedWorktreeTestRepository(root);
    const databasePath = path.join(stateDir, "state/openclaw.sqlite");
    const acquire = (ownerId: string) =>
      acquireGatewayStateOwner({
        databasePath,
        payload: {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          configPath: path.join(stateDir, "openclaw.json"),
          role: "gateway",
          ownerId,
        },
      });
    let stateOwner = acquire("original");
    const cfg: OpenClawConfig = {
      worktreeAcceleration: false,
      agents: { defaults: { workspace: repo } },
    };
    setRuntimeConfigSnapshot(cfg);
    const getRuntimeConfig = () => cfg;
    const clock = createGatewaySchedulerClock(Date.now());
    const scheduler = createTestGatewayScheduler(clock.clock);
    const completed = createDeferred();
    const errors: string[] = [];
    const maintenance = stateOwner.run(() =>
      startWorktreeMaintenance({
        scheduler,
        getRuntimeConfig,
        onComplete: () => completed.resolve(),
        onError: (error) => {
          errors.push(error);
          completed.resolve();
        },
      }),
    );
    try {
      await stateOwner.run(() =>
        materializeManagedWorktreeFixture({
          env: process.env,
          stateDir,
          repoRoot: repo,
          name: "live",
          ownerKind: "manual",
          now: Date.now(),
        }),
      );
      await git(repo, "branch", "openclaw/orphan");
      const respond = vi.fn();
      const options: GatewayRequestHandlerOptions = {
        req: { type: "req", id: "gc", method: "worktrees.gc" },
        params: { expectedOwnerId: "original" },
        client: createOperatorClient({
          profileId: "synthetic-admin",
          scopes: [kind === "write-only" ? "operator.write" : "operator.admin"],
        }),
        isWebchatConnect: () => false,
        respond,
        context: createContext([], getRuntimeConfig),
        hasCurrentClientAuthority: () => kind !== "revoked",
      };
      if (kind === "replaced") {
        await closeOpenClawStateDatabaseAsync();
        stateOwner.release();
        stateOwner = acquire("replacement");
      }
      const effects = vi.spyOn(commands, "runCommandWithTimeout");
      // The abandoned caller-selected deletion payload is rejected by the real schema.
      await worktreesHandlers["worktrees.gc"]!({
        ...options,
        params: { ...options.params, orphanBranches: { repoRoot: repo } },
      });
      expect(respond.mock.lastCall?.[0]).toBe(false);
      expect(effects).not.toHaveBeenCalled();
      respond.mockClear();
      await stateOwner.run(() => worktreesHandlers["worktrees.gc"]!(options));
      if (kind !== "authorized") {
        expect(respond.mock.lastCall?.[0]).toBe(false);
        expect(respond.mock.lastCall?.[2]).toMatchObject({
          code: kind === "write-only" ? "FORBIDDEN" : "UNAVAILABLE",
        });
        expect(effects).not.toHaveBeenCalled();
        expect(await git(repo, "branch", "--list", "openclaw/orphan")).toBe("openclaw/orphan");
      } else {
        expect(respond.mock.lastCall?.[0]).toBe(true);
        await clock.wake();
        await completed.promise;
        expect(errors).toEqual([]);
        expect(
          effects.mock.calls.some(([args]) => args.includes("branch") && args.includes("-D")),
        ).toBe(true);
        expect(await git(repo, "branch", "--list", "openclaw/orphan")).toBe("");
        expect(await git(repo, "branch", "--list", "openclaw/live")).toBe("+ openclaw/live");
      }
    } finally {
      await maintenance.stop();
      await scheduler.stop();
      await closeOpenClawStateDatabaseAsync();
      stateOwner.release();
    }
  },
);
