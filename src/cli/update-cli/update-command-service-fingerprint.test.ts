import "./update-command-service-maintenance.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { expect, it, vi } from "vitest";
import * as serviceFiles from "../../daemon/inspect-files.js";
import { readLaunchAgentProgramArgumentsFromFile } from "../../daemon/launchd-plist.js";
import * as gatewayBindings from "../../daemon/managed-gateway-bindings.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import * as gatewayServices from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import * as nativeExec from "../../process/exec.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { gatewayCommand } from "./update-command-service-fixtures.test-support.js";
import {
  revalidateManagedGatewayServiceAfterUpdate,
  type PreManagedServiceStop,
} from "./update-command-service-maintenance.js";
import { assertManagedGatewayArtifactPublication } from "./update-command-service-revalidation.js";

const { withServiceHome } = await import("./update-command-service-maintenance.test-support.js");
const root = process.cwd();
type Publication = Parameters<typeof assertManagedGatewayArtifactPublication>[0];
type Command = NonNullable<GatewayServiceState["command"]>;

function publish(env: NodeJS.ProcessEnv, options: Partial<Publication> = {}) {
  return assertManagedGatewayArtifactPublication({
    roots: [root],
    env,
    timeoutMs: 30_000,
    assertCurrent: () => {},
    updateInstallKind: "package",
    shouldRestart: true,
    ...options,
  });
}

function selected(
  command: Command,
  refreshDefinition = true,
  overrides: Partial<PreManagedServiceStop> = {},
): PreManagedServiceStop {
  return {
    inspected: true,
    runtimeInspected: true,
    running: true,
    stopped: false,
    serviceEnv: command.environment,
    serviceUpdateVerdict: {
      kind: "owned",
      root,
      fingerprint: sha256Hex(stableStringify(command)),
      refreshDefinition,
    },
    ...overrides,
  };
}

async function expectPublication(admission: Promise<void>, accepted: boolean) {
  if (accepted) {
    await expect(admission).resolves.toBeUndefined();
  } else {
    await expect(admission).rejects.toMatchObject({ reason: "runtime-artifact-publication" });
  }
}

it.each([
  "equivalent selected wrapper",
  "unlisted wrapper",
  "Task still registered",
  "changed command",
])("keeps the package no-restart exception with its selected Startup owner: %s", (scenario) =>
  withServiceHome(async (home) => {
    mockProcessPlatform("win32");
    const env = { HOME: home, OPENCLAW_PROFILE: "selected" };
    const startup = "C:\\Startup\\Gateway.vbs";
    const command = {
      ...gatewayCommand(home),
      environment: env,
      sourcePath: "C:\\Gateway\\gateway.cmd",
    };
    const state: GatewayServiceState = {
      installed: false,
      loadState: { status: "not-loaded" },
      running: true,
      env,
      command,
      runtime: { status: "running", pid: process.pid },
    };
    vi.spyOn(gatewayBindings, "discoverManagedGatewayBindings").mockResolvedValue([
      { env, scope: "user", windowsStartupEntry: startup },
    ]);
    const startupCommand = {
      ...command,
      sourcePath: "c:/Gateway/gateway.cmd",
      definitionPaths: [startup, "c:/Gateway/gateway.cmd"],
      programArguments: [...command.programArguments],
    };
    if (scenario === "changed command") {
      startupCommand.programArguments.push("--verbose");
    }
    const selectedCommand: Command = { ...command };
    if (scenario !== "Task still registered") {
      selectedCommand.startupEntryPaths = [
        scenario === "unlisted wrapper" ? "C:\\Startup\\Other.vbs" : startup,
      ];
    }
    vi.spyOn(gatewayServices, "readGatewayServiceState").mockImplementation(
      async (_service, args) => ({
        ...state,
        command: args?.windowsStartupEntry ? startupCommand : selectedCommand,
      }),
    );
    const admission = publish(env, {
      shouldRestart: false,
      selected: selected(command),
    });
    await expectPublication(admission, scenario === "equivalent selected wrapper");
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
    const unit = "custom-selected.service";
    const observedUnit = scenario === "other native unit" ? "custom-sibling.service" : unit;
    const selectedEnv = { HOME: home, OPENCLAW_PROFILE: "selected", OPENCLAW_SYSTEMD_UNIT: unit };
    const environment: Record<string, string> = { HOME: home };
    if (scenario !== "no declared profile") {
      environment.OPENCLAW_PROFILE = "selected";
    }
    const command = {
      ...gatewayCommand(home),
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
      command: observedCommand,
      env: {
        HOME: home,
        OPENCLAW_SYSTEMD_UNIT: observedUnit,
        OPENCLAW_PROFILE: observedCommand.environment.OPENCLAW_PROFILE,
      },
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
    const admission = publish(selectedEnv, {
      phase,
      shouldRestart: phase === "before-stop",
      selected: selected(command, false, {
        serviceEnv: selectedEnv,
        serviceManagerUid: 501,
      }),
    });
    await expectPublication(
      admission,
      scenario !== "changed declared profile" && scenario !== "other native unit",
    );
    expect(state.env).toMatchObject({
      OPENCLAW_SYSTEMD_UNIT: observedUnit,
      OPENCLAW_PROFILE: observedCommand.environment.OPENCLAW_PROFILE,
    });
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
        publish(env, {
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
      const directory = path.join(home, "Library", "LaunchAgents");
      const pathname = path.join(directory, "ai.openclaw.sibling.plist");
      await fs.mkdir(directory, { recursive: true });
      // Native normalization fails before command fields are decoded.
      await fs.writeFile(pathname, "<plist><dict/></plist>");
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
          : publish({ HOME: home });
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
    const command = {
      ...gatewayCommand(home),
      ...(scenario.includes("startup") ? { sourcePath: path.join(home, "gateway.cmd") } : {}),
    };
    const protectedCommand = scenario.includes("protected");
    const fingerprint = sha256Hex(stableStringify(command));
    // Stable updaters through v2026.9.4 omit metadata for known-empty systemd overrides.
    const before = selected(command, !protectedCommand, { stopped: true });
    if (scenario === "matching UID" || scenario === "mismatching UID") {
      before.serviceManagerUid = scenario === "matching UID" ? 2001 : 3002;
    }
    const environment = { ...command.environment };
    const observed: Command = { ...command, environment };
    if (scenario.includes("startup")) {
      observed.startupEntryPaths = [path.join(home, "Gateway.vbs")];
    }
    if (protectedCommand) {
      observed.managedDefinition = command;
      observed.managedOverrides =
        scenario === "changed protected override" ? { launcher: "command" } : {};
    }
    if (scenario === "changed protected working directory") {
      observed.workingDirectory = home;
    }
    if (scenario === "foreign executable") {
      observed.programArguments = gatewayCommand(home, path.join(home, "other")).programArguments;
    }
    if (scenario === "changed protected command") {
      observed.programArguments = [...command.programArguments, "--verbose"];
    }
    const environmentChanges: Record<string, NodeJS.ProcessEnv> = {
      "changed protected environment": { FIXTURE_VALUE: "changed" },
      "different unit": { OPENCLAW_SYSTEMD_UNIT: "other-gateway" },
      "different profile": {
        OPENCLAW_PROFILE: "other",
        OPENCLAW_STATE_DIR: path.join(home, ".openclaw-other"),
        OPENCLAW_CONFIG_PATH: path.join(home, ".openclaw-other", "openclaw.json"),
      },
    };
    Object.assign(environment, environmentChanges[scenario]);
    const service = createMockGatewayService({
      readCommand: async () => observed,
      readRuntime: async () => ({
        status: "stopped",
        systemd: { managerUid: scenario === "unavailable manager" ? undefined : 2001 },
      }),
      isLoaded: async () => true,
    });
    const state = await gatewayServices.readGatewayServiceState(service, {
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
