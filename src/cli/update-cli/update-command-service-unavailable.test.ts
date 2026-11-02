import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { GATEWAY_SERVICE_SELECTOR_ENV_KEYS } from "../../daemon/constants.js";
import {
  ServiceInspectionError,
  type ServiceInspectionReason,
} from "../../daemon/service-inspection-error.js";
import * as service from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import { listDirectoryTreeStrictSync } from "../../infra/directory-walk.js";
import * as gatewayNamespace from "../../infra/gateway-lock-payload.js";
import * as processes from "../../infra/gateway-lock-process.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import * as packageFilesystem from "../../infra/package-update-filesystem.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import * as processIdentity from "../../shared/pid-alive.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { mockProcessPlatform, withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { writeFixtureJsonSync } from "../cli-fixtures.test-support.js";
import { readPackageVersion } from "./shared.js";
import * as databaseContext from "./update-command-database-context.js";
import { createStage } from "./update-command-fresh-preview.test-support.js";
import { installFreshUpdateFixture } from "./update-command-fresh.test-support.js";
import * as packageUpdate from "./update-command-package.js";
import { UpdateCommandFailure } from "./update-command-result.js";
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
  for (const key of ["isPidAlive", "isPidDefinitelyDead"] as const) {
    const original = processIdentity[key];
    vi.spyOn(processIdentity, key).mockImplementation((pid) =>
      withHostPlatform(() => original(pid)),
    );
  }
  mockSystemAccountHome();
  for (const key of [
    ...GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
    "OPENCLAW_UPDATE_RUN_HANDOFF",
    "OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META",
    "OPENCLAW_SUPERVISOR_MODE",
    "OPENCLAW_HOME",
  ]) {
    vi.stubEnv(key, undefined);
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function unavailableService(reason: ServiceInspectionReason) {
  const native = createMockGatewayService();
  vi.spyOn(native, "readCommand").mockRejectedValue(new ServiceInspectionError(reason));
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

it.each([
  ["win32", "same", true, "service-manager-unavailable"],
  ["win32", "absent", false, "service-manager-unavailable"],
  ["win32", "unreadable", true, "service-manager-unavailable"],
  ["win32", "other", false, "service-manager-unavailable"],
  ["win32", "foreign", true, "service-manager-unavailable"],
  ["win32", "dead", false, "service-manager-unavailable"],
  ["linux", "same", true, "systemd-user-bus-unavailable"],
  ["linux", "relative", true, "systemd-inspection-deadline-exceeded"],
  ["linux", "retitled", true, "service-manager-unavailable"],
  ["linux", "unreadable", true, "service-manager-access-denied"],
  ["linux", "other", false, "service-manager-unavailable"],
  ["linux", "absent", false, "service-manager-unavailable"],
  ["linux", "absent", false, "systemd-user-bus-unavailable"],
  ["linux", "absent", false, "service-manager-access-denied"],
  ["linux", "absent", false, "systemd-inspection-deadline-exceeded"],
  ["darwin", "same", true, "launchd-gui-domain-unavailable"],
  ["linux", "same", false, "systemd-user-bus-unavailable", true],
  ["win32", "same", false, "windows-task-inspection-failed", true],
] as const)(
  "admits unavailable service inspection safely (%s, owner=%s, refused=%s, reason=%s, already-current=%s)",
  async (platform, owner, refused, reason, packageAlreadyCurrent?: boolean) => {
    const home = dirs.make("update-service-unavailable-");
    const root = path.join(home, "live", "lib", "node_modules", "openclaw");
    await writePackageRoot(root, "1.0.0");
    const other = path.join(home, "other");
    await writePackageRoot(other, "1.0.0");
    if (owner === "foreign") {
      writeFixtureJsonSync(path.join(other, "package.json"), { name: "other", version: "1.0.0" });
    }
    vi.stubEnv("HOME", home);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, ".openclaw"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(home, ".openclaw", "openclaw.json"));
    mockProcessPlatform(platform);
    const native = unavailableService(reason);
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
    const admission = databaseContext.inspectUpdateManagedServices({
      roots: [root],
      packageAlreadyCurrent,
      updateInstallKind: "package",
      shouldRestart: true,
      jsonMode: true,
      timeoutMs: 1_000,
      managedServiceRootRedirect: null,
    });
    try {
      if (refused) {
        const failure = await admission.catch((error: unknown) => error);
        expect(failure).toMatchObject({
          reason: "gateway-stop-unverified",
          message: expect.stringContaining(
            platform === "linux"
              ? "systemd user/system unit"
              : platform === "darwin"
                ? "launchd"
                : "Task Scheduler",
          ),
          failureFacts: [
            expect.objectContaining({ code: "gateway-stop-unverified" }),
            expect.objectContaining({ code: reason }),
          ],
        });
      } else {
        await admission;
      }
      expect(native.stop).not.toHaveBeenCalled();
    } finally {
      live?.release();
    }
  },
);

describe("package update entry point", () => {
  const { fixture } = installFreshUpdateFixture();
  it.each([
    ["win32", false],
    ["linux", false],
    ["linux", true],
  ] as const)(
    "refuses %s package replacement before backup with an uninspectable live Gateway (malformed preview=%s)",
    async (platform, malformedPreview) => {
      vi.mocked(databaseContext.inspectUpdateDatabaseContexts).mockRestore();
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(process.env.HOME!, ".openclaw"));
      vi.stubEnv(
        "OPENCLAW_CONFIG_PATH",
        path.join(process.env.OPENCLAW_STATE_DIR!, "openclaw.json"),
      );
      openOpenClawStateDatabase();
      if (malformedPreview) {
        fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, "{");
        for (const [key, name] of [
          ["TMPDIR", "tmp"],
          ["XDG_CACHE_HOME", "cache"],
        ] as const) {
          const directory = path.join(process.env.HOME!, name);
          fs.mkdirSync(directory, { recursive: true });
          vi.stubEnv(key, directory);
        }
      }
      const candidate = path.join(process.env.HOME!, "candidate");
      await writePackageRoot(candidate, "2026.9.2");
      vi.mocked(packageUpdate.stagePackageInstallUpdate).mockResolvedValue(createStage(candidate));
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
      const snapshot = () =>
        listDirectoryTreeStrictSync(process.env.HOME!).map(({ relativePath }) => relativePath);
      const before = snapshot();
      const databaseBefore = fs.readFileSync(resolveOpenClawStateSqlitePath());
      try {
        const update = updateCommand({ json: true, yes: true, dryRun: malformedPreview });
        if (malformedPreview) {
          const failure = await update.catch((error: unknown) => error);
          expect(failure).toBeInstanceOf(Error);
          expect(
            failure instanceof ExitError
              ? failure.code
              : failure instanceof UpdateCommandFailure
                ? failure.exitCode
                : undefined,
          ).toBe(1);
          expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
            expect.objectContaining({
              status: "error",
              reason: "gateway-stop-unverified",
              failedStep: expect.objectContaining({
                failureFacts: expect.arrayContaining([
                  expect.objectContaining({ code: "gateway-stop-unverified" }),
                ]),
              }),
            }),
          );
          expect(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf8")).toBe("{");
          expect(fs.readFileSync(resolveOpenClawStateSqlitePath())).toEqual(databaseBefore);
          expect(snapshot()).toEqual(before);
        } else {
          await expect(update).rejects.toBeInstanceOf(ExitError);
          expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
            expect.objectContaining({ status: "error", reason: "gateway-stop-unverified" }),
          );
        }
        expect(backup).not.toHaveBeenCalled();
        expect(native.stop).not.toHaveBeenCalled();
        expect(await readPackageVersion(fixture.root)).toBe("2026.9.3");
      } finally {
        live.release();
      }
    },
  );
});
