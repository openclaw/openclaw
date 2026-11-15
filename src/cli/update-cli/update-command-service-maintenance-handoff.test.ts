import "./update-command-service-maintenance.test-support.js";
import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as schtasksExec from "../../daemon/schtasks-exec.js";
import { ServiceInspectionError } from "../../daemon/service-inspection-error.js";
import * as serviceMembership from "../../daemon/service-process-membership.js";
import type { GatewayService } from "../../daemon/service.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import * as processAncestry from "../../infra/restart-stale-pids.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import {
  maintenanceDefaults,
  gatewayCommand,
  commandResult,
  writeHandoffMeta,
} from "./update-command-service-fixtures.test-support.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));

const {
  mocks,
  withServiceHome,
  mockMaintenanceService,
  expectNoServiceCalls: expectNoCalls,
} = await import("./update-command-service-maintenance.test-support.js");
const nativeHost = process.platform === "linux" || process.platform === "darwin";
const blockedTree = (pid: number) =>
  `This command is running inside the gateway process tree (gateway PID ${pid}).\nStopping or restarting the gateway from here would kill this command, so it cannot safely manage the gateway that owns it.\nRun this command from a shell outside the gateway service.`;

function mockHandoffServicePlatform(platform: NodeJS.Platform) {
  const hostPlatform = process.platform;
  const existingUri = nodeSqlite.resolveExistingSqliteFileUri;
  // The real lease and ledger keep the host SQLite VFS while service facts are simulated.
  vi.spyOn(nodeSqlite, "resolveExistingSqliteFileUri").mockImplementation((pathname) =>
    existingUri(pathname, hostPlatform),
  );
  mockProcessPlatform(platform);
  return vi.mocked(processAncestry.inspectSelfAndAncestorPidsSync);
}

function handoffService(home: string, overrides: Partial<GatewayService> = {}, pid = process.ppid) {
  return mockMaintenanceService(home, {
    readCommand: async () => ({
      ...gatewayCommand(home),
      ...(process.platform === "win32" ? { sourcePath: mocks.taskScriptPath } : {}),
    }),
    readRuntime: async () => ({
      status: "running",
      pid,
      systemd: { managerUid: 2001, controlGroup: "/system.slice/openclaw-gateway.service" },
    }),
    ...overrides,
  });
}

function replaceExecutorIdentity(home: string, root: string, identity: string) {
  using db = nodeSqlite.openNodeSqliteDatabase(path.join(home, "managed-update-handoffs.sqlite"));
  db.prepare(
    "UPDATE managed_update_handoffs SET payload_json = json_set(payload_json, '$.executor.startIdentity', ?) WHERE install_root = ?",
  ).run(identity, root);
}

const servingAncestorMaintenanceCases = [
  ...(["linux", "darwin", "win32"] as const).flatMap((platform) =>
    [
      { platform, identity: "current updater", phase: "inspect" as const },
      { platform, identity: "current updater", phase: "prepare" as const },
      { platform, identity: "replaced at stop", phase: "prepare" as const, splitRoot: false },
    ].concat(
      ([undefined, "inherited environment", "unavailable ancestry"] as const).map(
        (ancestry) =>
          ({ platform, identity: "missing marker", phase: "prepare", ancestry }) as const,
      ),
    ),
  ),
  ...(["linux", "darwin"] as const).flatMap((platform) =>
    (["inside", "unknown"] as const).map(
      (membership) =>
        ({ platform, identity: "missing marker", phase: "prepare", membership }) as const,
    ),
  ),
  { platform: "linux", identity: "missing metadata", phase: "prepare" },
  { platform: "linux", identity: "missing lease", phase: "prepare" },
  { platform: "linux", identity: "replaced owner", phase: "prepare" },
  { platform: "linux", identity: "different root", phase: "prepare" },
  { platform: "linux", identity: "different run", phase: "prepare" },
  { platform: "linux", identity: "stale start identity", phase: "prepare" },
  { platform: "linux", identity: "parent lease", phase: "prepare" },
  { platform: "linux", identity: "missing run", phase: "inspect" },
  { platform: "linux", identity: "different run", phase: "inspect" },
  { platform: "linux", identity: "missing lease", phase: "inspect" },
  { platform: "linux", identity: "current updater", phase: "prepare", splitRoot: false },
] as const;
const caseDefaults: {
  ancestry?: string;
  membership?: "inside" | "unknown";
  splitRoot: boolean;
} = { splitRoot: true };

it.runIf(nativeHost).each(
  servingAncestorMaintenanceCases
    .map((scenario) => Object.assign({}, caseDefaults, scenario))
    .filter(
      // Binding a foreign PID needs the host's actual Linux process identity.
      ({ identity }) => identity !== "parent lease" || process.platform === "linux",
    ),
)(
  "keeps $platform serving-ancestor maintenance bound to the current updater: $identity $phase $ancestry split=$splitRoot",
  (scenario) =>
    withServiceHome(async (home) => {
      vi.spyOn(schtasksExec, "execSchtasks").mockResolvedValue(
        commandResult("<Task><Settings><Enabled>false</Enabled></Settings></Task>"),
      );
      try {
        const { platform, identity, phase, splitRoot } = scenario;
        const replacedAtStop = identity === "replaced at stop";
        const authorized = identity === "current updater";
        const unresolved = scenario.ancestry === "unavailable ancestry";
        const external =
          scenario.ancestry === "inherited environment" || (platform === "darwin" && unresolved);
        const inherited = external || unresolved;
        const reparented = scenario.membership !== undefined;
        const gatewayPid = external || reparented ? 2 : process.ppid;
        const root = await fs.realpath(process.cwd());
        const packageRoot = splitRoot ? path.join(home, "package-B") : root;
        if (splitRoot) {
          await fs.mkdir(packageRoot);
        }
        const runId = randomUUID();
        createUpdateRun({ runId, trigger: "cli" }, { env: process.env });
        const metaPath = await writeHandoffMeta(
          home,
          identity === "different root" ? home : packageRoot,
          identity === "different run" ? randomUUID() : runId,
          "owned-handoff",
        );
        if (identity !== "missing lease") {
          const store = createManagedHandoffLeaseStore();
          const claim = store.acquire(
            packageRoot,
            identity === "replaced owner" ? "replacement-handoff" : "owned-handoff",
            { kind: "update" },
          );
          if (claim.kind !== "acquired") {
            throw new Error("fixture could not acquire its installation lease");
          }
          if (identity === "parent lease") {
            expect(store.bind(claim.lease, process.ppid)).not.toBeNull();
          } else if (identity === "stale start identity") {
            replaceExecutorIdentity(home, packageRoot, "stale");
          }
        }
        const ancestryInspection = mockHandoffServicePlatform(platform);
        vi.mocked(serviceMembership.inspectServiceProcessMembershipSync).mockReturnValue(
          scenario.membership ?? "outside",
        );
        if (reparented && platform === "linux") {
          const nativeMembership = await vi.importActual<typeof serviceMembership>(
            "../../daemon/service-process-membership.js",
          );
          vi.spyOn(serviceMembership, "inspectServiceProcessMembershipSync").mockImplementation(
            nativeMembership.inspectServiceProcessMembershipSync,
          );
          const readFile = fsSync.readFileSync;
          vi.spyOn(fsSync, "readFileSync").mockImplementation((file, options) => {
            if (file === `/proc/${process.pid}/cgroup` || file === `/proc/${gatewayPid}/cgroup`) {
              if (scenario.membership === "unknown") {
                throw new Error("Fixture procfs inspection denied");
              }
              return `0::/system.slice/openclaw-gateway.service/${file === `/proc/${gatewayPid}/cgroup` ? "worker.service" : "caller"}`;
            }
            return readFile(file, options);
          });
        }
        if (unresolved) {
          ancestryInspection.mockReturnValue({ pids: new Set([process.pid]), complete: false });
        }
        await withEnvAsync(
          {
            OPENCLAW_UPDATE_RUN_HANDOFF: identity === "missing marker" ? undefined : "1",
            [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]:
              identity === "missing metadata" ? undefined : metaPath,
            ...(!replacedAtStop && {
              OPENCLAW_UPDATE_RUN_ID:
                identity === "missing run" ? undefined : phase === "inspect" ? runId : randomUUID(),
              OPENCLAW_SERVICE_MARKER: inherited ? "openclaw" : undefined,
              OPENCLAW_SERVICE_KIND: inherited ? "gateway" : undefined,
              OPENCLAW_GATEWAY_SERVICE_PID: inherited ? String(gatewayPid) : undefined,
            }),
          },
          async () => {
            let runtimeReads = 0;
            const service = handoffService(home, {}, gatewayPid);
            if (replacedAtStop) {
              service.readRuntime = async () => {
                if (++runtimeReads === 2) {
                  replaceExecutorIdentity(home, root, "replaced");
                }
                return { status: "running", pid: process.ppid, systemd: { managerUid: 2001 } };
              };
            }
            const updateRun = phase === "inspect" ? undefined : { runId, env: process.env };
            const { recordPhase } = createUpdateCommandExecutionGuards(
              { run: updateRun },
              packageRoot,
            );
            const attempt = maybeStopManagedServiceBeforeMutableUpdate({
              ...maintenanceDefaults,
              root,
              handoffRoot: splitRoot ? packageRoot : undefined,
              phase,
              updateRun,
              recordPhase,
              ...(replacedAtStop ? {} : { handoffFromGateway: async () => false }),
            });
            if (replacedAtStop) {
              await expect(attempt).rejects.toThrow(blockedTree(process.ppid));
              expect(runtimeReads).toBe(2);
              expect(service.stop).not.toHaveBeenCalled();
              return;
            }
            const inspected = await attempt;
            expect(inspected.serviceUpdateVerdict?.kind).toBe("owned");
            if (authorized || external) {
              expect(inspected.blockMessage).toBeUndefined();
            } else {
              expect(inspected.blockFailureFacts).toEqual([
                expect.objectContaining({
                  check: "managed-service-preflight",
                  code: reparented
                    ? scenario.membership === "inside"
                      ? "inside-gateway-service"
                      : "service-membership-unverified"
                    : unresolved
                      ? "service-ancestry-unverified"
                      : "inside-gateway-process-tree",
                }),
              ]);
              expect(inspected.blockMessage).toEqual(
                reparented
                  ? expect.stringContaining("service")
                  : unresolved
                    ? expect.stringContaining("Process ancestry could not be fully inspected")
                    : blockedTree(gatewayPid),
              );
            }
            expect(service.stop).toHaveBeenCalledTimes(
              (authorized || external) && phase === "prepare" ? 1 : 0,
            );
            if ((authorized || external) && phase === "prepare") {
              expect(service.stop).toHaveBeenCalledWith(
                expect.objectContaining({ updateHandoff: { root: packageRoot, runId } }),
              );
            }
            expectNoCalls(service.start, service.restart, service.stage, service.install);
          },
        );
      } finally {
        await closeStateDatabaseForTest();
      }
    }),
);

it.runIf(nativeHost)("records a native membership refusal discovered at the stop boundary", () =>
  withServiceHome(async (home) => {
    mockHandoffServicePlatform("darwin");
    const service = handoffService(home, {
      readRuntime: async () => ({ status: "running", pid: 2 }),
      stop: async () => {
        throw new ServiceInspectionError("service-membership-unverified");
      },
    });
    await expect(
      maybeStopManagedServiceBeforeMutableUpdate({ ...maintenanceDefaults, phase: "prepare" }),
    ).rejects.toMatchObject({
      reason: "managed-service-preflight",
      failureFacts: [expect.objectContaining({ code: "service-membership-unverified" })],
    });
    expectNoCalls(service.start, service.restart);
  }),
);

it.runIf(nativeHost).each(["inspect", "prepare"] as const)(
  "refuses an active systemd unit with no MainPID during %s",
  (phase) =>
    withServiceHome(async (home) => {
      mockHandoffServicePlatform("linux");
      const service = handoffService(home, {
        readRuntime: async () => ({
          status: "running",
          state: "active",
          subState: "exited",
          systemd: {
            managerUid: 2001,
            tasksCurrent: 1,
            controlGroup: "/system.slice/openclaw-gateway.service",
          },
        }),
      });
      const outcome = await maybeStopManagedServiceBeforeMutableUpdate({
        ...maintenanceDefaults,
        phase,
        handoffFromGateway: async () => false,
      });
      expect(outcome.blockFailureFacts).toEqual([
        expect.objectContaining({ code: "service-membership-unverified" }),
      ]);
      expectNoCalls(service.stop, service.start, service.restart);
    }),
);
