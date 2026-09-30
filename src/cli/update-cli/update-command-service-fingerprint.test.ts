import "./update-command-service-maintenance.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { expect, it, vi } from "vitest";
import * as serviceFiles from "../../daemon/inspect-files.js";
import {
  buildLaunchAgentPlist,
  readLaunchAgentProgramArgumentsFromFile,
} from "../../daemon/launchd-plist.js";
import * as gatewayBindings from "../../daemon/managed-gateway-bindings.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import * as gatewayServices from "../../daemon/service.js";
import { readGatewayServiceState } from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import * as nativeExec from "../../process/exec.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import {
  revalidateManagedGatewayServiceAfterUpdate,
  type PreManagedServiceStop,
} from "./update-command-service-maintenance.js";
import { assertManagedGatewayArtifactPublication } from "./update-command-service-revalidation.js";

const { withServiceHome } = await import("./update-command-service-maintenance.test-support.js");

it.each([
  "equivalent selected wrapper",
  "unlisted wrapper",
  "Task still registered",
  "changed command",
])("keeps the package no-restart exception with its selected Startup owner: %s", (scenario) =>
  withServiceHome(async (home) => {
    mockProcessPlatform("win32");
    const root = process.cwd();
    const env = { HOME: home, OPENCLAW_PROFILE: "selected" };
    const startup = "C:\\Startup\\Gateway.vbs";
    const command = {
      programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
      environment: env,
      sourcePath: "C:\\Gateway\\gateway.cmd",
    };
    const state: GatewayServiceState = {
      installed: false,
      loadState: { status: "not-loaded" },
      running: true,
      env,
      runtime: { status: "running", pid: process.pid },
      command,
    };
    vi.spyOn(gatewayBindings, "discoverManagedGatewayBindings").mockResolvedValue([
      { env, scope: "user", windowsStartupEntry: startup },
    ]);
    vi.spyOn(gatewayServices, "readGatewayServiceState").mockImplementation(
      async (_service, args) => ({
        ...state,
        command: args?.windowsStartupEntry
          ? {
              ...command,
              sourcePath: "c:/Gateway/gateway.cmd",
              definitionPaths: [startup, "c:/Gateway/gateway.cmd"],
              programArguments:
                scenario === "changed command"
                  ? [...command.programArguments, "--verbose"]
                  : command.programArguments,
            }
          : {
              ...command,
              ...(scenario === "Task still registered"
                ? {}
                : {
                    startupEntryPaths: [
                      scenario === "unlisted wrapper" ? "C:\\Startup\\Other.vbs" : startup,
                    ],
                  }),
            },
      }),
    );
    const admission = assertManagedGatewayArtifactPublication({
      roots: [root],
      env,
      timeoutMs: 30_000,
      assertCurrent: () => {},
      updateInstallKind: "package",
      shouldRestart: false,
      selected: {
        inspected: true,
        runtimeInspected: true,
        running: true,
        stopped: false,
        serviceEnv: env,
        serviceUpdateVerdict: {
          kind: "owned",
          root,
          fingerprint: sha256Hex(stableStringify(command)),
          refreshDefinition: true,
        },
      },
    });
    if (scenario === "equivalent selected wrapper") {
      await expect(admission).resolves.toBeUndefined();
    } else {
      await expect(admission).rejects.toMatchObject({ reason: "runtime-artifact-publication" });
    }
  }),
);

it.each(
  (["before-stop", "publication"] as const).flatMap((phase) =>
    [
      "no declared profile",
      "declared selected",
      "changed declared profile",
      "other native unit",
    ].map((scenario) => ({ phase, scenario })),
  ),
)("keeps selected Linux correspondence at $phase: $scenario", ({ phase, scenario }) =>
  withServiceHome(async (home) => {
    mockProcessPlatform("linux");
    const root = process.cwd();
    const unit = "custom-selected.service";
    const observedUnit = scenario === "other native unit" ? "custom-sibling.service" : unit;
    const selectedEnv = { HOME: home, OPENCLAW_PROFILE: "selected", OPENCLAW_SYSTEMD_UNIT: unit };
    const environment: Record<string, string> = { HOME: home };
    if (scenario !== "no declared profile") {
      environment.OPENCLAW_PROFILE = "selected";
    }
    const command = {
      programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
      environment,
      sourcePath: path.join(home, "shared-template.service"),
    };
    const observedCommand =
      scenario === "changed declared profile"
        ? { ...command, environment: { ...environment, OPENCLAW_PROFILE: "changed" } }
        : command;
    const state: GatewayServiceState = {
      installed: true,
      loadState: { status: "loaded" },
      running: true,
      env: {
        HOME: home,
        OPENCLAW_SYSTEMD_UNIT: observedUnit,
        OPENCLAW_PROFILE: observedCommand.environment.OPENCLAW_PROFILE,
      },
      command: observedCommand,
      runtime: {
        status: "running",
        pid: process.pid,
        systemd: { scope: "user", unit: observedUnit, managerUid: 501 },
      },
    };
    vi.spyOn(gatewayBindings, "discoverManagedGatewayBindings").mockResolvedValue([
      {
        env: { HOME: home, OPENCLAW_SYSTEMD_UNIT: observedUnit },
        scope: "user",
        systemdReadTarget: { scope: "user", unitName: observedUnit, unitPath: command.sourcePath },
      },
    ]);
    vi.spyOn(gatewayServices, "readGatewayServiceState").mockResolvedValue(state);
    const admission = assertManagedGatewayArtifactPublication({
      roots: [root],
      env: selectedEnv,
      timeoutMs: 30_000,
      assertCurrent: () => {},
      updateInstallKind: "package",
      phase,
      shouldRestart: phase === "before-stop",
      selected: {
        inspected: true,
        runtimeInspected: true,
        running: true,
        stopped: false,
        serviceEnv: selectedEnv,
        serviceManagerUid: 501,
        serviceUpdateVerdict: {
          kind: "owned",
          root,
          fingerprint: sha256Hex(stableStringify(command)),
          refreshDefinition: false,
        },
      },
    });
    if (scenario === "changed declared profile" || scenario === "other native unit") {
      await expect(admission).rejects.toMatchObject({ reason: "runtime-artifact-publication" });
    } else {
      await expect(admission).resolves.toBeUndefined();
    }
    expect(state.env.OPENCLAW_SYSTEMD_UNIT).toBe(observedUnit);
    expect(state.env.OPENCLAW_PROFILE).toBe(observedCommand.environment.OPENCLAW_PROFILE);
  }),
);

it.each(["unjoined native read", "authority revoked during read"])(
  "preserves the update fence after %s",
  (scenario) =>
    withServiceHome(async (home) => {
      mockProcessPlatform("linux");
      const env = { HOME: home };
      let revoked = false;
      const failure =
        scenario === "unjoined native read"
          ? new CommandProcessCleanupError()
          : new Error("Original update authority was revoked");
      vi.spyOn(gatewayBindings, "discoverManagedGatewayBindings").mockResolvedValue([{ env }]);
      vi.spyOn(gatewayServices, "readGatewayServiceState").mockImplementation(async () => {
        await Promise.resolve();
        if (scenario === "unjoined native read") {
          throw failure;
        }
        revoked = true;
        throw new Error("Ordinary inspection unavailable");
      });
      await expect(
        assertManagedGatewayArtifactPublication({
          roots: [process.cwd()],
          updateInstallKind: "package",
          shouldRestart: true,
          env,
          timeoutMs: 30_000,
          assertCurrent: () => {
            if (revoked) {
              throw failure;
            }
          },
        }),
      ).rejects.toBe(failure);
    }),
);

it.each(["inventory", "effective command"])(
  "retains uncertain native plist cleanup through %s",
  (phase) =>
    withServiceHome(async (home) => {
      mockProcessPlatform("darwin");
      const root = process.cwd();
      const directory = path.join(home, "Library", "LaunchAgents");
      const pathname = path.join(directory, "ai.openclaw.sibling.plist");
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        pathname,
        buildLaunchAgentPlist({
          label: "ai.openclaw.sibling",
          programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
          stdoutPath: path.join(home, "stdout.log"),
          stderrPath: path.join(home, "stderr.log"),
          environment: {
            OPENCLAW_PROFILE: "sibling",
            OPENCLAW_SERVICE_MARKER: "openclaw",
            OPENCLAW_SERVICE_KIND: "gateway",
          },
        }),
      );
      const collect = serviceFiles.collectServiceFiles;
      vi.spyOn(serviceFiles, "collectServiceFiles").mockImplementation((params) =>
        params.dir === directory ? collect(params) : Promise.resolve([]),
      );
      const failure = new CommandProcessCleanupError();
      vi.spyOn(nativeExec, "runExec").mockImplementation(async (bin) => {
        expect(bin).toBe("/usr/bin/plutil");
        throw failure;
      });
      const observed =
        phase === "effective command"
          ? readLaunchAgentProgramArgumentsFromFile(pathname, { requireEffective: true })
          : assertManagedGatewayArtifactPublication({
              roots: [root],
              env: { HOME: home },
              timeoutMs: 30_000,
              updateInstallKind: "package",
              shouldRestart: true,
              assertCurrent: () => {},
            });
      await expect(observed).rejects.toBe(failure);
    }),
);

it.each([
  "shipped handoff",
  "shipped startup handoff",
  "shipped startup protected handoff",
  "matching UID",
  "mismatching UID",
  "unavailable manager",
  "different unit",
  "different profile",
  "foreign executable",
  "unchanged protected command",
  "changed protected command",
  "changed protected environment",
  "changed protected working directory",
  "changed protected override",
])("revalidates the shipped managed-service stop record: %s", (scenario) =>
  withServiceHome(async (home) => {
    mockProcessPlatform(scenario.includes("startup") ? "win32" : "linux");
    const root = process.cwd();
    const command = {
      programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
      environment: { HOME: home },
      ...(scenario.includes("startup") ? { sourcePath: path.join(home, "gateway.cmd") } : {}),
    };
    const protectedCommand = scenario.includes("protected");
    const fingerprint = sha256Hex(stableStringify(command));
    // Stable updaters through v2026.9.4 omit metadata for known-empty systemd overrides.
    const before: PreManagedServiceStop = {
      stoppedAtMs: 1,
      stopped: true,
      inspected: true,
      runtimeInspected: true,
      running: true,
      offline: false,
      serviceEnv: { HOME: home },
      serviceDefinitionEnv: command.environment,
      serviceNodeRunner: process.execPath,
      serviceUpdateVerdict: {
        kind: "owned",
        root,
        fingerprint,
        refreshDefinition: !protectedCommand,
      },
    };
    if (scenario === "matching UID" || scenario === "mismatching UID") {
      before.serviceManagerUid = scenario === "matching UID" ? 2001 : 3002;
    }
    const service = createMockGatewayService({
      readCommand: async () => ({
        ...command,
        ...(scenario.includes("startup")
          ? { startupEntryPaths: [path.join(home, "Gateway.vbs")] }
          : {}),
        ...(protectedCommand
          ? {
              managedDefinition: command,
              managedOverrides:
                scenario === "changed protected override" ? { launcher: "command" as const } : {},
            }
          : {}),
        ...(scenario === "changed protected working directory" ? { workingDirectory: home } : {}),
        programArguments:
          scenario === "foreign executable"
            ? [process.execPath, path.join(home, "other", "openclaw.mjs"), "gateway"]
            : scenario === "changed protected command"
              ? [...command.programArguments, "--verbose"]
              : command.programArguments,
        environment: {
          ...command.environment,
          ...(scenario === "changed protected environment" ? { FIXTURE_VALUE: "changed" } : {}),
          ...(scenario === "different unit" ? { OPENCLAW_SYSTEMD_UNIT: "other-gateway" } : {}),
          ...(scenario === "different profile"
            ? {
                OPENCLAW_PROFILE: "other",
                OPENCLAW_STATE_DIR: path.join(home, ".openclaw-other"),
                OPENCLAW_CONFIG_PATH: path.join(home, ".openclaw-other", "openclaw.json"),
              }
            : {}),
        },
      }),
      readRuntime: async () => ({
        status: "stopped",
        systemd: { managerUid: scenario === "unavailable manager" ? undefined : 2001 },
      }),
      isLoaded: async () => true,
    });
    const state = await readGatewayServiceState(service, {
      env: before.serviceEnv,
      requireEffective: true,
      requireLoadedCommand: true,
    });
    const revalidated = revalidateManagedGatewayServiceAfterUpdate({
      state,
      root,
      preManagedServiceStop: before,
    });
    if (
      scenario.startsWith("shipped") ||
      scenario === "matching UID" ||
      scenario === "unchanged protected command"
    ) {
      await expect(revalidated).resolves.toMatchObject({
        kind: "owned",
        fingerprint,
        refreshDefinition: !protectedCommand,
      });
    } else {
      await expect(revalidated).rejects.toThrow(
        scenario === "unavailable manager"
          ? /inspection is unavailable/
          : /ownership or manager identity changed/,
      );
    }
  }),
);
