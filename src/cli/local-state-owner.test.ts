import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState } from "../config/config.js";
import { runWithGatewayDetachedWorkAdmission } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-maintenance-context.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";

const processRole = vi.hoisted(() => ({ current: undefined as "gateway" | undefined }));
vi.mock("../infra/database-engine/admission-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/database-engine/admission-scope.js")>()),
  // The real role is a process-wide singleton; a test must not install it for later files.
  getDatabaseProcessRole: () => processRole.current,
}));

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

describe("in a process that hosts a Gateway", () => {
  afterEach(() => {
    processRole.current = undefined;
  });
  // A Gateway request waits on a config write lock the command holds (models.authLogout vs a
  // registered `config set`). Waiting for it would deadlock; release the lock when the owner
  // starts waiting so a regression fails fast instead of timing out.
  it.each(["before", "after"] as const)(
    "does not wait for Gateway work admitted %s the command starts",
    async (order) => {
      processRole.current = "gateway";
      const root = roots.make("openclaw-local-host-work-");
      const configPath = path.join(root, "openclaw.json");
      await fs.writeFile(configPath, "{}");
      vi.stubEnv("OPENCLAW_STATE_DIR", root);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
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
      configLock.resolve();
      await request;
    },
  );
});
