import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as notes from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as gatewayService from "../daemon/service.js";
import { createMockGatewayService, mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import { tryAcquireExclusiveSqliteCoordinator } from "../infra/sqlite-coordinator.js";
import {
  acquireGatewayLifecycleCoordinator,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "../infra/state-database-coordinator.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import * as installHelpers from "./daemon-install-helpers.js";
import { maybeRepairGatewayDaemon } from "./doctor-gateway-daemon-flow.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import { shouldManageGatewayService } from "./doctor-service-repair-policy.js";
import * as installToken from "./gateway-install-token.js";

const mocks = vi.hoisted(() => ({
  discover:
    vi.fn<
      typeof import("../../scripts/lib/freebsd-service-discovery.mjs").discoverFreeBsdService
    >(),
  port: vi.fn(async () => "free" as const),
}));
vi.mock("../../scripts/lib/freebsd-service-discovery.mjs", () => ({
  discoverFreeBsdService: mocks.discover,
}));
vi.mock("../infra/container-environment.js", () => ({ isContainerEnvironment: () => false }));
vi.mock("../infra/ports-probe.js", () => ({ probePortUsage: mocks.port }));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function withFreeBsdDoctorFixture(
  status: "absent" | "present" | "unknown",
  operation: (home: string) => Promise<void>,
) {
  const home = dirs.make("doctor-freebsd-maintenance-");
  mockSystemAccountHome();
  mockProcessPlatform("freebsd");
  mocks.port.mockClear();
  mocks.discover.mockReset().mockResolvedValue(
    status === "unknown"
      ? { schema: 1, service: "openclaw", status, reason: "native-configuration-failed" }
      : {
          schema: 1,
          service: "openclaw",
          status,
          context: {
            cwd: "/",
            env: { HOME: "/", PATH: "/sbin:/bin:/usr/sbin:/usr/bin", LC_ALL: "C" },
          },
          directories: ["/usr/local/etc/rc.d"],
          definitions:
            status === "present"
              ? [{ path: "/usr/local/etc/rc.d/openclaw", executable: false }]
              : [],
          selected: null,
        },
  );
  await withStateDatabaseCoordinatorRuntimeDirectory(home, () =>
    withEnvAsync(
      {
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, "AppData"),
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: undefined,
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        OPENCLAW_SERVICE_REPAIR_POLICY: undefined,
        OPENCLAW_SERVICE_MARKER: undefined,
        OPENCLAW_SERVICE_KIND: undefined,
        OPENCLAW_UPDATE_RUN_ID: undefined,
        OPENCLAW_UPDATE_IN_PROGRESS: undefined,
        KUBERNETES_SERVICE_HOST: undefined,
        KUBERNETES_SERVICE_PORT: undefined,
      },
      () => operation(home),
    ),
  );
}

it.each(["absent", "present", "unknown"] as const)(
  "keeps real Doctor maintenance admission for FreeBSD %s",
  async (status) => {
    await withFreeBsdDoctorFixture(status, async (home) => {
      await expect(shouldManageGatewayService()).resolves.toBe(true);
      const service = gatewayService.resolveGatewayService();
      const mutations = ["stage", "install", "uninstall", "start", "stop", "restart"] as const;
      const mutationSpies = mutations.map((method) => vi.spyOn(service, method));
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const enter = () =>
        beginDoctorMaintenance({
          root: home,
          options: { repair: true },
          runtime,
        });
      const coordinator = acquireGatewayLifecycleCoordinator({
        databasePath: resolveOpenClawStateSqlitePath(process.env),
        busyTimeoutMs: 0,
      });
      coordinator.release();
      const other = tryAcquireExclusiveSqliteCoordinator(coordinator.path);
      expect(other).not.toBeNull();
      try {
        await expect(enter()).rejects.toThrow("Doctor could not enter maintenance");
      } finally {
        other?.release();
      }
      const maintenance = await enter();
      try {
        expect(maintenance).toBeDefined();
        expect(tryAcquireExclusiveSqliteCoordinator(coordinator.path)).toBeNull();
        expect(maintenance!.run(() => "under custody")).toBe("under custody");
        expect(mocks.discover).toHaveBeenCalled();
        if (status === "absent") {
          expect(maintenance!.warnings).toEqual([]);
          expect(runtime.log).not.toHaveBeenCalled();
          expect(mocks.port).toHaveBeenCalled();
        } else {
          expect(maintenance!.warnings).toEqual([
            expect.stringContaining(
              "On FreeBSD, use the Gateway's rc.d or foreground process owner for service management.",
            ),
          ]);
          expect(runtime.log).toHaveBeenCalledWith(maintenance!.warnings![0]);
          expect(mocks.port).not.toHaveBeenCalled();
        }
        for (const mutation of mutationSpies) {
          expect(mutation).not.toHaveBeenCalled();
        }
      } finally {
        await maintenance?.release();
      }
      const released = tryAcquireExclusiveSqliteCoordinator(coordinator.path);
      try {
        expect(released).not.toBeNull();
      } finally {
        released?.release();
      }
    });
  },
);

it.each([
  { options: {}, unknown: false },
  { options: { yes: true }, unknown: false },
  { options: { repair: true }, unknown: false },
  { options: { repair: true }, unknown: true },
])(
  "diagnoses unsupported FreeBSD repair without side effects (%j)",
  async ({ options, unknown }) => {
    await withFreeBsdDoctorFixture("absent", async () => {
      const service = createMockGatewayService({
        managementUnsupportedReason:
          "Gateway service management is not supported by this CLI on FreeBSD. Run `openclaw gateway run` as your onboarding account.",
      });
      if (unknown) {
        vi.mocked(service.isLoaded).mockRejectedValue(new Error("native rc inspection is unknown"));
      }
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
      const note = vi.spyOn(notes, "note").mockImplementation(() => {});
      const token = vi.spyOn(installToken, "resolveGatewayInstallToken");
      const plan = vi.spyOn(installHelpers, "buildGatewayInstallPlan");
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const prompter = createDoctorPrompter({ runtime, options });
      vi.spyOn(prompter, "confirmRuntimeRepair").mockResolvedValue(true);
      await maybeRepairGatewayDaemon({
        cfg: { gateway: {} },
        runtime,
        prompter,
        options,
        gatewayDetailsMessage: "details",
        healthOk: false,
      });
      expect(service.isLoaded).toHaveBeenCalledOnce();
      if (unknown) {
        expect(note.mock.calls.flat().join("\n")).toContain("native rc inspection is unknown");
        expect(note).not.toHaveBeenCalledWith(service.managementUnsupportedReason, "Gateway");
      } else {
        expect(note).toHaveBeenCalledWith(service.managementUnsupportedReason, "Gateway");
      }
      expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
      expect(token).not.toHaveBeenCalled();
      expect(plan).not.toHaveBeenCalled();
      expect(service.install).not.toHaveBeenCalled();
      expect(service.restart).not.toHaveBeenCalled();
    });
  },
);
