import "./update-command-service-maintenance.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as serviceFiles from "../../daemon/inspect-files.js";
import * as gatewayBindings from "../../daemon/managed-gateway-bindings.js";
import type {
  GatewayServiceState,
  SystemdGatewayInstallation,
} from "../../daemon/service-types.js";
import * as gatewayService from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { createUpdateFailureFact } from "../../infra/update-failure-facts.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import * as nativeExec from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { updateResult } from "./update-command-maintenance-fixtures.test-support.js";
import { withUpdateInProgressEnv } from "./update-command-service-env.js";
import {
  gatewayCommand,
  maintenanceDefaults,
} from "./update-command-service-fixtures.test-support.js";
import {
  maybeStopManagedServiceBeforeMutableUpdate,
  revalidateManagedGatewayServiceAfterUpdate,
  type PreManagedServiceStop,
} from "./update-command-service-maintenance.js";
import { assertManagedGatewayArtifactPublication } from "./update-command-service-revalidation.js";
import { maybeRestartService } from "./update-command-service.js";

const { withServiceHome, fixtureGatewayPid, mockMaintenanceService, mocks, expectNoServiceCalls } =
  await import("./update-command-service-maintenance.test-support.js");

describe("native manager identity", () => {
  beforeEach(() => mockProcessPlatform("linux"));

  const params = { ...maintenanceDefaults, phase: "inspect" as const };
  const ownedIdentity = { serviceManagerUid: 2001, serviceUpdateVerdict: { kind: "owned" } };
  const inspect = () => maybeStopManagedServiceBeforeMutableUpdate(params);
  const prepare = (expectedService: PreManagedServiceStop) =>
    maybeStopManagedServiceBeforeMutableUpdate({ ...params, phase: "prepare", expectedService });

  async function withEffectiveUid<T>(uid: number, run: () => Promise<T>): Promise<T> {
    const existingGeteuid = Object.getOwnPropertyDescriptor(process, "geteuid");
    Object.defineProperty(process, "geteuid", { configurable: true, value: () => uid });
    try {
      return await run();
    } finally {
      if (existingGeteuid) {
        Object.defineProperty(process, "geteuid", existingGeteuid);
      } else {
        Reflect.deleteProperty(process, "geteuid");
      }
    }
  }

  function mockService(
    home: string,
    managerUid: () => number | undefined,
    seenRoutes?: Array<string | undefined>,
  ) {
    return mockMaintenanceService(home, {
      readCommand: async (env) => {
        seenRoutes?.push(env.DBUS_SESSION_BUS_ADDRESS);
        return gatewayCommand(home);
      },
      readRuntime: async () => ({
        status: "running",
        pid: fixtureGatewayPid,
        systemd: { managerUid: managerUid() },
      }),
    });
  }

  it.each([
    { label: "changed account", uid: 3002 },
    { label: "missing account", uid: undefined },
  ])("revalidates native manager identity before preparation: $label", (scenario) =>
    withServiceHome(async (home) => {
      let managerUid: number | undefined = 2001;
      const { stop } = mockService(home, () => managerUid);
      const before = await inspect();
      expect(before).toMatchObject(ownedIdentity);
      managerUid = scenario.uid;
      await expect(prepare(before)).rejects.toThrow(/ownership|manager identity/);
      expect(stop).not.toHaveBeenCalled();
    }),
  );

  it("retains the inspected systemd manager route during preparation", () =>
    withServiceHome(async (home) => {
      const seenRoutes: Array<string | undefined> = [];
      const { stop } = mockService(home, () => 2001, seenRoutes);
      const before = await inspect();
      expect(before).toMatchObject(ownedIdentity);
      const admittedRoute = "unix:path=/run/user/2001/bus";
      before.serviceEnv = { ...before.serviceEnv, DBUS_SESSION_BUS_ADDRESS: admittedRoute };
      const readsBeforePreparation = seenRoutes.length;
      await expect(prepare(before)).resolves.toMatchObject({ stopped: true, ...ownedIdentity });
      expect(stop).toHaveBeenCalledOnce();
      expect(new Set(seenRoutes.slice(readsBeforePreparation))).toEqual(new Set([admittedRoute]));
    }));

  it("names both installations when the admitted Gateway command moves to another install", () =>
    withServiceHome(async (home) => {
      const otherRoot = path.join(home, "other-openclaw");
      await fs.mkdir(otherRoot);
      await fs.writeFile(path.join(otherRoot, "package.json"), '{"name":"openclaw"}');
      await fs.writeFile(path.join(otherRoot, "openclaw.mjs"), "");
      const service = mockService(home, () => 2001);
      const before = await inspect();
      expect(before.serviceUpdateVerdict?.kind).toBe("owned");
      service.readCommand = async () => gatewayCommand(home, otherRoot);
      const failure = await prepare(before).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      for (const message of [
        `Update install root: ${process.cwd()}`,
        `Gateway install root: ${otherRoot}`,
        `Update binary: ${path.join(process.cwd(), "openclaw.mjs")}`,
        "Different installations: align PATH",
        "openclaw gateway status --deep",
      ]) {
        expect(failure).toMatchObject({ message: expect.stringContaining(message) });
      }
      expect(service.stop).not.toHaveBeenCalled();
    }));

  it("loads a collected systemd unit from a shipped stopped handoff", () =>
    withServiceHome(async (home) =>
      withEffectiveUid(2001, async () => {
        let collected = false;
        const loadUids: Array<number | undefined> = [];
        const service = mockService(home, () => 2001);
        service.readCommand = async (_env, options) => {
          if (collected) {
            loadUids.push(options?.loadForInspection?.managerUid);
          }
          return gatewayCommand(home);
        };
        service.readRuntime = async (_env, options) => {
          if (collected) {
            loadUids.push(options?.loadForInspection?.managerUid);
          }
          return {
            status: collected ? "stopped" : "running",
            ...(collected ? {} : { pid: fixtureGatewayPid }),
            systemd: { managerUid: 2001 },
          };
        };
        const before = await inspect();
        expect(before).toMatchObject({ stopped: false, ...ownedIdentity });
        Object.assign(before, {
          stopped: true,
          stoppedAtMs: Date.now(),
          serviceManagerUid: undefined,
        });
        collected = true;
        await expect(
          maybeStopManagedServiceBeforeMutableUpdate({
            ...params,
            expectedService: before,
            assertCurrent: () => {},
          }),
        ).resolves.toMatchObject({ stopped: false, ...ownedIdentity });
        expect(loadUids).not.toHaveLength(0);
        expect(new Set(loadUids)).toEqual(new Set([2001]));
      }),
    ));
});

it.each([
  { account: "user", uid: 2001, update: true },
  { account: "root", uid: 0, update: true },
  { account: "standalone Doctor", uid: 0, update: false },
  { account: "unprivileged Doctor", uid: 2001, update: false },
  { account: "dueling", uid: 2001, update: true },
])("preserves system-service ownership for $account (update=$update)", ({ account, uid, update }) =>
  withServiceHome(async (home) => {
    mockProcessPlatform("linux");
    vi.spyOn(process, "getuid").mockReturnValue(uid);
    vi.spyOn(process, "geteuid").mockReturnValue(uid);
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    const root = await fs.realpath(process.cwd());
    const unitName = "openclaw-production@worker.service";
    const restartCommand = `sudo systemctl restart ${unitName}`;
    const service = createMockGatewayService();
    mocks.service.mockReturnValue(service);
    const system = {
      scope: "system" as const,
      unitName,
      unitPath: "/etc/systemd/system/" + unitName,
    };
    const systemdInstallation: SystemdGatewayInstallation =
      account === "dueling"
        ? {
            kind: "dueling",
            system,
            user: {
              scope: "user",
              unitName,
              unitPath: path.join(home, ".config/systemd/user", unitName),
            },
          }
        : { kind: "system", system };
    vi.spyOn(gatewayService, "readGatewayServiceState").mockResolvedValue({
      installed: true,
      loadState: { status: "loaded" },
      running: true,
      env: { HOME: home },
      command: gatewayCommand(home, root),
      runtime: { status: "running", pid: fixtureGatewayPid, systemd: { managerUid: 0 } },
      systemdInstallation,
    });
    const prepare = () =>
      maybeStopManagedServiceBeforeMutableUpdate({
        ...maintenanceDefaults,
        root,
        phase: "prepare",
      });
    const preparation = update ? withUpdateInProgressEnv(undefined, prepare) : prepare();
    if (!update) {
      if (uid !== 0) {
        const blocked = await preparation;
        expect(blocked).toMatchObject({
          stopped: false,
          blockMessage: expect.stringContaining(`sudo systemctl stop ${unitName}`),
          blockFailureFacts: [expect.objectContaining({ check: "gateway-stop" })],
        });
        expect(
          blocked.blockFailureFacts
            ?.map((fact) => createUpdateFailureFact(fact).message)
            .join("\n"),
        ).toContain("sudo systemctl stop");
        expectNoServiceCalls(service.stop, service.start, service.restart, service.install);
        expect(mocks.prepareStop).not.toHaveBeenCalled();
        expect(mocks.drain).not.toHaveBeenCalled();
        return;
      }
      expect(await preparation).toMatchObject({ stopped: true });
      expect(service.stop).toHaveBeenCalledOnce();
      return;
    }
    const prepared = await preparation;
    expect(prepared).toMatchObject({
      stopped: false,
      running: true,
      serviceMutationAllowed: false,
      serviceMutationSkipMessage: expect.stringContaining(restartCommand),
    });
    const result = updateResult({ root, durationMs: 0 });
    await expect(
      maybeRestartService({
        shouldRestart: false,
        refreshServiceEnv: false,
        serviceEnv: prepared.serviceEnv,
        serviceMutationSkipMessage: prepared.serviceMutationSkipMessage,
        result,
        opts: { json: true },
        gatewayPort: 18789,
        timeoutMs: 1000,
      }),
    ).resolves.toBe("ok");
    expect(defaultRuntime.error).toHaveBeenCalledWith(prepared.serviceMutationSkipMessage);
    expect(result.steps).toMatchObject([
      {
        exitCode: 0,
        advisory: {
          kind: "recoverable-maintenance",
          message: expect.stringContaining(restartCommand),
        },
      },
    ]);
    expectNoServiceCalls(service.stop, service.start, service.restart, service.install);
    expect(mocks.prepareStop).not.toHaveBeenCalled();
    expect(mocks.drain).not.toHaveBeenCalled();
  }),
);

describe("service fingerprint", () => {
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
      vi.spyOn(gatewayService, "readGatewayServiceState").mockImplementation(
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

  it.each([
    { phase: "before-stop", scenario: "no declared profile" },
    { phase: "publication", scenario: "declared selected" },
    { phase: "before-stop", scenario: "changed declared profile" },
    { phase: "publication", scenario: "other native unit" },
  ] as const)("keeps selected Linux correspondence at $phase: $scenario", ({ phase, scenario }) =>
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
          systemdReadTarget: {
            scope: "user",
            unitName: observedUnit,
            unitPath: command.sourcePath,
          },
        },
      ]);
      vi.spyOn(gatewayService, "readGatewayServiceState").mockResolvedValue(state);
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
        vi.spyOn(gatewayService, "readGatewayServiceState").mockImplementation(async () => {
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

  it("retains uncertain native plist cleanup through publication inventory", () =>
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
      await expect(publish({ HOME: home })).rejects.toBe(failure);
    }));

  it.each([
    "shipped handoff",
    "shipped startup handoff",
    "shipped startup protected handoff",
    "unavailable manager",
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
      const environment: Record<string, string> = { ...command.environment };
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
      if (scenario === "changed protected environment") {
        environment.FIXTURE_VALUE = "changed";
      }
      const service = createMockGatewayService({
        readCommand: async () => observed,
        readRuntime: async () => ({
          status: "stopped",
          systemd: { managerUid: scenario === "unavailable manager" ? undefined : 2001 },
        }),
        isLoaded: async () => true,
      });
      const state = await gatewayService.readGatewayServiceState(service, {
        env: before.serviceEnv,
        requireEffective: true,
        requireLoadedCommand: true,
      });
      const revalidated = revalidateManagedGatewayServiceAfterUpdate({
        state,
        root,
        preManagedServiceStop: before,
      });
      if (scenario.startsWith("shipped") || scenario === "unchanged protected command") {
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
});
