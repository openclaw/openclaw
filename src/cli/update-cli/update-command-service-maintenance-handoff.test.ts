// Install the native service fixtures before loading the maintenance owner.
import "./update-command-service-maintenance.test-support.js";
import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as schtasksExec from "../../daemon/schtasks-exec.js";
import { ServiceInspectionError } from "../../daemon/service-inspection-error.js";
import * as serviceMembership from "../../daemon/service-process-membership.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import * as processAncestry from "../../infra/restart-stale-pids.js";
import * as openClawTmp from "../../infra/tmp-openclaw-dir.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));

const { mocks, withServiceHome } =
  await import("./update-command-service-maintenance.test-support.js");

function mockHandoffServicePlatform(platform: NodeJS.Platform) {
  const hostPlatform = process.platform;
  const existingUri = nodeSqlite.resolveExistingSqliteFileUri;
  // The real lease and ledger keep the host SQLite VFS while service facts are simulated.
  vi.spyOn(nodeSqlite, "resolveExistingSqliteFileUri").mockImplementation((pathname) =>
    existingUri(pathname, hostPlatform),
  );
  mockProcessPlatform(platform);
  return vi.spyOn(processAncestry, "inspectSelfAndAncestorPidsSync").mockReturnValue({
    pids: new Set([process.pid, process.ppid, 1]),
    complete: true,
  });
}

const servingAncestorMaintenanceCases = [
  ...(["linux", "darwin", "win32"] as const).flatMap((platform) =>
    (["inspect", "prepare"] as const).flatMap((phase) =>
      (["ancestor", "inherited environment"] as const).flatMap((ancestry) =>
        (["current updater", "missing marker"] as const).map((identity) => ({
          platform,
          identity,
          phase,
          ancestry,
          authorized: identity === "current updater",
        })),
      ),
    ),
  ),
  ...(["linux", "darwin", "win32"] as const).map(
    (platform) =>
      ({
        platform,
        identity: "missing marker",
        phase: "prepare",
        ancestry: "unavailable ancestry",
        authorized: false,
      }) as const,
  ),
  ...(["linux", "darwin"] as const).flatMap((platform) =>
    (["inside", "unknown"] as const).map(
      (membership) =>
        ({
          platform,
          identity: "missing marker",
          phase: "prepare",
          ancestry: "reparented",
          authorized: false,
          membership,
        }) as const,
    ),
  ),
  { platform: "linux", identity: "missing metadata", phase: "prepare", authorized: false },
  { platform: "linux", identity: "missing lease", phase: "prepare", authorized: false },
  { platform: "linux", identity: "replaced owner", phase: "prepare", authorized: false },
  { platform: "linux", identity: "different root", phase: "prepare", authorized: false },
  { platform: "linux", identity: "different run", phase: "prepare", authorized: false },
  { platform: "linux", identity: "stale start identity", phase: "prepare", authorized: false },
  { platform: "linux", identity: "parent lease", phase: "prepare", authorized: false },
] as const;

it.runIf(process.platform === "linux" || process.platform === "darwin").each(
  servingAncestorMaintenanceCases
    .flatMap((scenario) => [
      { ...scenario, splitRoot: false },
      { ...scenario, splitRoot: true },
    ])
    .filter(
      // Binding a foreign PID reads native process identity, so only exercise that
      // fixture where the simulated Linux policy matches the actual host.
      ({ identity }) => identity !== "parent lease" || process.platform === "linux",
    ),
)(
  "keeps $platform serving-ancestor maintenance bound to the current updater: $identity $phase $ancestry split=$splitRoot",
  (scenario) =>
    withServiceHome(async (home) => {
      const { platform, identity, phase, authorized, splitRoot } = scenario;
      const external = "ancestry" in scenario && scenario.ancestry === "inherited environment";
      const unresolved = "ancestry" in scenario && scenario.ancestry === "unavailable ancestry";
      const inherited = external || unresolved;
      const reparented = "membership" in scenario;
      const gatewayPid = external || reparented ? 2 : process.ppid;
      vi.spyOn(schtasksExec, "execSchtasks").mockResolvedValue({
        code: 0,
        stdout: "<Task><Settings><Enabled>false</Enabled></Settings></Task>",
        stderr: "",
      });
      const root = await fs.realpath(process.cwd());
      const packageRoot = splitRoot ? path.join(home, "package-B") : root;
      if (splitRoot) {
        await fs.mkdir(packageRoot);
      }
      const metaPath = path.join(home, "handoff-meta.json");
      const runId = randomUUID();
      vi.spyOn(openClawTmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(home);
      createUpdateRun({ runId, trigger: "cli" }, { env: process.env });
      await fs.writeFile(
        metaPath,
        JSON.stringify({
          version: 1,
          meta: {
            root: identity === "different root" ? home : packageRoot,
            runId: identity === "different run" ? randomUUID() : runId,
            handoffId: "owned-handoff",
          },
        }),
      );
      const store = createManagedHandoffLeaseStore();
      if (identity !== "missing lease") {
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
          const db = nodeSqlite.openNodeSqliteDatabase(
            path.join(home, "managed-update-handoffs.sqlite"),
          );
          try {
            db.prepare(
              "UPDATE managed_update_handoffs SET payload_json = json_set(payload_json, '$.executor.startIdentity', 'stale') WHERE install_root = ?",
            ).run(packageRoot);
          } finally {
            db.close();
          }
        }
      }
      // Create the real lease on the host filesystem before simulating its service manager.
      const ancestryInspection = mockHandoffServicePlatform(platform);
      vi.spyOn(serviceMembership, "inspectServiceProcessMembershipSync").mockReturnValue(
        reparented ? scenario.membership : "outside",
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
          OPENCLAW_SERVICE_MARKER: inherited ? "openclaw" : undefined,
          OPENCLAW_SERVICE_KIND: inherited ? "gateway" : undefined,
          OPENCLAW_GATEWAY_SERVICE_PID: inherited ? String(gatewayPid) : undefined,
        },
        async () => {
          const service = createMockGatewayService({
            readCommand: async () => ({
              programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
              ...(platform === "win32" ? { sourcePath: mocks.taskScriptPath } : {}),
              environment: { HOME: home },
            }),
            readRuntime: async () => ({
              status: "running",
              pid: gatewayPid,
              systemd: { managerUid: 2001, controlGroup: "/system.slice/openclaw-gateway.service" },
            }),
            isLoaded: async () => true,
          });
          mocks.service.mockReturnValue(service);
          const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
            root,
            handoffRoot: splitRoot ? packageRoot : undefined,
            updateInstallKind: "package",
            shouldRestart: true,
            jsonMode: true,
            phase,
            updateRun: { runId, env: process.env },
            handoffFromGateway: async () => false,
          });
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
            if (reparented) {
              expect(inspected.blockMessage).toContain("service");
            } else if (unresolved) {
              expect(inspected.blockMessage).toContain(
                "Process ancestry could not be fully inspected",
              );
            } else {
              expect(inspected.blockMessage).toBe(
                `This command is running inside the gateway process tree (gateway PID ${gatewayPid}).\nStopping or restarting the gateway from here would kill this command, so it cannot safely manage the gateway that owns it.\nRun this command from a shell outside the gateway service.`,
              );
            }
          }
          expect(service.stop).toHaveBeenCalledTimes(
            (authorized || external) && phase === "prepare" ? 1 : 0,
          );
          if ((authorized || external) && phase === "prepare") {
            expect(service.stop).toHaveBeenCalledWith(
              expect.objectContaining({
                updateHandoff: { root: packageRoot, runId },
              }),
            );
          }
          expect(service.start).not.toHaveBeenCalled();
          expect(service.restart).not.toHaveBeenCalled();
          expect(service.stage).not.toHaveBeenCalled();
          expect(service.install).not.toHaveBeenCalled();
        },
      );
    }),
);

it
  .runIf(process.platform === "linux" || process.platform === "darwin")
  .each(["linux", "darwin", "win32"] as const)(
  "rechecks the managed handoff identity immediately before stopping the %s Gateway",
  (platform) =>
    withServiceHome(async (home) => {
      vi.spyOn(schtasksExec, "execSchtasks").mockResolvedValue({
        code: 0,
        stdout: "<Task><Settings><Enabled>false</Enabled></Settings></Task>",
        stderr: "",
      });
      const root = await fs.realpath(process.cwd());
      const metaPath = path.join(home, "handoff-meta.json");
      const runId = randomUUID();
      createUpdateRun({ runId, trigger: "cli" }, { env: process.env });
      await fs.writeFile(
        metaPath,
        JSON.stringify({
          version: 1,
          meta: { root, runId, handoffId: "owned-handoff" },
        }),
      );
      const store = createManagedHandoffLeaseStore();
      const claim = store.acquire(root, "owned-handoff", { kind: "update" });
      if (claim.kind !== "acquired") {
        throw new Error("fixture could not acquire its installation lease");
      }
      mockHandoffServicePlatform(platform);
      let runtimeReads = 0;
      const stop = vi.fn(async () => undefined);
      mocks.service.mockReturnValue(
        createMockGatewayService({
          readCommand: async () => ({
            programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
            ...(platform === "win32" ? { sourcePath: mocks.taskScriptPath } : {}),
            environment: { HOME: home },
          }),
          readRuntime: async () => {
            runtimeReads += 1;
            if (runtimeReads === 2) {
              const db = nodeSqlite.openNodeSqliteDatabase(
                path.join(home, "managed-update-handoffs.sqlite"),
              );
              try {
                db.prepare(
                  "UPDATE managed_update_handoffs SET payload_json = json_set(payload_json, '$.executor.startIdentity', 'replaced') WHERE install_root = ?",
                ).run(root);
              } finally {
                db.close();
              }
            }
            return {
              status: "running",
              pid: process.ppid,
              systemd: { managerUid: 2001 },
            };
          },
          isLoaded: async () => true,
          stop,
        }),
      );
      await withEnvAsync(
        {
          OPENCLAW_UPDATE_RUN_HANDOFF: "1",
          [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
        },
        async () => {
          await expect(
            maybeStopManagedServiceBeforeMutableUpdate({
              root,
              updateInstallKind: "package",
              shouldRestart: true,
              jsonMode: true,
              phase: "prepare",
              updateRun: { runId, env: process.env },
            }).then(() => undefined),
          ).rejects.toThrow(
            `This command is running inside the gateway process tree (gateway PID ${process.ppid}).\nStopping or restarting the gateway from here would kill this command, so it cannot safely manage the gateway that owns it.\nRun this command from a shell outside the gateway service.`,
          );
        },
      );
      expect(runtimeReads).toBe(2);
      expect(stop).not.toHaveBeenCalled();
    }),
);

it.runIf(process.platform === "linux" || process.platform === "darwin")(
  "records a native membership refusal discovered at the stop boundary",
  () =>
    withServiceHome(async (home) => {
      const root = process.cwd();
      mockHandoffServicePlatform("darwin");
      const service = createMockGatewayService({
        readCommand: async () => ({
          programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
          environment: { HOME: home },
        }),
        readRuntime: async () => ({ status: "running", pid: 2 }),
        isLoaded: async () => true,
        stop: async () => {
          throw new ServiceInspectionError("service-membership-unverified");
        },
      });
      mocks.service.mockReturnValue(service);
      await expect(
        maybeStopManagedServiceBeforeMutableUpdate({
          root,
          updateInstallKind: "package",
          shouldRestart: true,
          jsonMode: true,
          phase: "prepare",
        }),
      ).rejects.toMatchObject({
        reason: "managed-service-preflight",
        failureFacts: [expect.objectContaining({ code: "service-membership-unverified" })],
      });
      expect(service.start).not.toHaveBeenCalled();
      expect(service.restart).not.toHaveBeenCalled();
    }),
);

it
  .runIf(process.platform === "linux" || process.platform === "darwin")
  .each(["inspect", "prepare"] as const)(
  "refuses an active systemd unit with no MainPID during %s",
  (phase) =>
    withServiceHome(async (home) => {
      const root = process.cwd();
      mockHandoffServicePlatform("linux");
      const service = createMockGatewayService({
        readCommand: async () => ({
          programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
          environment: { HOME: home },
        }),
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
        isLoaded: async () => true,
      });
      mocks.service.mockReturnValue(service);
      const outcome = await maybeStopManagedServiceBeforeMutableUpdate({
        root,
        updateInstallKind: "package",
        shouldRestart: true,
        jsonMode: true,
        phase,
        handoffFromGateway: async () => false,
      });
      expect(outcome.blockFailureFacts).toEqual([
        expect.objectContaining({ code: "service-membership-unverified" }),
      ]);
      expect(service.stop).not.toHaveBeenCalled();
      expect(service.start).not.toHaveBeenCalled();
      expect(service.restart).not.toHaveBeenCalled();
    }),
);
