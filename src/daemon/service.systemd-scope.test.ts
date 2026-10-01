import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "../cli/update-cli/update-command-service-maintenance.js";
import { withEnvAsync } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import type { ExecResult } from "./exec-file.js";
import type { SystemdGatewayInstallation, SystemdServiceReadTarget } from "./service-types.js";
import * as systemdScope from "./systemd-scope.js";

const exec = vi.hoisted(() => vi.fn<typeof import("./exec-file.js").execFileUtf8>());
const discovery = vi.hoisted(() =>
  vi.fn<typeof import("./inspect.js").findSystemGatewayServices>(),
);
vi.mock("./exec-file.js", () => ({ execFileUtf8: exec }));
vi.mock("./inspect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./inspect.js")>();
  return { ...actual, findSystemGatewayServices: discovery };
});

import { discoverManagedGatewayBindings } from "./managed-gateway-bindings.js";
import { readGatewayServiceState, resolveGatewayService } from "./service.js";
import { findSystemdGatewayInstallation } from "./systemd-scope.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const property = (type: string, data: unknown) => ({ type, data });
const success = (stdout: string): ExecResult => ({
  code: 0,
  termination: "exit",
  stdout,
  stderr: "",
});
const TEST_MANAGED_HOME = "/tmp/openclaw-test-home";

type ScopeCase = {
  file: string;
  instance: string;
  running: boolean;
  unit?: string;
  launch?: "direct" | "default-profile" | "runtime-flags";
  other?:
    | "named-env"
    | "named-argv"
    | "profile-file"
    | "other-state"
    | "other-account"
    | "same-default"
    | "unavailable"
    | "wrapper"
    | "budget"
    | "handoff-budget"
    | "default-budget"
    | "node";
};

it.each<ScopeCase>([
  { file: "openclaw.service", instance: "openclaw.service", running: false },
  { file: "openclaw@.service", instance: "openclaw@gateway.service", running: false },
  { file: "openclaw@.service", instance: "openclaw@gateway.service", running: true },
  {
    file: "openclaw@.service",
    instance: "openclaw@gateway.service",
    running: false,
    unit: "openclaw@gateway.service",
  },
  {
    file: "openclaw@.service",
    instance: "openclaw@gateway.service",
    running: true,
    unit: "openclaw@gateway.service",
  },
  { file: "custom-gateway.service", instance: "custom-gateway.service", running: false },
  { file: "custom-gateway.service", instance: "custom-gateway.service", running: true },
  ...(["direct", "default-profile", "runtime-flags"] as const).map((launch) => ({
    file: "custom-gateway.service",
    instance: "custom-gateway.service",
    running: false,
    launch,
  })),
  ...(
    [
      "named-env",
      "named-argv",
      "profile-file",
      "other-state",
      "other-account",
      "same-default",
      "unavailable",
      "wrapper",
      "budget",
      "handoff-budget",
      "default-budget",
      "node",
    ] as const
  ).map((other) => ({
    file: "custom-gateway.service",
    instance: "custom-gateway.service",
    running: false,
    other,
  })),
])(
  "inspects $instance with running=$running unit=$unit other=$other launch=$launch and preserves its sealed definition",
  async ({ file, instance, running, unit, other, launch }) => {
    let elapsedMs = 0;
    let targetReads = 0;
    if (other === "budget" || other === "handoff-budget" || other === "default-budget") {
      vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
    }
    const home = await fs.realpath(dirs.make("openclaw-system-maintenance-"));
    const root = path.join(home, "package");
    const entrypoint = path.join(root, "openclaw.mjs");
    const programArguments =
      launch === "direct"
        ? [entrypoint, "gateway"]
        : [
            process.execPath,
            ...(launch === "runtime-flags" ? ["--max-old-space-size=512"] : []),
            entrypoint,
            "gateway",
            ...(launch === "default-profile" ? ["--profile", "default"] : []),
          ];
    const target: SystemdServiceReadTarget = {
      scope: "system",
      unitName: instance,
      unitPath: path.join(home, file),
    };
    await fs.mkdir(root);
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.9.4" }),
    );
    await fs.writeFile(entrypoint, "");
    await fs.writeFile(
      target.unitPath,
      `[Service]\nUser=${file.includes("@") ? "%i" : "gateway"}\nExecStart=${process.execPath} ${entrypoint} gateway\n`,
    );
    const otherName = "other-gateway.service";
    const otherPath = path.join(home, otherName);
    const otherEnvPath = path.join(home, "other.env");
    if (other) {
      await fs.writeFile(
        otherPath,
        `[Service]\nExecStart=${process.execPath} ${entrypoint} gateway\n`,
      );
      await fs.writeFile(otherEnvPath, "OPENCLAW_PROFILE=darlene\n");
    }
    discovery.mockResolvedValue([
      ...(other
        ? [
            {
              platform: "linux" as const,
              scope: "system" as const,
              marker: "openclaw" as const,
              label: otherName,
              detail: `unit: ${otherPath}`,
            },
          ]
        : []),
      {
        platform: "linux",
        scope: "system",
        marker: "openclaw",
        label: file,
        detail: `unit: ${target.unitPath}`,
      },
    ]);
    vi.spyOn(fs, "access").mockRejectedValue(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
    mockProcessPlatform("linux");
    vi.spyOn(os, "userInfo").mockReturnValue({
      username: "gateway",
      uid: 2001,
      gid: 2001,
      homedir: home,
      shell: "/bin/sh",
    });
    const properties: Record<string, unknown> = {
      UnitPath: property("as", [home]),
      FragmentPath: property("s", target.unitPath),
      DropInPaths: property("as", []),
      NeedDaemonReload: property("b", false),
      ExecStart: property("a(sasbttttuii)", [
        [programArguments[0], programArguments, false, 0, 0, 0, 0, 0, 0, 0],
      ]),
      WorkingDirectory: property("s", home),
      Environment: property("as", []),
      EnvironmentFiles: property("a(sb)", []),
      UnsetEnvironment: property("as", []),
      User: property("s", "gateway"),
      Id: property("s", target.unitName),
      LoadState: property("s", "loaded"),
      ActiveState: property("s", running ? "active" : "inactive"),
      SubState: property("s", running ? "running" : "dead"),
      StartLimitBurst: property("u", 5),
      ActiveEnterTimestampMonotonic: property("t", 100),
      InactiveEnterTimestampMonotonic: property("t", 200),
      Result: property("s", "success"),
      NRestarts: property("u", 0),
      MainPID: property("u", running ? 4242 : 0),
      ExecMainStatus: property("i", 0),
      ExecMainCode: property("i", 1),
      KillMode: property("s", "control-group"),
      TasksCurrent: property("t", running ? 1 : 0),
      MemoryCurrent: property("t", 0),
      ControlGroup: property("s", `/system.slice/${target.unitName}`),
    };
    const otherObject = "/org/freedesktop/systemd1/unit/other_2eservice";
    const otherProperties: Record<string, unknown> = {
      ...properties,
      Id: property("s", otherName),
      FragmentPath: property("s", otherPath),
      User: property("s", other === "other-account" ? "another-account" : "gateway"),
      Environment: property(
        "as",
        other === "named-env" ||
          other === "budget" ||
          other === "handoff-budget" ||
          other === "default-budget"
          ? ["OPENCLAW_PROFILE=darlene"]
          : other === "other-state"
            ? [`OPENCLAW_STATE_DIR=${path.join(home, ".openclaw-darlene")}`]
            : other === "node"
              ? ["OPENCLAW_SERVICE_KIND=node"]
              : [],
      ),
      EnvironmentFiles: property("a(sb)", other === "profile-file" ? [[otherEnvPath, false]] : []),
      ExecStart: property("a(sasbttttuii)", [
        [
          other === "wrapper" ? "/usr/bin/env" : process.execPath,
          [
            ...(other === "wrapper" ? ["/usr/bin/env", "OPENCLAW_PROFILE=darlene"] : []),
            process.execPath,
            entrypoint,
            ...(other === "named-argv" ? ["--profile", "darlene"] : []),
            ...(other === "node" ? ["node", "run"] : ["gateway"]),
          ],
          false,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
        ],
      ]),
    };
    exec.mockReset().mockImplementation(async (command, args) => {
      if (command === "systemctl" && args[0] === "is-enabled") {
        return success("enabled\n");
      }
      if (command !== "busctl" || !args.includes("--system")) {
        return { ...success(""), code: 1, stderr: "User manager unavailable" };
      }
      if (args.includes("GetNameOwner")) {
        return success(JSON.stringify(property("s", [":1.42"])));
      }
      if (args.includes("GetConnectionUnixUser")) {
        return success(JSON.stringify(property("u", [0])));
      }
      if (args.includes("GetUnit")) {
        if (other === "budget") {
          elapsedMs += 40;
        }
        if (other === "default-budget") {
          elapsedMs += 4000;
        }
        if (other === "handoff-budget") {
          if (args.at(-1) === otherName) {
            elapsedMs += 40;
          } else if (args.at(-1) === target.unitName && targetReads++ > 0) {
            elapsedMs += 20;
          }
        }
        if (args.at(-1) === otherName && other) {
          return other === "unavailable"
            ? { ...success(""), code: 1, stderr: "Synthetic system unit inspection unavailable" }
            : success(JSON.stringify(property("o", [otherObject])));
        }
        if (args.at(-1) !== target.unitName) {
          return {
            ...success(""),
            code: 1,
            stderr: `Call failed: Unit ${args.at(-1)} not loaded.`,
          };
        }
        return success(
          JSON.stringify(property("o", ["/org/freedesktop/systemd1/unit/openclaw_2eservice"])),
        );
      }
      const index = args.findIndex((arg) => /\.(Unit|Service|Manager)$/.test(arg));
      if (index < 0) {
        throw new Error("Unexpected native command during read-only maintenance inspection");
      }
      return success(
        args
          .slice(index + 1)
          .map((name) =>
            JSON.stringify((args.includes(otherObject) ? otherProperties : properties)[name]),
          )
          .join("\n"),
      );
    });
    await withEnvAsync(
      {
        HOME: home,
        USER: "unrelated-login-name",
        USERPROFILE: undefined,
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: undefined,
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_SYSTEMD_UNIT: unit,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        OPENCLAW_SERVICE_MARKER: undefined,
        OPENCLAW_SERVICE_KIND: undefined,
      },
      async () => {
        if (
          other === "same-default" ||
          other === "unavailable" ||
          other === "wrapper" ||
          other === "budget" ||
          other === "handoff-budget" ||
          other === "default-budget"
        ) {
          await expect(
            readGatewayServiceState(resolveGatewayService(), {
              requireEffective: true,
              requireLoadedCommand: true,
              ...(other === "budget" || other === "handoff-budget" ? { timeoutMs: 50 } : {}),
            }),
          ).rejects.toThrow(
            other === "same-default"
              ? "Multiple systemd Gateway units"
              : other === "budget" || other === "handoff-budget" || other === "default-budget"
                ? "inspection deadline expired"
                : other === "wrapper"
                  ? "launcher identity is unknown"
                  : "could not be inspected",
          );
          expect(
            exec.mock.calls.some(
              ([, args]) => args.includes("GetUnit") && args.at(-1) === otherName,
            ),
          ).toBe(true);
          if (other === "default-budget") {
            const targetQuery = exec.mock.calls.find(
              ([, args]) => args.includes("GetUnit") && args.at(-1) === target.unitName,
            );
            expect(targetQuery).toBeDefined();
            expect(targetQuery?.[2]?.timeout).toBeLessThanOrEqual(1000);
          }
          return;
        }
        const state = await readGatewayServiceState(resolveGatewayService(), {
          requireEffective: true,
          requireLoadedCommand: true,
        });
        expect(state).toMatchObject({
          systemdInstallation: { kind: "system", system: target },
          env: { OPENCLAW_SYSTEMD_UNIT: target.unitName },
          installed: true,
          running,
          loadState: { status: "loaded" },
          runtime: {
            status: running ? "running" : "stopped",
            systemd: { scope: "system", unit: target.unitName, managerUid: 0 },
          },
          definitionMutationCapability: { kind: "sealed", reason: "system-owned" },
        });
        if (file === "openclaw.service") {
          const actualInstallationDiscovery = systemdScope.findSystemdGatewayInstallation;
          const installationDiscovery = vi.spyOn(systemdScope, "findSystemdGatewayInstallation");
          try {
            for (const selection of [
              "discovered",
              "supplied",
              "delegated",
              "none",
              "dueling",
              "explicit",
            ] as const) {
              const supplied: SystemdGatewayInstallation | undefined =
                selection === "none" || selection === "explicit"
                  ? { kind: "none" }
                  : selection === "dueling"
                    ? { kind: "dueling", user: { ...target, scope: "user" }, system: target }
                    : selection === "discovered"
                      ? undefined
                      : { kind: "system", system: target };
              const service = { ...resolveGatewayService() };
              if (selection === "delegated") {
                const readCommand = service.readCommand;
                service.readCommand = (...args) => readCommand(...args);
              }
              const shouldDiscover =
                selection === "discovered" || selection === "none" || selection === "dueling";
              installationDiscovery.mockReset();
              if (shouldDiscover) {
                installationDiscovery.mockImplementation(actualInstallationDiscovery);
              } else {
                installationDiscovery.mockRejectedValue(
                  new Error("Supplied target must retain its scope"),
                );
              }
              const selectedState = await readGatewayServiceState(service, {
                requireEffective: true,
                requireLoadedCommand: true,
                systemdInstallation: supplied,
                systemdReadTarget: selection === "explicit" ? target : undefined,
              });
              expect(installationDiscovery, selection).toHaveBeenCalledTimes(
                shouldDiscover ? 1 : 0,
              );
              expect(selectedState, selection).toMatchObject({
                systemdInstallation:
                  selection === "explicit" ? { kind: "none" } : { kind: "system", system: target },
                installed: true,
                running: false,
                loadState: { status: "loaded" },
                runtime: {
                  status: "stopped",
                  systemd: { scope: "system", unit: target.unitName, managerUid: 0 },
                },
                definitionMutationCapability: { kind: "sealed", reason: "system-owned" },
              });
            }
          } finally {
            installationDiscovery.mockRestore();
          }
        }
        const admitted = await maybeStopManagedServiceBeforeMutableUpdate({
          root,
          updateInstallKind: "package",
          shouldRestart: true,
          phase: "inspect",
          jsonMode: true,
        });
        expect(admitted).toMatchObject({
          inspected: true,
          runtimeInspected: true,
          running,
          offline: !running,
          serviceManagerUid: 0,
          serviceUpdateVerdict: { kind: "owned", refreshDefinition: false },
        });
        expect(admitted.blockMessage).toBeUndefined();
      },
    );
    expect(
      exec.mock.calls.every(([command, args]) =>
        command === "systemctl"
          ? args[0] === "is-enabled"
          : args.includes("--system") &&
            args.includes("--auto-start=no") &&
            !args.some((arg) => /^(Load|Start|Stop|Restart|Enable)Unit$/.test(arg)),
      ),
    ).toBe(true);
  },
);

it("reads the system template instance while a separate user Gateway is installed", async () => {
  const home = await fs.realpath(dirs.make("openclaw-system-template-census-"));
  const root = path.join(home, "package");
  const entrypoint = path.join(root, "openclaw.mjs");
  const userDir = path.join(home, ".config", "systemd", "user");
  const systemDir = path.join(home, "etc", "systemd", "system");
  const userUnit = path.join(userDir, "openclaw-gateway.service");
  const templateUnit = path.join(systemDir, "openclaw@.service");
  const discoveredTemplateUnit = "/etc/systemd/system/openclaw@.service";
  const instanceName = "openclaw@gateway.service";
  await fs.mkdir(root);
  await fs.mkdir(userDir, { recursive: true });
  await fs.mkdir(systemDir, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.4" }),
  );
  await fs.writeFile(entrypoint, "");
  const unitBody = `[Service]\nExecStart=${process.execPath} ${entrypoint} gateway\nEnvironment=OPENCLAW_SERVICE_MARKER=openclaw\nEnvironment=OPENCLAW_SERVICE_KIND=gateway\n`;
  await fs.writeFile(userUnit, unitBody);
  await fs.writeFile(
    templateUnit,
    `[Service]\nUser=%i\nExecStart=${process.execPath} ${entrypoint} gateway\n`,
  );
  const readdir = fs.readdir;
  const readFile = fs.readFile;
  vi.spyOn(fs, "readdir").mockImplementation((...args: Parameters<typeof fs.readdir>) => {
    if (args[0] === "/etc/systemd/system") {
      args[0] = systemDir;
    } else if (args[0] === "/usr/lib/systemd/system" || args[0] === "/lib/systemd/system") {
      args[0] = path.join(home, "absent-systemd-directory");
    }
    return readdir(...args);
  });
  vi.spyOn(fs, "readFile").mockImplementation((...args: Parameters<typeof fs.readFile>) => {
    if (args[0] === discoveredTemplateUnit) {
      args[0] = templateUnit;
    }
    return readFile(...args);
  });
  discovery.mockResolvedValue([
    {
      platform: "linux",
      scope: "system",
      marker: "openclaw",
      label: "openclaw@.service",
      detail: `unit: ${templateUnit}`,
    },
  ]);
  mockProcessPlatform("linux");
  vi.spyOn(os, "userInfo").mockReturnValue({
    username: "gateway",
    uid: 2001,
    gid: 2001,
    homedir: home,
    shell: "/bin/sh",
  });
  const properties: Record<string, unknown> = {
    UnitPath: property("as", [home]),
    FragmentPath: property("s", templateUnit),
    DropInPaths: property("as", []),
    NeedDaemonReload: property("b", false),
    ExecStart: property("a(sasbttttuii)", [
      [process.execPath, [process.execPath, entrypoint, "gateway"], false, 0, 0, 0, 0, 0, 0, 0],
    ]),
    WorkingDirectory: property("s", home),
    Environment: property("as", []),
    EnvironmentFiles: property("a(sb)", []),
    UnsetEnvironment: property("as", []),
    User: property("s", "gateway"),
    Id: property("s", instanceName),
    LoadState: property("s", "loaded"),
    ActiveState: property("s", "active"),
    SubState: property("s", "running"),
    StartLimitBurst: property("u", 5),
    ActiveEnterTimestampMonotonic: property("t", 100),
    InactiveEnterTimestampMonotonic: property("t", 200),
    Result: property("s", "success"),
    NRestarts: property("u", 0),
    MainPID: property("u", 4242),
    ExecMainStatus: property("i", 0),
    ExecMainCode: property("i", 1),
    KillMode: property("s", "control-group"),
    TasksCurrent: property("t", 1),
    MemoryCurrent: property("t", 0),
    ControlGroup: property("s", `/system.slice/${instanceName}`),
  };
  exec.mockReset().mockImplementation(async (command, args) => {
    if (command === "systemctl" && args[0] === "is-enabled") {
      return success("enabled\n");
    }
    if (command !== "busctl" || !args.includes("--system")) {
      return { ...success(""), code: 1, stderr: "User manager unavailable" };
    }
    if (args.includes("GetNameOwner")) {
      return success(JSON.stringify(property("s", [":1.42"])));
    }
    if (args.includes("GetConnectionUnixUser")) {
      return success(JSON.stringify(property("u", [0])));
    }
    if (args.includes("GetUnit")) {
      if (args.at(-1) !== instanceName) {
        return {
          ...success(""),
          code: 1,
          stderr: `Call failed: Unit ${args.at(-1)} not loaded.`,
        };
      }
      return success(
        JSON.stringify(
          property("o", ["/org/freedesktop/systemd1/unit/openclaw_40gateway_2eservice"]),
        ),
      );
    }
    const index = args.findIndex((arg) => /\.(Unit|Service|Manager)$/.test(arg));
    if (index < 0) {
      throw new Error("Unexpected native command during template instance inspection");
    }
    return success(
      args
        .slice(index + 1)
        .map((name) => JSON.stringify(properties[name]))
        .join("\n"),
    );
  });
  const bindings = await discoverManagedGatewayBindings({
    HOME: home,
    OPENCLAW_PROFILE: "foreign",
    OPENCLAW_SYSTEMD_UNIT: "openclaw@foreign.service",
  });
  const systemBinding = bindings.find((binding) => binding.scope === "system");
  expect(systemBinding?.systemdReadTarget).toEqual({
    scope: "system",
    unitName: instanceName,
    unitPath: discoveredTemplateUnit,
  });
  expect(bindings.some((binding) => binding.scope === "user")).toBe(true);
  await withEnvAsync(
    {
      HOME: home,
      USER: "unrelated-login-name",
      USERPROFILE: undefined,
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: undefined,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_SYSTEMD_UNIT: undefined,
      OPENCLAW_SUPERVISOR_MODE: undefined,
      OPENCLAW_SERVICE_MARKER: undefined,
      OPENCLAW_SERVICE_KIND: undefined,
    },
    async () => {
      const state = await readGatewayServiceState(resolveGatewayService(), {
        env: systemBinding?.env,
        systemdReadTarget: systemBinding?.systemdReadTarget,
        requireEffective: true,
        requireLoadedCommand: true,
      });
      expect(state.running).toBe(true);
      expect(state.runtime).toMatchObject({
        status: "running",
        systemd: { scope: "system", unit: instanceName, managerUid: 0 },
      });
      expect(state.command?.programArguments).toEqual([process.execPath, entrypoint, "gateway"]);
    },
  );
  expect(exec.mock.calls.some(([, args]) => args.at(-1) === "openclaw@.service")).toBe(false);
  expect(
    exec.mock.calls.some(([, args]) => args.includes(instanceName) || args.at(-1) === instanceName),
  ).toBe(true);
});

it("findSystemdGatewayInstallation expands a system template to this account's instance", async () => {
  // No unit files exist anywhere; discovery supplies the system template unit.
  vi.spyOn(fs, "access").mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
  vi.spyOn(os, "userInfo").mockReturnValue({
    username: "gateway",
    uid: 2001,
    gid: 2001,
    shell: "/bin/sh",
    homedir: TEST_MANAGED_HOME,
  });
  discovery.mockResolvedValueOnce([
    {
      platform: "linux",
      label: "openclaw@.service",
      detail: "unit: /etc/systemd/system/openclaw@.service",
      scope: "system",
      marker: "openclaw",
    },
  ]);
  await expect(findSystemdGatewayInstallation({ HOME: TEST_MANAGED_HOME })).resolves.toEqual({
    kind: "system",
    system: {
      scope: "system",
      unitName: "openclaw@gateway.service",
      unitPath: "/etc/systemd/system/openclaw@.service",
    },
  });
});
