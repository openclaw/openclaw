// Install the native service fixtures before loading the maintenance owner.
import "./update-command-service-maintenance.test-support.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as schtasksExec from "../../daemon/schtasks-exec.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import * as openClawTmp from "../../infra/tmp-openclaw-dir.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

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
      const inherited = "ancestry" in scenario && scenario.ancestry === "inherited environment";
      const gatewayPid = inherited ? 2 : process.ppid;
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
      mockHandoffServicePlatform(platform);
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
              environment: { HOME: home },
            }),
            readRuntime: async () => ({
              status: "running",
              pid: gatewayPid,
              systemd: { managerUid: 2001 },
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
          if (authorized) {
            expect(inspected.blockMessage).toBeUndefined();
          } else {
            expect(inspected.blockMessage).toBe(
              `This command is running inside the gateway process tree (gateway PID ${gatewayPid}).\nStopping or restarting the gateway from here would kill this command, so it cannot safely manage the gateway that owns it.\nRun this command from a shell outside the gateway service.`,
            );
          }
          expect(service.stop).toHaveBeenCalledTimes(authorized && phase === "prepare" ? 1 : 0);
          if (authorized && phase === "prepare") {
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
