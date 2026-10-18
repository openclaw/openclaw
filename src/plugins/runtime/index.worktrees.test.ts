import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as config from "../../config/config.js";
import * as gatewayLock from "../../infra/gateway-lock.js";
import * as gatewayOwner from "../../infra/gateway-state-owner.js";
import { createPluginRuntime } from "./index.js";

const effects = vi.hoisted(() => ({
  create: vi.fn(),
  acquire: vi.fn(),
  releaseByPath: vi.fn(),
  removeIfLosslessByPath: vi.fn(),
}));

// mock-isolation: Observe domain effects without opening databases or running Git.
vi.mock("../../agents/worktrees/service.js", () => ({
  managedWorktrees: effects,
  ManagedWorktreeService: class {
    create = effects.create;
    acquire = effects.acquire;
    releaseByPath = effects.releaseByPath;
    removeIfLosslessByPath = effects.removeIfLosslessByPath;
  },
}));

const roots = useAutoCleanupTempDirTracker(afterEach);
const createParams = {
  repoRoot: "/repo",
  name: "plugin-owned",
  ownerKind: "workboard" as const,
  ownerId: "card-1",
};

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("plugin-worktree-owner-"));
  vi.spyOn(config, "getRuntimeConfig").mockReturnValue({});
  vi.spyOn(gatewayOwner, "captureGatewayStateOwner").mockReturnValue(undefined);
  vi.spyOn(gatewayLock, "readActiveGatewayLockIdentity").mockResolvedValue({
    pid: process.pid + 1,
    ownerId: "foreign-owner",
    createdAt: "2026-01-01T00:00:00Z",
    port: 18789,
  });
  effects.create.mockResolvedValue({ id: "worktree-1", path: "/checkout", branch: "plugin-owned" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("plugin worktree state ownership", () => {
  it.each(["create", "release", "removeIfLossless"] as const)(
    "refuses %s before domain effects when another process owns the state",
    async (operation) => {
      const worktrees = createPluginRuntime().worktrees;
      const pending =
        operation === "create"
          ? worktrees.create(createParams)
          : operation === "release"
            ? worktrees.release({ path: "/checkout" })
            : worktrees.removeIfLossless({
                path: "/checkout",
                ownerKind: "workboard",
                ownerId: "card-1",
              });
      await expect(pending).rejects.toMatchObject({
        code: "OWNER_UNAVAILABLE",
        message: expect.stringContaining("No local mutation was attempted"),
      });
      for (const effect of Object.values(effects)) {
        expect(effect).not.toHaveBeenCalled();
      }
    },
  );

  it("preserves the plugin guard and rejects authority loss after awaited creation", async () => {
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("owner retired");
      }
    };
    vi.mocked(gatewayOwner.captureGatewayStateOwner).mockReturnValue({
      ownerId: "hosted-owner",
      role: "gateway",
      assertCurrent,
      signal: new AbortController().signal,
    });
    effects.create.mockImplementationOnce(async (params: { commitGuard: () => void }) => {
      params.commitGuard();
      current = false;
      return { id: "worktree-1", path: "/checkout", branch: "plugin-owned" };
    });
    const pluginGuard = vi.fn();
    await expect(
      createPluginRuntime().worktrees.create({ ...createParams, commitGuard: pluginGuard }),
    ).rejects.toThrow("owner retired");
    expect(pluginGuard).toHaveBeenCalled();
    expect(effects.create).toHaveBeenCalledOnce();
    expect(effects.acquire).not.toHaveBeenCalled();
  });
});
