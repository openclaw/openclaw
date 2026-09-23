import { createHash } from "node:crypto";
import fs from "node:fs";
import { expect, vi } from "vitest";
import * as restartHealthProbe from "../cli/daemon-cli/restart-health-probe.js";
import type { SystemdServiceReadBinding } from "../daemon/service-types.js";
import * as packageJson from "../infra/package-json.js";
import * as updateGitRuntime from "../infra/update-git-runtime.js";

export function stoppedSystemdBinding(onPassiveRead: () => void): SystemdServiceReadBinding {
  const unit = "openclaw-gateway.service";
  const unitPath = "/org/freedesktop/systemd1/unit/openclaw_2dgateway_2eservice";
  const properties: Record<string, unknown> = {
    Id: unit,
    LoadState: "loaded",
    ActiveState: "inactive",
    SubState: "dead",
    StartLimitBurst: 5,
    ActiveEnterTimestampMonotonic: 100,
    InactiveEnterTimestampMonotonic: 200,
    Result: "success",
    NRestarts: 0,
    MainPID: 0,
    ExecMainStatus: 0,
    ExecMainCode: 1,
    KillMode: "control-group",
    TasksCurrent: Number("18446744073709551615"),
    MemoryCurrent: 0,
  };
  return {
    unit,
    managerUid: 2001,
    destination: ":1.42",
    verify() {},
    async close() {},
    async query(args, _signatures, _deadline, inspection) {
      if (args[0] === "call") {
        if (args[4] === "LoadUnit" || args[4] === "GetUnit") {
          return [[unitPath]];
        }
        if (args[4] === "GetProcesses") {
          return [[[]]];
        }
      } else if (args[0] === "get-property") {
        const assertRead = inspection?.assertReadCurrent ?? inspection?.assertCurrent;
        // The native peer checks custody around each individual property read.
        return args.slice(4).map((name) => {
          assertRead?.();
          onPassiveRead();
          if (!Object.hasOwn(properties, name)) {
            throw new Error(`Unexpected systemd property: ${name}`);
          }
          assertRead?.();
          return properties[name];
        });
      }
      throw new Error(`Unexpected systemd query: ${args.join(" ")}`);
    },
  };
}

export function captureDoctorSqliteArtifacts(pathname: string) {
  const readArtifacts = () =>
    [pathname, `${pathname}-wal`, `${pathname}-shm`].map((file) =>
      fs.existsSync(file)
        ? createHash("sha256").update(fs.readFileSync(file)).digest("hex")
        : undefined,
    );
  const beforeArtifacts = readArtifacts();
  const beforeCatalog = fs.readFileSync(pathname);
  return {
    assertCatalogUnchanged: () =>
      expect(fs.readFileSync(pathname).equals(beforeCatalog)).toBe(true),
    assertPreStopArtifactsUnchanged: () => expect(readArtifacts()).toEqual(beforeArtifacts),
  };
}

export function mockDoctorGatewayReadiness() {
  // Exercise the real owner-lease reader without depending on a host listener or dist build.
  vi.spyOn(packageJson, "readPackageVersion").mockResolvedValue("2026.9.5");
  vi.spyOn(updateGitRuntime, "readBuiltGatewayBuildId").mockResolvedValue("doctor-fixture-build");
  vi.spyOn(restartHealthProbe, "confirmGatewayReachable").mockResolvedValue({
    reachable: true,
    gatewayVersion: "2026.9.5",
    gatewayBuildId: "doctor-fixture-build",
    activatedPluginErrors: [],
    unavailablePlugins: [],
    channelProbeErrors: [],
  });
}

export type DoctorMaintenanceContinuation =
  | "own"
  | "own-child"
  | "manual"
  | "competing"
  | "foreign"
  | "unknown-adopter"
  | "unrecorded"
  | "unrecorded-parked"
  | "parked"
  | "normal-update-parked"
  | "lost-before-stop"
  | "lost-before-restart"
  | "dead-before-restart"
  | "terminal-dead-before-restart";
