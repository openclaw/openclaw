import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { ServiceInspectionError } from "../../daemon/service-inspection-error.js";
import * as service from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as processes from "../../infra/gateway-lock-process.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import * as packageFilesystem from "../../infra/package-update-filesystem.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import { isPublicUpdateFailureCode } from "../../infra/update-failure-public-codes.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { UpdatePreMutationError } from "./shared.js";
import { inspectUpdateManagedServices } from "./update-command-database-context.js";
import * as databaseContext from "./update-command-database-context.js";
import { installFreshUpdateFixture } from "./update-command-fresh.test-support.js";
import * as packageUpdate from "./update-command-package.js";
import { updateCommand } from "./update-command.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  for (const key of [
    "OPENCLAW_UPDATE_RUN_HANDOFF",
    "OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META",
    "OPENCLAW_SUPERVISOR_MODE",
    "OPENCLAW_PROFILE",
    "OPENCLAW_HOME",
    "OPENCLAW_SYSTEMD_UNIT",
    "OPENCLAW_WINDOWS_TASK_NAME",
    "OPENCLAW_LAUNCHD_LABEL",
  ]) {
    vi.stubEnv(key, undefined);
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  { platform: "win32", owner: "same", refused: true },
  { platform: "win32", owner: "absent", refused: true },
  { platform: "linux", owner: "same", refused: true },
  { platform: "linux", owner: "relative", refused: true },
  { platform: "linux", owner: "other", refused: false },
  { platform: "linux", owner: "absent", refused: false },
] as const)(
  "admits unavailable service inspection safely ($platform, owner=$owner)",
  async ({ platform, owner, refused }) => {
    const home = dirs.make("update-service-unavailable-");
    const root = path.join(home, "install");
    const other = path.join(home, "other");
    await writePackageRoot(root, "1.0.0");
    await writePackageRoot(other, "1.0.0");
    vi.stubEnv("HOME", home);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, ".openclaw"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(home, ".openclaw", "openclaw.json"));
    mockSystemAccountHome();
    mockProcessPlatform(platform);
    const native = createMockGatewayService({
      readCommand: async () => {
        throw new ServiceInspectionError("service-manager-unavailable");
      },
    });
    vi.spyOn(service, "resolveGatewayService").mockReturnValue(native);
    vi.spyOn(processes, "readGatewayLockProcessCmdline").mockReturnValue([
      process.execPath,
      owner === "relative"
        ? "./dist/index.js"
        : path.join(owner === "other" ? other : root, "dist", "index.js"),
      "gateway",
    ]);
    const readlink = fs.readlinkSync;
    vi.spyOn(fs, "readlinkSync").mockImplementation((pathname, options) =>
      pathname === `/proc/${process.pid}/cwd` ? root : readlink(pathname, options),
    );
    const live =
      owner === "absent"
        ? undefined
        : acquireGatewayStateOwner({
            databasePath: resolveOpenClawStateSqlitePath(),
            payload: {
              pid: process.pid,
              createdAt: new Date().toISOString(),
              configPath: process.env.OPENCLAW_CONFIG_PATH!,
              role: "gateway",
              port: 18789,
            },
          });
    const admission = inspectUpdateManagedServices({
      roots: [root],
      updateInstallKind: "package",
      shouldRestart: true,
      jsonMode: true,
      timeoutMs: 1_000,
      managedServiceRootRedirect: null,
    });
    try {
      if (refused) {
        const failure = await admission.catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(UpdatePreMutationError);
        expect(failure).toMatchObject({
          reason: "gateway-stop-unverified",
          message: expect.stringMatching(
            /Task Scheduler.*terminal.*openclaw gateway stop.*openclaw update/,
          ),
          failureFacts: [expect.objectContaining({ code: "gateway-stop-unverified" })],
        });
        expect(isPublicUpdateFailureCode("gateway-stop-unverified")).toBe(true);
      } else {
        expect((await admission).services.get(root)?.serviceUpdateVerdict?.kind).toBe(
          "unavailable",
        );
      }
      expect(native.stop).not.toHaveBeenCalled();
    } finally {
      live?.release();
    }
  },
);

describe("package update entry point", () => {
  const { fixture } = installFreshUpdateFixture();
  it("refuses Windows package replacement before backup with an uninspectable live Gateway", async () => {
    vi.mocked(databaseContext.inspectUpdateDatabaseContexts).mockRestore();
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(process.env.HOME!, ".openclaw"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(process.env.HOME!, ".openclaw", "openclaw.json"));
    mockSystemAccountHome();
    openOpenClawStateDatabase();
    const candidate = path.join(process.env.HOME!, "candidate");
    await writePackageRoot(candidate, "2026.9.2");
    vi.mocked(packageUpdate.stagePackageInstallUpdate).mockResolvedValue({
      root: candidate,
      run: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    });
    const platform = process.platform;
    const inspect = databaseContext.inspectUpdateDatabaseContexts;
    // Keep native file admission on the host; only service admission observes Windows.
    vi.spyOn(databaseContext, "inspectUpdateDatabaseContexts").mockImplementation(
      async (params) => {
        mockProcessPlatform("win32");
        try {
          return await inspect(params);
        } finally {
          mockProcessPlatform(platform);
        }
      },
    );
    const native = createMockGatewayService({
      readCommand: async () => {
        throw new ServiceInspectionError("windows-task-inspection-failed");
      },
    });
    vi.spyOn(service, "resolveGatewayService").mockReturnValue(native);
    const live = acquireGatewayStateOwner({
      databasePath: resolveOpenClawStateSqlitePath(),
      payload: {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath: process.env.OPENCLAW_CONFIG_PATH!,
        role: "gateway",
        port: 18789,
      },
    });
    const backup = vi.spyOn(packageFilesystem, "backupNpmPackageRoot");
    try {
      await expect(updateCommand({ json: true, yes: true })).rejects.toBeInstanceOf(ExitError);
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "error",
          reason: "gateway-stop-unverified",
        }),
      );
      expect(backup).not.toHaveBeenCalled();
      expect(native.stop).not.toHaveBeenCalled();
      expect(
        JSON.parse(fs.readFileSync(path.join(fixture.root, "package.json"), "utf8")),
      ).toMatchObject({ version: "2026.9.3" });
    } finally {
      live.release();
    }
  });
});
