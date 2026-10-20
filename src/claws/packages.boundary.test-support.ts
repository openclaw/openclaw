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
import type { ClawPluginProbeDeps } from "./plugin-capability-probe.js";
import type { readClawPackageRefs } from "./provenance.js";

type PackageBoundaryFixtures = {
  installPlugin?: (
    params: Parameters<typeof managedInstall.installManagedPlugin>[0],
  ) => Promise<void>;
  uninstallPlugin?: (
    params: Parameters<typeof managedUninstall.uninstallPluginWithPolicy>[0],
  ) => Promise<void>;
  probePlugin?: ClawPluginProbeDeps["probePlugin"];
  inspectPluginCapabilities?: typeof pluginProbe.inspectClawPluginCapabilities;
  installSkill?: typeof skillLifecycle.installSkillFromClawHub;
  preflightPlugin?: typeof pluginPreflight.preflightPluginInstall;
  preflightSkill?: typeof skillLifecycle.preflightSkillFromClawHub;
  readPackageRefs?: (
    ...args: Parameters<typeof readClawPackageRefs>
  ) => ReturnType<typeof readClawPackageRefs> | Promise<ReturnType<typeof readClawPackageRefs>>;
  acquirePackageLease?: typeof packageLease.acquireClawPackageLifecycleLease;
  resolvePlugin?: typeof pluginPreflight.resolveInstalledClawHubPlugin;
};

export type PackageInstallFixtureOptions = InstallClawPackagesOptions & {
  deps?: PackageBoundaryFixtures;
};

export async function withPackageBoundaries<T>(
  run: () => Promise<T>,
  deps: PackageBoundaryFixtures = {},
): Promise<T> {
  const mocks: Array<{ mockRestore(): void }> = [];
  const { installPlugin, uninstallPlugin, readPackageRefs } = deps;
  function mock<K extends string, A extends unknown[], R>(
    owner: Record<K, (...args: A) => R>,
    key: K,
    implementation: NoInfer<(...args: A) => R> | undefined,
  ) {
    if (implementation) {
      mocks.push(vi.spyOn(owner, key).mockImplementation(implementation));
    }
  }
  try {
    mock(
      managedInstall,
      "installManagedPlugin",
      installPlugin &&
        (async (params) => {
          await installPlugin(params);
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
    mock(
      managedUninstall,
      "uninstallPluginWithPolicy",
      uninstallPlugin &&
        (async (params) => {
          await uninstallPlugin(params);
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
    mock(pluginPreflight, "preflightPluginInstall", deps.preflightPlugin);
    mock(skillLifecycle, "installSkillFromClawHub", deps.installSkill);
    mock(skillLifecycle, "preflightSkillFromClawHub", deps.preflightSkill);
    mock(
      addState,
      "readClawPackageRefsForAdd",
      readPackageRefs &&
        (async (...args: Parameters<typeof readPackageRefs>) => await readPackageRefs(...args)),
    );
    mock(packageLease, "acquireClawPackageLifecycleLease", deps.acquirePackageLease);
    mock(
      pluginPreflight,
      "resolveInstalledClawHubPlugin",
      deps.resolvePlugin ??
        (installPlugin ? async () => ({ status: "missing" as const }) : undefined),
    );
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
    for (const installed of mocks.toReversed()) {
      installed.mockRestore();
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
  { deps, ...options }: RollbackOptions = {},
) {
  return withPackageBoundaries(() => rollbackPackages(refs, options), deps);
}

type RollbackOptions = Pick<
  PackageInstallFixtureOptions,
  "assertCurrent" | "deps" | "env" | "path" | "runtime"
>;
