import { vi } from "vitest";
import type { installPluginFromClawHub } from "../plugins/clawhub.js";
import * as managedInstall from "../plugins/management-mutations.js";
import * as managedUninstall from "../plugins/management-uninstall.js";
import * as pluginPreflight from "../plugins/plugin-install-preflight.js";
import * as skillLifecycle from "../skills/lifecycle/clawhub.js";
import * as packageLease from "../state/claw-package-lifecycle-lease.js";
import * as addState from "./add-state-write.js";
import {
  installClawPackages as installPackages,
  rollbackStatelessClawPackages as rollbackPackages,
} from "./packages.js";
import * as pluginProbe from "./plugin-capability-probe.js";
import type { readClawPackageRefs } from "./provenance.js";

export const testPluginPackage = {
  kind: "plugin",
  source: "clawhub",
  ref: "@owner/audit",
  version: "2.0.1",
  integrity: `sha256:${"a".repeat(64)}`,
} as const;

type Probe = typeof installPluginFromClawHub;
type PluginProbe = Extract<Awaited<ReturnType<Probe>>, { ok: true }>;
export function testPluginProbe(overrides: Partial<PluginProbe> = {}): PluginProbe {
  return {
    ok: true,
    pluginId: "audit",
    packageName: testPluginPackage.ref,
    targetDir: "/tmp/plugin",
    extensions: [],
    clawhub: {
      source: "clawhub",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: testPluginPackage.ref,
      clawhubFamily: "code-plugin",
      integrity: testPluginPackage.integrity,
    },
    ...overrides,
  };
}

export const withStagedInspection = (probe: Probe) => async (request: Parameters<Probe>[0]) => {
  const result = await probe(request);
  if (result.ok) {
    await request.onPluginArtifactInspect?.({
      pluginId: result.pluginId,
      stagedArtifactDir: "/tmp/staged-audit",
      mode: "install",
    });
  }
  return result;
};

export function testPackageLease(onRelease: () => void = () => {}) {
  return {
    identity: {
      scope: "claw-package-lifecycle" as const,
      key: "test-package",
      owner: "test-owner",
    },
    assertCurrent: () => {},
    release: onRelease,
  };
}

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
  readPackageRefs?: (
    ...args: Parameters<typeof readClawPackageRefs>
  ) => ReturnType<typeof readClawPackageRefs> | Promise<ReturnType<typeof readClawPackageRefs>>;
  acquirePackageLease?: typeof packageLease.acquireClawPackageLifecycleLease;
  resolvePlugin?: typeof pluginPreflight.resolveInstalledClawHubPlugin;
};

export type PackageInstallFixtureOptions = NonNullable<Parameters<typeof installPackages>[1]> & {
  deps?: PackageBoundaryFixtures;
};

export async function withPackageBoundaries<T>(
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
    if (deps.resolvePlugin || deps.installPlugin) {
      mocks.push(
        vi
          .spyOn(pluginPreflight, "resolveInstalledClawHubPlugin")
          .mockImplementation(deps.resolvePlugin ?? (async () => ({ status: "missing" }))),
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
