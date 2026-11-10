import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readGatewayLockProcessNamespace } from "../infra/gateway-lock-payload.js";
import { StateDatabaseOfflineMaintenanceError } from "../infra/gateway-state-owner-errors.js";
import { resolveGatewayStateOwnerPath } from "../infra/gateway-state-owner.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { writeConfigMachineState } from "./config-machine-state-write.js";
import { readConfigMachineState } from "./config-machine-state.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const ownerPaths: string[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const ownerPath of ownerPaths.splice(0)) {
      fs.rmSync(ownerPath, { force: true });
    }
    await closeStateDatabaseForTest();
    cleanup();
  });
});

async function seedClosedState() {
  const options = { env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("machine-read-") } };
  writeConfigMachineState("fixture.mode", { mode: "seeded" }, options);
  // Readers in a fresh CLI process open the file, not this test's cached handle.
  await closeStateDatabaseForTest();
  return { options, databasePath: resolveOpenClawStateSqlitePath(options.env) };
}

/** Another live CLI's owner record: a transient schema lease, or offline maintenance. */
function publishForeignOwner(databasePath: string, kind: "schema" | "offline-maintenance") {
  const ownerPath = resolveGatewayStateOwnerPath(databasePath);
  fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
  fs.writeFileSync(
    ownerPath,
    JSON.stringify({
      pid: process.ppid,
      ownerId: `foreign-${kind}-fixture`,
      createdAt: new Date().toISOString(),
      configPath: path.join(path.dirname(databasePath), "openclaw.json"),
      processNamespace: readGatewayLockProcessNamespace(),
      role: "sqlite-maintenance",
      ...(kind === "schema" ? { stateOwnerKind: "schema" } : {}),
    }),
  );
  ownerPaths.push(ownerPath);
  return ownerPath;
}

it("waits for another CLI's transient schema lease before a read-only state read", async () => {
  const { options, databasePath } = await seedClosedState();
  const ownerPath = publishForeignOwner(databasePath, "schema");
  // The foreign CLI finishes its schema preparation while this reader waits.
  const wait = vi.spyOn(Atomics, "wait").mockImplementation(() => {
    fs.rmSync(ownerPath);
    return "ok";
  });

  expect(readConfigMachineState("fixture.mode", options)).toEqual({ mode: "seeded" });
  expect(wait).toHaveBeenCalledOnce();
});

it("still refuses a read-only state read during offline maintenance without waiting", async () => {
  const { options, databasePath } = await seedClosedState();
  publishForeignOwner(databasePath, "offline-maintenance");
  const wait = vi.spyOn(Atomics, "wait");

  expect(() => readConfigMachineState("fixture.mode", options)).toThrow(
    StateDatabaseOfflineMaintenanceError,
  );
  expect(() => readConfigMachineState("fixture.mode", options)).toThrow(
    /undergoing offline maintenance by sqlite-maintenance process/,
  );
  expect(wait).not.toHaveBeenCalled();
});
