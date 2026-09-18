import fsSync from "node:fs";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";

type CurrentAdmissionFixture = {
  prepareCurrentPackage: (prefix: string) => Promise<string>;
  createCaseDir: (prefix: string) => string;
  writeServicePackage: (root: string) => Promise<string>;
  mockFileBackedPathExists: () => void;
  mockRunningManagedGateway: (programArguments: string[]) => void;
  primeServiceCommand: (programArguments: string[]) => void;
  useFileBackedConfig: () => Promise<void>;
  resolveConfigPath: () => string;
  updateCommand: typeof import("./update-command.js").updateCommand;
  ExitError: typeof import("../../runtime.js").ExitError;
  lastWriteJsonCall: () => unknown;
  getErrorOutput: () => string;
  packageInstallCommandCall: () => unknown;
  freshRestartCalls: () => readonly unknown[];
  expectNoSideEffects: (...effects: unknown[]) => void;
  mocks: {
    pluginAvailabilityPreflight: Mock;
    syncPluginsForUpdateChannel: Mock;
    updateNpmInstalledPlugins: Mock;
    replaceConfigFile: Mock;
    serviceStop: Mock;
    serviceStart: Mock;
    serviceRestart: Mock;
    prepareRestartScript: Mock;
  };
};

export function registerAlreadyCurrentAdmissionTests(f: CurrentAdmissionFixture) {
  it("refuses pending service recovery acquired before already-current activation", async () => {
    const updateExecutor = await import("./update-command-executor.js");
    const { resolvePackageActivationAnchor } =
      await import("../../infra/package-update-activation-journal.js");
    const root = await f.prepareCurrentPackage("current-core-recovery");
    const serviceRoot = f.createCaseDir("retained-service-install");
    const serviceEntry = await f.writeServicePackage(serviceRoot);
    f.mockFileBackedPathExists();
    f.mockRunningManagedGateway([process.execPath, serviceEntry, "gateway", "run"]);
    await f.useFileBackedConfig();

    const anchor = resolvePackageActivationAnchor(serviceRoot);
    const evidence = path.join(anchor, "candidate-evidence");
    const retainedFiles = [
      path.join(serviceRoot, "package.json"),
      serviceEntry,
      evidence,
      f.resolveConfigPath(),
    ];
    const snapshot = () => retainedFiles.map((file) => fsSync.readFileSync(file));
    let retainedBefore: Buffer[] | undefined;
    const withExecutor = updateExecutor.withUpdateCommandExecutor;
    vi.spyOn(updateExecutor, "withUpdateCommandExecutor").mockImplementation(
      (runId, operation, options) =>
        withExecutor(
          runId,
          (executor) =>
            operation({
              async enter(installRoot, enterOptions) {
                const fence = await executor.enter(installRoot, enterOptions);
                if (enterOptions?.activationTimeoutMs !== undefined && !retainedBefore) {
                  expect(installRoot).toBe(root);
                  fsSync.mkdirSync(anchor, { mode: 0o700 });
                  fsSync.writeFileSync(evidence, "retained publication evidence\n", {
                    mode: 0o600,
                  });
                  retainedBefore = snapshot();
                }
                return fence;
              },
            }),
          options,
        ),
    );

    await expect(f.updateCommand({ yes: true, json: true })).rejects.toEqual(new f.ExitError(1));

    expect(retainedBefore).toBeDefined();
    expect(f.lastWriteJsonCall()).toMatchObject({
      status: "error",
      root: serviceRoot,
      reason: "update-recovery-pending",
      recovery: { serviceRestartSafe: false },
    });
    expect(snapshot()).toEqual(retainedBefore);
    f.expectNoSideEffects(
      f.mocks.syncPluginsForUpdateChannel,
      f.mocks.updateNpmInstalledPlugins,
      f.mocks.replaceConfigFile,
      f.mocks.serviceStop,
      f.mocks.serviceStart,
      f.mocks.serviceRestart,
      f.mocks.prepareRestartScript,
    );
    expect(f.packageInstallCommandCall()).toBeUndefined();
    expect(f.freshRestartCalls()).toHaveLength(0);
  });

  it.each(["unavailable plugin", "changed service owner"])(
    "handles %s before already-current convergence",
    async (failure) => {
      const root = await f.prepareCurrentPackage("openclaw-update");
      f.mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);
      if (failure === "unavailable plugin") {
        f.mocks.pluginAvailabilityPreflight.mockResolvedValueOnce([
          {
            pluginId: "brave",
            reason: "Plugin target unavailable",
            message: "Plugin brave availability could not be confirmed.",
            guidance: [],
          },
        ]);
      } else {
        f.mocks.pluginAvailabilityPreflight.mockImplementationOnce(async () => {
          f.primeServiceCommand(["node", "/foreign/openclaw/dist/index.js", "gateway", "run"]);
          return [];
        });
      }
      const command = f.updateCommand({ yes: true, json: true });
      if (failure === "unavailable plugin") {
        await command;
        expect(f.lastWriteJsonCall()).toMatchObject({
          status: "skipped",
          reason: "already-current",
        });
        expect(f.mocks.updateNpmInstalledPlugins).toHaveBeenCalled();
        expect(f.getErrorOutput()).toContain("Plugin brave availability could not be confirmed");
      } else {
        await expect(command).rejects.toEqual(new f.ExitError(1));
        expect(f.lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: "managed-service-preflight",
        });
        f.expectNoSideEffects(
          f.mocks.updateNpmInstalledPlugins,
          f.mocks.syncPluginsForUpdateChannel,
          f.mocks.serviceStop,
          f.mocks.serviceRestart,
        );
      }
      expect(f.packageInstallCommandCall()).toBeUndefined();
    },
  );
}
