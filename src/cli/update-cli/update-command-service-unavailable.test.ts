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
import * as gatewayNamespace from "../../infra/gateway-lock-payload.js";
import * as processes from "../../infra/gateway-lock-process.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import * as packageFilesystem from "../../infra/package-update-filesystem.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import { isPublicUpdateFailureCode } from "../../infra/update-failure-public-codes.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import * as processIdentity from "../../shared/pid-alive.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { mockProcessPlatform, withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { UpdatePreMutationError } from "./shared.js";
import { inspectUpdateManagedServices } from "./update-command-database-context.js";
import * as databaseContext from "./update-command-database-context.js";
import { installFreshUpdateFixture } from "./update-command-fresh.test-support.js";
import * as packageUpdate from "./update-command-package.js";
import { updateCommand } from "./update-command.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const hostPlatform = process.platform;
const hostNamespace = gatewayNamespace.readGatewayLockProcessNamespace();
function withHostPlatform<T>(run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { configurable: true, value: hostPlatform });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}
beforeEach(() => {
  // Service platform mocks do not change the local test process's namespace.
  vi.spyOn(gatewayNamespace, "readGatewayLockProcessNamespace").mockReturnValue(hostNamespace);
  const classifyNamespace = gatewayNamespace.classifyGatewayLockProcessNamespace;
  vi.spyOn(gatewayNamespace, "classifyGatewayLockProcessNamespace").mockImplementation((...args) =>
    withHostPlatform(() => classifyNamespace(...args)),
  );
  const isAlive = processIdentity.isPidAlive;
  const isDead = processIdentity.isPidDefinitelyDead;
  vi.spyOn(processIdentity, "isPidAlive").mockImplementation((pid) =>
    withHostPlatform(() => isAlive(pid)),
  );
  vi.spyOn(processIdentity, "isPidDefinitelyDead").mockImplementation((pid) =>
    withHostPlatform(() => isDead(pid)),
  );
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

function serviceHome(home: string) {
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, ".openclaw"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(home, ".openclaw", "openclaw.json"));
  mockSystemAccountHome();
}

function unavailableService(
  reason: "service-manager-unavailable" | "windows-task-inspection-failed",
) {
  const native = createMockGatewayService({
    readCommand: async () => {
      throw new ServiceInspectionError(reason);
    },
  });
  vi.spyOn(service, "resolveGatewayService").mockReturnValue(native);
  return native;
}

function gatewayOwner(pid = process.pid) {
  return acquireGatewayStateOwner({
    databasePath: resolveOpenClawStateSqlitePath(),
    payload: {
      pid,
      processNamespace: gatewayNamespace.readGatewayLockProcessNamespace(),
      createdAt: new Date().toISOString(),
      configPath: process.env.OPENCLAW_CONFIG_PATH!,
      role: "gateway",
      port: 18789,
    },
  });
}
const readPackage = (root: string) =>
  JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

it.each([
  { platform: "win32", owner: "same", refused: true },
  { platform: "win32", owner: "absent", refused: false },
  { platform: "win32", owner: "unreadable", refused: true },
  { platform: "win32", owner: "other", refused: false },
  { platform: "win32", owner: "foreign", refused: true },
  { platform: "win32", owner: "dead", refused: false },
  { platform: "linux", owner: "same", refused: true },
  { platform: "linux", owner: "relative", refused: true },
  { platform: "linux", owner: "retitled", refused: true },
  { platform: "linux", owner: "unreadable", refused: true },
  { platform: "linux", owner: "other", refused: false },
  { platform: "linux", owner: "absent", refused: false },
] as const)(
  "admits unavailable service inspection safely ($platform, owner=$owner)",
  async ({ platform, owner, refused }) => {
    const home = dirs.make("update-service-unavailable-");
    const root = path.join(home, "live", "lib", "node_modules", "openclaw");
    await writePackageRoot(root, "1.0.0");
    const other = path.join(home, "other");
    await writePackageRoot(other, "1.0.0");
    if (owner === "foreign") {
      fs.writeFileSync(
        path.join(other, "package.json"),
        JSON.stringify({ name: "other", version: "1.0.0" }),
      );
    }
    vi.stubEnv("HOME", home);
    serviceHome(home);
    mockProcessPlatform(platform);
    const native = unavailableService("service-manager-unavailable");
    const ownerRoot = owner === "other" || owner === "foreign" ? other : root;
    const launcher =
      owner === "relative" ? "./dist/index.js" : path.join(ownerRoot, "dist", "index.js");
    vi.spyOn(processes, "readGatewayLockProcessCmdline").mockReturnValue(
      owner === "unreadable"
        ? null
        : owner === "retitled"
          ? ["openclaw-gateway"]
          : [process.execPath, launcher, "gateway"],
    );
    const readlink = fs.readlinkSync;
    vi.spyOn(fs, "readlinkSync").mockImplementation((pathname, options) =>
      pathname === `/proc/${process.pid}/cwd` ? root : readlink(pathname, options),
    );
    const live =
      owner === "absent" ? undefined : gatewayOwner(owner === "dead" ? 0x7fff_ffff : process.pid);
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
            /service manager.*terminal.*openclaw gateway stop.*openclaw update/,
          ),
          failureFacts: [
            expect.objectContaining({ code: "gateway-stop-unverified" }),
            expect.objectContaining({ code: "service-manager-unavailable" }),
          ],
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
  it.each(["win32", "linux"] as const)(
    "refuses %s package replacement before backup with an uninspectable live Gateway",
    async (platform) => {
      vi.mocked(databaseContext.inspectUpdateDatabaseContexts).mockRestore();
      serviceHome(process.env.HOME!);
      openOpenClawStateDatabase();
      const candidate = path.join(process.env.HOME!, "candidate");
      await writePackageRoot(candidate, "2026.9.2");
      vi.mocked(packageUpdate.stagePackageInstallUpdate).mockResolvedValue({
        root: candidate,
        run: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      });
      const inspect = databaseContext.inspectUpdateDatabaseContexts;
      // Keep native file admission on the host; only service admission observes the selected platform.
      vi.spyOn(databaseContext, "inspectUpdateDatabaseContexts").mockImplementation((params) =>
        withMockedPlatform(platform, () => inspect(params)),
      );
      const native = unavailableService(
        platform === "win32" ? "windows-task-inspection-failed" : "service-manager-unavailable",
      );
      const live = withMockedPlatform(platform, () => gatewayOwner());
      vi.spyOn(processes, "readGatewayLockProcessCmdline").mockReturnValue(
        platform === "win32" ? null : ["openclaw-gateway"],
      );
      const backup = vi.spyOn(packageFilesystem, "backupNpmPackageRoot");
      try {
        await expect(updateCommand({ json: true, yes: true })).rejects.toBeInstanceOf(ExitError);
        expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
          expect.objectContaining({ status: "error", reason: "gateway-stop-unverified" }),
        );
        expect(backup).not.toHaveBeenCalled();
        expect(native.stop).not.toHaveBeenCalled();
        expect(readPackage(fixture.root)).toMatchObject({ version: "2026.9.3" });
      } finally {
        live.release();
      }
    },
  );
});
