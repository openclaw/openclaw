import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState } from "../config/config.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { runWithGatewayDetachedWorkAdmission } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-maintenance-context.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each(["missing", "zero-byte"])(
  "preserves a %s database when the local operation refuses before needing config",
  async (kind) => {
    const root = roots.make("openclaw-routing-refusal-");
    const configPath = path.join(root, "openclaw.json");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    await fs.mkdir(path.dirname(databasePath));
    await fs.writeFile(configPath, "{}");
    if (kind === "zero-byte") {
      await fs.writeFile(databasePath, "");
    }
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    const refusal = new Error("Outcome refused before writing");
    await expect(
      runWithLocalStateOwner({
        method: "backup.recordOutcome",
        params: {},
        target: "backup outcome ledger",
        runLocal: async () => {
          throw refusal;
        },
      }),
    ).rejects.toBe(refusal);
    if (kind === "missing") {
      await expect(fs.readFile(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(await fs.readFile(databasePath)).toEqual(Buffer.alloc(0));
    }
  },
);

it("keeps the command's databases open until detached work it admitted settles", async () => {
  const root = roots.make("openclaw-local-detached-work-");
  const configPath = path.join(root, "openclaw.json");
  await fs.writeFile(configPath, "{}");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const release = createDeferredCore();
  let detached: Promise<void> | undefined;
  let ownerSettled = false;
  // Subagent completion and announcements run as detached root work after the command returns.
  const owner = runWithLocalStateOwner({
    method: "backup.recordOutcome",
    params: {},
    target: "backup outcome ledger",
    runLocal: async () => {
      detached = runWithGatewayDetachedWorkAdmission(async () => {
        await release.promise;
        getOpenClawDatabaseMaintenanceScope()?.assertAdmission();
      }, "test:detached-write");
      return "returned";
    },
  }).finally(() => {
    ownerSettled = true;
  });
  await vi.waitFor(() =>
    expect(stderr).toHaveBeenCalledWith(
      "Waiting for 1 background task to finish. Press Ctrl-C to stop.\n",
    ),
  );
  expect(ownerSettled).toBe(false);
  release.resolve();
  await expect(detached).resolves.toBeUndefined();
  await expect(owner).resolves.toBe("returned");
});

// A Gateway request waits on a config write lock the command holds (models.authLogout vs a
// registered `config set`). A process that holds Gateway custody runs the command as the hosted
// owner, which never waits; a regression would deadlock, so the lock is released when the owner
// starts waiting and the test fails fast instead of timing out.
it.each(["before", "after"] as const)(
  "never waits for Gateway work admitted %s a hosted command starts",
  async (order) => {
    const root = roots.make("openclaw-local-host-work-");
    const configPath = path.join(root, "openclaw.json");
    await fs.writeFile(configPath, "{}");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    const custody = await acquireGatewayLock({
      env: process.env,
      allowInTests: true,
      timeoutMs: 0,
    });
    const configLock = createDeferredCore();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      configLock.resolve();
      return true;
    });
    let request: Promise<void> | undefined;
    const admitRequest = () => {
      request = runWithGatewayDetachedWorkAdmission(
        () => configLock.promise,
        "test:gateway-request",
      );
    };
    try {
      if (order === "before") {
        admitRequest();
      }
      await expect(
        runWithLocalStateOwner({
          method: "backup.recordOutcome",
          params: {},
          target: "backup outcome ledger",
          runLocal: async () => {
            if (order === "after") {
              admitRequest();
            }
            return "returned";
          },
        }),
      ).resolves.toBe("returned");
      expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("Waiting for"));
    } finally {
      configLock.resolve();
      await request;
      await custody?.release();
    }
  },
);
