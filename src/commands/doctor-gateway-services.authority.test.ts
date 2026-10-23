import fsNode from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as servicePlan from "../cli/update-cli/update-command-service-plan.js";
import { replaceConfigFile, type OpenClawConfig } from "../config/config.js";
import { isDefaultInstallIdentity } from "../config/paths.js";
import * as gatewayService from "../daemon/service.js";
import {
  buildSystemdManagerPropertyOutput,
  buildSystemdUnitPropertyOutput,
} from "../daemon/service.test-helpers.js";
import { buildSystemdUnit } from "../daemon/systemd-unit.js";
import { seedCompletedRuntimePinMigration } from "../daemon/test-helpers/service-audit-runtime-pin.js";
import type { RuntimeEnv } from "../runtime.js";
import { readSecretStoreValue } from "../secrets/store/secret-store.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { makePrompter } from "./doctor-auth-flat-profiles.test-support.js";
import { mockDoctorServicePlatform } from "./doctor-maintenance.state-owner.test-support.js";

const edges = vi.hoisted(() => ({
  command: vi.fn<typeof import("../process/exec.js").runCommandWithTimeout>(),
  runtimeProbe: vi.fn<typeof import("../process/exec.js").runExec>(),
  note: vi.fn<(message: string, title?: string) => void>(),
}));

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: edges.command,
  runExec: edges.runtimeProbe,
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: edges.note }));

import { installDoctorGatewayService } from "./doctor-gateway-installation.js";
import { maybeRepairGatewayServiceConfig } from "./doctor-gateway-services.js";

const refusals = [
  ["sealed", "sealed", "sealed-mount", "deployment owner", false],
  ["unsafe", "unknown", "unsafe-permissions", "chmod go-w", true],
  ["uninspectable", "unknown", "inspection-failed", "native service-manager availability", false],
  ["rejected", "unknown", "inspection-failed", "native service-manager availability", false],
] as const;
type Scenario = (typeof refusals)[number][0] | "writable" | "repairable";
type CustodyLoss = (typeof custodyCases)[number][0];

// All tokens are synthetic. Assertions report equality booleans, never token bytes.
const embeddedToken = "doctor-fixture-embedded-token";
const existingToken = "doctor-fixture-config-token";
const inspectionCanary = "doctor-fixture-private-inspection-detail";
const untouchedRepair = {
  configBytesPreserved: true,
  returnedConfigPreserved: true,
  unitBytesPreserved: true,
  environmentBytesPreserved: true,
  installedEnvironmentBytesPreserved: true,
  unitDirectoryEntries: ["openclaw-gateway.service"],
  nativeActions: [],
};
const custodyCases = [
  ["before-publication", []],
  ["backup-published", []],
  ["environment-published", []],
  ["definition-published", ["daemon-reload"]],
  ["daemon-reload", ["daemon-reload", "daemon-reload"]],
  ["enable", ["daemon-reload", "enable", "daemon-reload"]],
  ["restart", ["daemon-reload", "enable", "restart", "daemon-reload", "stop"]],
] as const;

describe.skipIf(process.platform === "win32")("Doctor native repair authority ordering", () => {
  let state: OpenClawTestState | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    await state?.cleanup();
    state = undefined;
  });

  async function runRepair(
    scenario: Scenario,
    {
      tokenPresent = false,
      update = false,
      blockedTarget,
      custodyLoss,
    }: {
      tokenPresent?: boolean;
      update?: boolean;
      blockedTarget?: "installed" | "planned";
      custodyLoss?: CustodyLoss;
    } = {},
  ) {
    state = await createOpenClawTestState({ prefix: "doctor-authority-" });
    const { root, home, stateDir, configPath } = state;
    await fs.chmod(stateDir, 0o700);
    const installedStateDir = blockedTarget ? path.join(root, "installed-state") : stateDir;
    const unitPath = path.join(home, ".config/systemd/user/openclaw-gateway.service");
    const environmentPath = path.join(stateDir, "gateway.systemd.env");
    const installedEnvironmentPath = path.join(installedStateDir, "gateway.systemd.env");
    const wrapperPath = path.join(root, "openclaw-fixture");
    const systemUnits = path.join(root, "system-units");
    const runtimeDir = path.join(root, "runtime");
    const busAddress = `unix:path=${runtimeDir}/bus`;
    await fs.mkdir(installedStateDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o755 });
    await fs.mkdir(systemUnits, { mode: 0o755 });
    await fs.writeFile(wrapperPath, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    const cfg: OpenClawConfig = {
      gateway: {
        mode: "local",
        auth: { mode: "token", ...(tokenPresent ? { token: existingToken } : {}) },
      },
      plugins: { enabled: false },
    };
    const originalConfig = `${JSON.stringify(cfg, null, 2)}\n`;
    const programArguments = [wrapperPath, "gateway", "--port", "18789"];
    const environment = {
      HOME: home,
      OPENCLAW_STATE_DIR: installedStateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WRAPPER: wrapperPath,
      OPENCLAW_GATEWAY_TOKEN: embeddedToken,
      PATH: "/usr/local/bin:/usr/bin:/bin",
    };
    const originalUnit = buildSystemdUnit({ programArguments, environment });
    const originalEnvironment = "OPERATOR_FIXTURE=unchanged\n";
    await fs.writeFile(configPath, originalConfig, { mode: 0o600 });
    await fs.writeFile(unitPath, originalUnit, { mode: 0o644 });
    await fs.writeFile(environmentPath, originalEnvironment, { mode: 0o600 });
    if (blockedTarget) {
      await fs.writeFile(installedEnvironmentPath, originalEnvironment, { mode: 0o600 });
    }

    await seedCompletedRuntimePinMigration(state.env);
    if (blockedTarget) {
      await seedCompletedRuntimePinMigration({
        ...state.env,
        OPENCLAW_STATE_DIR: installedStateDir,
      });
    }

    // Model one synthetic OS account; the real install-identity guard still runs.
    mockDoctorServicePlatform("linux");
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.spyOn(os, "userInfo").mockReturnValue({
      homedir: home,
      username: "doctor-fixture",
      uid: process.geteuid!(),
      gid: process.getegid!(),
      shell: "/bin/sh",
    });
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (typeof args[0] === "string" && args[0].startsWith("/proc/self/fdinfo/")) {
        return "mnt_id:\t1\n";
      }
      if (args[0] === "/proc/self/mountinfo") {
        return `1 0 0:1 / / ${scenario === "sealed" ? "ro" : "rw"} - tmpfs tmpfs rw\n`;
      }
      return readFile(...args);
    });
    if (scenario === "unsafe") {
      const unsafePath = blockedTarget
        ? blockedTarget === "installed"
          ? installedEnvironmentPath
          : environmentPath
        : path.dirname(unitPath);
      await fs.chmod(unsafePath, 0o777);
    } else if (scenario === "repairable") {
      await fs.chmod(unitPath, 0o664);
    } else if (scenario === "uninspectable") {
      const lstat = fs.lstat.bind(fs);
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        if (args[0] === unitPath) {
          throw Object.assign(new Error(inspectionCanary), { code: "EACCES" });
        }
        return lstat(...args);
      });
    }

    let current = true;
    let authorityFailure: unknown;
    let running = false;
    const events: string[] = [];
    const nativeActions: string[] = [];
    const unexpectedProcesses: string[] = [];
    const renameSync = fsNode.renameSync;
    vi.spyOn(fsNode, "renameSync").mockImplementation((source, destination) => {
      renameSync(source, destination);
      if (destination === configPath) {
        events.push("config-published");
      }
    });
    const write = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      await write(...args);
      if (
        custodyLoss === "before-publication" &&
        typeof args[0] === "string" &&
        args[0].endsWith(".tmp") &&
        path.basename(args[0]).startsWith("openclaw-gateway.service.")
      ) {
        current = false;
      }
    });
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      await rename(source, destination);
      if (
        (custodyLoss === "backup-published" && destination === `${unitPath}.bak`) ||
        (custodyLoss === "environment-published" && destination === environmentPath) ||
        (custodyLoss === "definition-published" && destination === unitPath)
      ) {
        current = false;
      }
      if (
        [unitPath, `${unitPath}.bak`, environmentPath, installedEnvironmentPath].includes(
          String(destination),
        )
      ) {
        events.push("service-published");
      }
    });
    edges.runtimeProbe.mockImplementation(async (_file, args) => {
      if (args[0] !== "-e" || !args[1]?.includes("sqliteVersion")) {
        unexpectedProcesses.push("unexpected runtime process");
        throw new Error("Unexpected fixture runtime process");
      }
      return {
        stdout: JSON.stringify({
          nodeVersion: "24.22.1",
          sqliteVersion: "3.51.3",
          sqliteProbe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
        }),
        stderr: "",
      };
    });
    edges.command.mockImplementation(async (argv, options) => {
      const [binary, ...args] = argv;
      const action = args.find((arg) =>
        ["daemon-reload", "enable", "restart", "stop"].includes(arg),
      );
      let stdout: string;
      let code = 0;
      if (
        binary === "busctl" &&
        isDeepStrictEqual(args, [
          "--user",
          "--auto-start=no",
          "get-property",
          "org.freedesktop.systemd1",
          "/org/freedesktop/systemd1",
          "org.freedesktop.systemd1.Manager",
          "Version",
        ])
      ) {
        expect(options).toMatchObject({
          baseEnv: { XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: busAddress },
        });
        stdout = 's "252.39-1~deb12u2"\n';
      } else if (binary === "busctl") {
        stdout =
          args.includes("LoadUnit") || args.includes("GetUnit")
            ? JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/fixture"] })
            : args.includes("org.freedesktop.systemd1.Unit")
              ? buildSystemdUnitPropertyOutput({ fragmentPath: unitPath })
              : buildSystemdManagerPropertyOutput({
                  programArguments,
                  environment: Object.entries(environment).map(([key, value]) => `${key}=${value}`),
                });
      } else if (binary === "systemctl" && args.includes("--property=LoadState")) {
        stdout = "not-found\n";
      } else if (binary === "systemctl" && args.includes("--property=UnitPath")) {
        stdout = `${systemUnits}\n`;
      } else if (binary === "systemctl" && args.includes("show")) {
        stdout =
          "After=network-online.target\nWants=network-online.target\nRestartUSec=5s\nKillMode=control-group\n";
      } else if (binary === "systemctl" && args.includes("status")) {
        stdout = "running\n";
      } else if (binary === "systemctl" && args.includes("is-enabled")) {
        stdout = "enabled\n";
      } else if (binary === "systemctl" && args.includes("is-active")) {
        stdout = running ? "active\n" : "inactive\n";
        code = running ? 0 : 3;
      } else if (binary === "systemctl" && action) {
        nativeActions.push(action);
        if (action === "restart" || action === "stop") {
          running = action === "restart";
        }
        if (action === custodyLoss) {
          current = false;
        }
        stdout = "";
      } else {
        unexpectedProcesses.push(argv.join(" "));
        throw new Error("Unexpected fixture process");
      }
      return { stdout, stderr: "", code, signal: null, killed: false, termination: "exit" };
    });
    const errors: string[] = [];
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: (...args) => {
        errors.push(args.map(String).join(" "));
      },
      exit: vi.fn(),
    };
    const prompter = makePrompter(true);
    prompter.shouldForce = update;
    Object.assign(prompter.repairMode, {
      shouldForce: update,
      canPrompt: !update,
      nonInteractive: update,
      updateInProgress: update,
    });
    return withEnvAsync(
      {
        HOME: home,
        USERPROFILE: home,
        USER: "doctor-fixture",
        LOGNAME: "doctor-fixture",
        SUDO_USER: undefined,
        XDG_RUNTIME_DIR: runtimeDir,
        DBUS_SESSION_BUS_ADDRESS: busAddress,
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_SYSTEMD_UNIT: undefined,
        OPENCLAW_SERVICE_KIND: undefined,
        OPENCLAW_NIX_MODE: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        OPENCLAW_SERVICE_REPAIR_POLICY: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_PORT: undefined,
        OPENCLAW_WRAPPER: wrapperPath,
        OPENCLAW_UPDATE_IN_PROGRESS: update ? "1" : undefined,
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: update ? "1" : undefined,
      },
      async () => {
        expect(isDefaultInstallIdentity()).toBe(true);
        const service = gatewayService.resolveGatewayService();
        const capability = await service.readDefinitionMutationCapability!({
          env: process.env,
          environment,
        });
        const plannedCapability = blockedTarget
          ? await service.readDefinitionMutationCapability!({
              env: process.env,
              environment: { ...environment, OPENCLAW_STATE_DIR: stateDir },
            })
          : undefined;
        if (scenario === "rejected") {
          // Native filesystem failures return a capability; also exercise an adapter rejection.
          vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue({
            ...service,
            readDefinitionMutationCapability: async () => {
              throw new Error(inspectionCanary);
            },
          });
        }
        let result = cfg;
        if (custodyLoss) {
          // Installation inspection has separate coverage; keep the real native writer here.
          vi.spyOn(servicePlan, "inspectManagedGatewayServiceBeforeUpdate").mockResolvedValue({
            kind: "owned",
            root: path.join(root, "old-prefix"),
            fingerprint: "verified-service",
            refreshDefinition: true,
            requiresInstallRootRefresh: true,
          });
          const inspected = await gatewayService.readGatewayServiceState(service, {
            env: process.env,
            requireEffective: true,
            requireLoadedCommand: true,
          });
          if (!inspected.command) {
            throw new Error("Missing fixture service command");
          }
          try {
            await installDoctorGatewayService({
              service,
              command: inspected.command,
              repair: { kind: "installation", root: path.join(root, "candidate") },
              runtime,
              maintenance: {
                assertCurrent: () => {
                  if (!current) {
                    throw new Error("Doctor custody released during installation");
                  }
                },
                assertReadCurrent: () => {},
              },
              args: {
                env: process.env,
                stdout: new PassThrough(),
                programArguments: [wrapperPath, "gateway", "--port", "19989"],
                environment: { ...environment, OPENCLAW_GATEWAY_PORT: "19989" },
              },
            });
          } catch (error) {
            authorityFailure = error;
          }
        } else {
          result = await maybeRepairGatewayServiceConfig(cfg, "local", runtime, prompter, {
            async writeConfig(nextConfig) {
              const committed = await replaceConfigFile({
                nextConfig,
                afterWrite: { mode: "auto" },
                writeOptions: { auditOrigin: "doctor" },
              });
              return committed.nextConfig;
            },
          });
        }
        const configBytes = await fs.readFile(configPath, "utf8");
        const persisted: OpenClawConfig = JSON.parse(configBytes);
        const tokenRef = persisted.gateway?.auth?.token;
        const storedToken =
          typeof tokenRef === "object" && tokenRef.source === "store"
            ? await readSecretStoreValue({ scope: { kind: "team" }, name: tokenRef.id })
            : undefined;
        const diagnostics = [...edges.note.mock.calls.map(([message]) => message), ...errors].join(
          "\n",
        );
        const observations = {
          capability,
          plannedCapability,
          authorityFailure,
          running,
          events,
          configBytesPreserved: configBytes === originalConfig,
          embeddedTokenReferenced: storedToken?.ok === true && storedToken.value === embeddedToken,
          returnedConfigPreserved: isDeepStrictEqual(result, JSON.parse(originalConfig)),
          unitBytesPreserved: (await fs.readFile(unitPath, "utf8")) === originalUnit,
          unitMode: (await fs.stat(unitPath)).mode & 0o777,
          environmentBytesPreserved:
            (await fs.readFile(environmentPath, "utf8")) === originalEnvironment,
          installedEnvironmentBytesPreserved:
            (await fs.readFile(installedEnvironmentPath, "utf8")) === originalEnvironment,
          unitDirectoryEntries: await fs.readdir(path.dirname(unitPath)),
          nativeActions,
        };
        expect(unexpectedProcesses).toEqual([]);
        expect(diagnostics.includes(embeddedToken)).toBe(false);
        expect(diagnostics.includes(existingToken)).toBe(false);
        expect(configBytes.includes(embeddedToken)).toBe(false);
        expect(diagnostics.includes(inspectionCanary)).toBe(false);
        return { observations, diagnostics, errors };
      },
    );
  }

  it.each(custodyCases)(
    "Doctor custody fences real native installation at %s",
    async (custodyLoss, actions) => {
      const { observations } = await runRepair("writable", { tokenPresent: true, custodyLoss });
      expect.soft(observations).toMatchObject({
        unitBytesPreserved: true,
        environmentBytesPreserved: true,
        running: false,
        unitDirectoryEntries: ["openclaw-gateway.service"],
        nativeActions: actions,
      });
      expect(observations.authorityFailure).toMatchObject({
        code: "service-authority-revoked",
        outcome: custodyLoss === "before-publication" ? "unchanged" : "restored",
      });
    },
  );

  it.each(refusals)(
    "preserves config and service when %s repair is refused",
    async (scenario, kind, reason, guidance, tokenPresent) => {
      const { observations, diagnostics } = await runRepair(scenario, { tokenPresent });
      // Rejected adapters fail after native inspection; both paths must preserve the repair.
      if (scenario !== "rejected") {
        expect(observations.capability).toMatchObject({ kind, reason });
      }
      expect(diagnostics).toContain(`SERVICE_DEFINITION_${kind.toUpperCase()}: [${reason}]`);
      expect(diagnostics).toContain(guidance);
      expect.soft(observations).toMatchObject(untouchedRepair);
      expect(observations.events).not.toContain("service-published");
    },
  );

  it("preserves writable config and service during a forced updater Doctor", async () => {
    const { observations, diagnostics } = await runRepair("writable", { update: true });
    expect(observations.capability).toEqual({ kind: "writable" });
    expect(diagnostics).toContain("deferred to update finalization");
    expect(observations).toMatchObject(untouchedRepair);
    expect(observations.events).not.toContain("service-published");
  });

  it.each(["installed", "planned"] as const)(
    "preserves both generated environments when only the %s target is protected",
    async (blockedTarget) => {
      const { observations, diagnostics } = await runRepair("unsafe", { blockedTarget });
      const denied = { kind: "unknown", reason: "unsafe-permissions" };
      expect(observations.capability).toMatchObject(
        blockedTarget === "installed" ? denied : { kind: "writable" },
      );
      expect(observations.plannedCapability).toMatchObject(
        blockedTarget === "planned" ? denied : { kind: "writable" },
      );
      expect(diagnostics).toContain("SERVICE_DEFINITION_UNKNOWN: [unsafe-permissions]");
      expect(diagnostics).toContain("chmod go-w");
      expect(observations).toMatchObject(untouchedRepair);
      expect(observations.events).not.toContain("service-published");
    },
  );

  it.each(["writable", "repairable"] as const)(
    "preserves authentication while publishing an authorized %s service repair",
    async (scenario) => {
      const { observations, errors } = await runRepair(scenario);
      expect(observations.capability).toEqual({ kind: "writable" });
      expect(errors).toEqual([]);
      expect(observations).toMatchObject({
        embeddedTokenReferenced: true,
        unitBytesPreserved: false,
        unitMode: 0o600,
        events: expect.arrayContaining(["config-published", "service-published"]),
        nativeActions: ["daemon-reload", "enable", "restart"],
      });
      expect(observations.events.indexOf("config-published")).toBeLessThan(
        observations.events.indexOf("service-published"),
      );
      expect(observations.unitDirectoryEntries.toSorted()).toEqual([
        "openclaw-gateway.service",
        "openclaw-gateway.service.bak",
      ]);
    },
  );
});
