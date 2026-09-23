import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as compact from "../../commands/doctor-state-sqlite-compact.js";
import { doctorCommand } from "../../commands/doctor.js";
import * as roots from "../../infra/openclaw-root.js";
import * as updateCheck from "../../infra/update-check.js";
import * as sentinel from "../../infra/update-control-plane-sentinel.js";
import {
  currentUpdateInitialStoreAdmission,
  withUpdateInitialStoreInvocation,
  type UpdateInitialStoreInvocation,
} from "../../infra/update-initial-store-invocation.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../../infra/update-managed-service-handoff-lease.js";
import * as shared from "./shared.js";
import * as commandRun from "./update-command-run.js";
import * as service from "./update-command-service-plan.js";
import { updateCommand } from "./update-command.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let input: UpdateInitialStoreInvocation;
let stateDir: string;
const stopped = new Error("test stopped at the next owned boundary");
function identity(file: string): string {
  const stat = fs.statSync(file, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}
function database(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Admission is deliberately filesystem-only; no consumer may open these fixture bytes.
  fs.writeFileSync(file, "unchanged fixture bytes", { mode: 0o600 });
  return {
    databasePath: fs.realpathSync(file),
    databaseIdentity: identity(file),
    parentIdentity: identity(path.dirname(file)),
  };
}
beforeEach(() => {
  const root = fs.realpathSync(dirs.make("update-private-caller-"));
  const install = path.join(root, "install");
  fs.mkdirSync(install, { mode: 0o700 });
  fs.writeFileSync(path.join(install, "package.json"), '{"name":"openclaw"}');
  stateDir = path.join(root, "profile");
  input = {
    version: 1,
    selection: {
      privateRoot: { path: root, identity: identity(root) },
      installation: { path: install, identity: identity(install) },
      handoff: database(path.join(root, "handoff", "managed-update-handoffs.sqlite")),
      state: database(path.join(stateDir, "state", "openclaw.sqlite")),
    },
  };
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  for (const key of [
    "OPENCLAW_UPDATE_RUN_HANDOFF",
    "OPENCLAW_UPDATE_RUN_ID",
    "OPENCLAW_UPDATE_POST_CORE",
    "OPENCLAW_SUPERVISOR_MODE",
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(install);
  vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("git");
  vi.spyOn(roots, "resolveOpenClawPackageRootSync").mockReturnValue(install);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["update", "doctor"] as const)(
  "refuses missing selected state before the %s caller's first operation",
  async (caller) => {
    const prepare = vi.spyOn(commandRun, "prepareUpdateCommand").mockRejectedValue(stopped);
    const maintenance = vi.spyOn(compact, "runDoctorStateSqliteCompact").mockRejectedValue(stopped);
    fs.unlinkSync(input.selection.state.databasePath);
    const operation =
      caller === "update"
        ? updateCommand({ initialStores: input })
        : doctorCommand(undefined, { initialStores: input, stateSqlite: "compact" });
    await expect(operation).rejects.toMatchObject({ code: "ENOENT" });
    expect(prepare).not.toHaveBeenCalled();
    expect(maintenance).not.toHaveBeenCalled();
    expect(fs.existsSync(input.selection.state.databasePath)).toBe(false);
    expect(currentUpdateInitialStoreAdmission()).toBeUndefined();
  },
);

it.each(["version", "unknown-field"] as const)(
  "rejects malformed %s input before preparation",
  async (change) => {
    const prepare = vi.spyOn(commandRun, "prepareUpdateCommand").mockRejectedValue(stopped);
    const malformed =
      change === "version" ? { ...input, version: 2 } : { ...input, authority: "not-a-grant" };
    await expect(
      updateCommand({ initialStores: malformed as unknown as UpdateInitialStoreInvocation }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(prepare).not.toHaveBeenCalled();
  },
);

it("admits the actual preparation caller before its sentinel read and selects the private handoff", async () => {
  const read = sentinel.readControlPlaneUpdateSentinelMeta;
  const sentinelRead = vi
    .spyOn(sentinel, "readControlPlaneUpdateSentinelMeta")
    .mockImplementation(async (env) => {
      expect(env?.OPENCLAW_STATE_DIR).toBe(stateDir);
      expect(resolveManagedUpdateLeaseDatabasePath()).toBe(input.selection.handoff.databasePath);
      return read(env);
    });
  const before = fs.readFileSync(input.selection.state.databasePath);
  await withUpdateInitialStoreInvocation(input, async () => {
    const prepared = await commandRun.prepareUpdateCommand({ dryRun: true });
    expect(prepared.discoveredRoot).toBe(input.selection.installation.path);
  });
  expect(sentinelRead).toHaveBeenCalledOnce();
  expect(fs.readFileSync(input.selection.state.databasePath)).toEqual(before);
  expect(currentUpdateInitialStoreAdmission()).toBeUndefined();
});

it.each(["state-replaced", "state-retargeted"] as const)(
  "refuses %s during the sentinel await before service preparation",
  async (change) => {
    vi.mocked(updateCheck.resolveUpdateInstallKind).mockResolvedValue("package");
    const plan = vi
      .spyOn(service, "resolveManagedServicePackageUpdatePlan")
      .mockResolvedValue({ rootRedirect: null });
    const read = sentinel.readControlPlaneUpdateSentinelMeta;
    vi.spyOn(sentinel, "readControlPlaneUpdateSentinelMeta").mockImplementation(async (env) => {
      const result = await read(env);
      if (change === "state-replaced") {
        const file = input.selection.state.databasePath;
        fs.renameSync(file, `${file}.displaced`);
        fs.writeFileSync(file, "replacement", { mode: 0o600 });
      } else {
        vi.stubEnv("OPENCLAW_STATE_DIR", path.join(input.selection.privateRoot.path, "different"));
      }
      return result;
    });
    await expect(
      withUpdateInitialStoreInvocation(input, () =>
        commandRun.prepareUpdateCommand({ dryRun: true }),
      ),
    ).rejects.toThrow(change === "state-replaced" ? "generation changed" : "selectors diverged");
    expect(plan).not.toHaveBeenCalled();
  },
);

it("refuses a different discovered installation before sentinel access", async () => {
  vi.mocked(shared.resolveUpdateRoot).mockResolvedValue(
    path.join(input.selection.privateRoot.path, "other"),
  );
  const read = vi.spyOn(sentinel, "readControlPlaneUpdateSentinelMeta");
  await expect(
    withUpdateInitialStoreInvocation(input, () =>
      commandRun.prepareUpdateCommand({ dryRun: true }),
    ),
  ).rejects.toThrow("selectors diverged");
  expect(read).not.toHaveBeenCalled();
});

it("rechecks the service redirect after awaited preparation", async () => {
  vi.mocked(updateCheck.resolveUpdateInstallKind).mockResolvedValue("package");
  vi.spyOn(service, "resolveManagedServicePackageUpdatePlan").mockResolvedValue({
    rootRedirect: {
      root: path.join(input.selection.privateRoot.path, "other"),
      previousRoot: input.selection.installation.path,
    },
  });
  await expect(
    withUpdateInitialStoreInvocation(input, () =>
      commandRun.prepareUpdateCommand({ dryRun: true }),
    ),
  ).rejects.toThrow("selectors diverged");
});

it("binds the direct Doctor caller to its executing installation", async () => {
  const maintenance = vi.spyOn(compact, "runDoctorStateSqliteCompact").mockRejectedValue(stopped);
  await expect(
    doctorCommand(undefined, { initialStores: input, stateSqlite: "compact" }),
  ).rejects.toBe(stopped);
  expect(maintenance).toHaveBeenCalledOnce();
  maintenance.mockClear();
  vi.mocked(roots.resolveOpenClawPackageRootSync).mockReturnValue(
    path.join(input.selection.privateRoot.path, "other"),
  );
  await expect(
    doctorCommand(undefined, { initialStores: input, stateSqlite: "compact" }),
  ).rejects.toThrow("selectors diverged");
  expect(maintenance).not.toHaveBeenCalled();
});

it("keeps ordinary update and Doctor invocations independent of private-root assumptions", async () => {
  fs.unlinkSync(input.selection.state.databasePath);
  vi.stubEnv(
    "OPENCLAW_STATE_DIR",
    path.join(input.selection.privateRoot.path, "ordinary-uninitialized"),
  );
  const prepare = vi.spyOn(commandRun, "prepareUpdateCommand").mockRejectedValue(stopped);
  const maintenance = vi.spyOn(compact, "runDoctorStateSqliteCompact").mockRejectedValue(stopped);
  await expect(updateCommand({})).rejects.toBe(stopped);
  await expect(doctorCommand(undefined, { stateSqlite: "compact" })).rejects.toBe(stopped);
  expect(prepare).toHaveBeenCalledOnce();
  expect(maintenance).toHaveBeenCalledOnce();
});

it.each(["prepared-generation", "service-environment"] as const)(
  "the update entry revalidates %s before run admission",
  async (change) => {
    const prepare = commandRun.prepareUpdateCommand;
    const resolveEnv = vi.spyOn(commandRun, "resolveUpdateCommandAdmissionEnv");
    if (change === "prepared-generation") {
      vi.spyOn(commandRun, "prepareUpdateCommand").mockImplementation(async (opts) => {
        const prepared = await prepare(opts);
        const file = input.selection.state.databasePath;
        fs.renameSync(file, `${file}.displaced`);
        fs.writeFileSync(file, "replacement", { mode: 0o600 });
        return prepared;
      });
    } else {
      resolveEnv.mockResolvedValue({
        ...process.env,
        OPENCLAW_STATE_DIR: path.join(input.selection.privateRoot.path, "other-profile"),
      });
    }
    const admitRun = vi.spyOn(commandRun, "admitUpdateCommandRun").mockRejectedValue(stopped);
    await expect(updateCommand({ initialStores: input, dryRun: true })).rejects.toThrow(
      change === "prepared-generation" ? "generation changed" : "selectors diverged",
    );
    expect(admitRun).not.toHaveBeenCalled();
    if (change === "prepared-generation") expect(resolveEnv).not.toHaveBeenCalled();
    else expect(resolveEnv).toHaveBeenCalledOnce();
  },
);
