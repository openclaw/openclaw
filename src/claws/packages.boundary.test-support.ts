import { vi } from "vitest";
import * as managedInstall from "../plugins/management-mutations.js";
import * as managedUninstall from "../plugins/management-uninstall.js";
import * as pluginPreflight from "../plugins/plugin-install-preflight.js";
import * as skillLifecycle from "../skills/lifecycle/clawhub.js";
import * as packageLease from "../state/claw-package-lifecycle-lease.js";
import * as addState from "./add-state-write.js";
import type { InstallClawPackagesOptions } from "./package-install-options.js";
import {
  installClawPackages as installPackages,
  rollbackStatelessClawPackages as rollbackPackages,
} from "./packages.js";
import * as pluginProbe from "./plugin-capability-probe.js";
import type {
  persistClawPackageRef,
  readClawPackageRefs,
  updateClawPackageRefStatus,
} from "./provenance.js";

type PackageBoundaryFixtures = {
  installPlugin?: (
    params: Parameters<typeof managedInstall.installManagedPlugin>[0],
  ) => Promise<void>;
  uninstallPlugin?: (
    params: Parameters<typeof managedUninstall.uninstallPluginWithPolicy>[0],
  ) => Promise<void>;
  probePlugin?: NonNullable<
    Parameters<typeof pluginProbe.probeClawPluginArtifact>[2]
  >["probePlugin"];
  inspectPluginCapabilities?: typeof pluginProbe.inspectClawPluginCapabilities;
  installSkill?: typeof skillLifecycle.installSkillFromClawHub;
  preflightPlugin?: typeof pluginPreflight.preflightPluginInstall;
  preflightSkill?: typeof skillLifecycle.preflightSkillFromClawHub;
  persistPackageRef?: (
    ...args: Parameters<typeof persistClawPackageRef>
  ) => ReturnType<typeof persistClawPackageRef> | Promise<ReturnType<typeof persistClawPackageRef>>;
  completePackageRef?: (
    ...args: Parameters<typeof updateClawPackageRefStatus>
  ) =>
    | ReturnType<typeof updateClawPackageRefStatus>
    | Promise<ReturnType<typeof updateClawPackageRefStatus>>;
  readPackageRefs?: (
    ...args: Parameters<typeof readClawPackageRefs>
  ) => ReturnType<typeof readClawPackageRefs> | Promise<ReturnType<typeof readClawPackageRefs>>;
  acquirePackageLease?: typeof packageLease.acquireClawPackageLifecycleLease;
  resolvePlugin?: typeof pluginPreflight.resolveInstalledClawHubPlugin;
};

export type PackageInstallFixtureOptions = InstallClawPackagesOptions & {
  deps?: PackageBoundaryFixtures;
};

async function withPackageBoundaries<T>(
  run: () => Promise<T>,
  deps: PackageBoundaryFixtures = {},
): Promise<T> {
  const mocks: Array<{ mockRestore(): void }> = [];
  try {
    if (deps.installPlugin) {
      const install = deps.installPlugin;
      mocks.push(
        vi.spyOn(managedInstall, "installManagedPlugin").mockImplementation(async (params) => {
          await install(params);
          return {
            plugin: {
              id: "fixture-plugin",
              name: "Fixture plugin",
              installed: true,
              enabled: true,
              state: "enabled",
            },
          };
        }),
      );
    }
    if (deps.uninstallPlugin) {
      const uninstall = deps.uninstallPlugin;
      mocks.push(
        vi
          .spyOn(managedUninstall, "uninstallPluginWithPolicy")
          .mockImplementation(async (params) => {
            await uninstall(params);
            return {
              ok: true,
              value: {
                pluginId: params.pluginId,
                requestedPluginId: params.pluginId,
                pluginIds: [params.pluginId],
                removed: [],
                warnings: [],
              },
            };
          }),
      );
    }
    if (deps.preflightPlugin) {
      mocks.push(
        vi
          .spyOn(pluginPreflight, "preflightPluginInstall")
          .mockImplementation(deps.preflightPlugin),
      );
    }
    if (deps.installSkill) {
      mocks.push(
        vi.spyOn(skillLifecycle, "installSkillFromClawHub").mockImplementation(deps.installSkill),
      );
    }
    if (deps.preflightSkill) {
      mocks.push(
        vi
          .spyOn(skillLifecycle, "preflightSkillFromClawHub")
          .mockImplementation(deps.preflightSkill),
      );
    }
    if (deps.persistPackageRef) {
      const persist = deps.persistPackageRef;
      mocks.push(
        vi
          .spyOn(addState, "persistClawPackageRefForAdd")
          .mockImplementation(async (...args) => await persist(...args)),
      );
    }
    if (deps.completePackageRef) {
      const complete = deps.completePackageRef;
      mocks.push(
        vi
          .spyOn(addState, "updateClawPackageRefStatusForAdd")
          .mockImplementation(async (...args) => await complete(...args)),
      );
    }
    if (deps.readPackageRefs) {
      const read = deps.readPackageRefs;
      mocks.push(
        vi
          .spyOn(addState, "readClawPackageRefsForAdd")
          .mockImplementation(async (...args) => await read(...args)),
      );
    }
    if (deps.acquirePackageLease) {
      mocks.push(
        vi
          .spyOn(packageLease, "acquireClawPackageLifecycleLease")
          .mockImplementation(deps.acquirePackageLease),
      );
    }
    if (deps.resolvePlugin) {
      mocks.push(
        vi
          .spyOn(pluginPreflight, "resolveInstalledClawHubPlugin")
          .mockImplementation(deps.resolvePlugin),
      );
    }
    if (deps.probePlugin || deps.inspectPluginCapabilities) {
      const probe = pluginProbe.probeClawPluginArtifact;
      mocks.push(
        vi
          .spyOn(pluginProbe, "probeClawPluginArtifact")
          .mockImplementation((pkg, isolate, options) =>
            probe(pkg, isolate, {
              ...options,
              probePlugin: deps.probePlugin,
              inspectPluginCapabilities: deps.inspectPluginCapabilities,
            }),
          ),
      );
    }
    return await run();
  } finally {
    for (const mock of mocks.toReversed()) {
      mock.mockRestore();
    }
  }
}

export function installClawPackages(
  plan: Parameters<typeof installPackages>[0],
  { deps, ...options }: PackageInstallFixtureOptions = {},
) {
  return withPackageBoundaries(() => installPackages(plan, options), deps);
}

export function rollbackStatelessClawPackages(
  refs: Parameters<typeof rollbackPackages>[0],
  {
    deps,
    ...options
  }: Pick<PackageInstallFixtureOptions, "assertCurrent" | "deps" | "env" | "path" | "runtime"> = {},
) {
  return withPackageBoundaries(() => rollbackPackages(refs, options), deps);
}
