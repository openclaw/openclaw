import { vi } from "vitest";
import type { installPluginFromClawHub } from "../plugins/clawhub.js";
import * as managedInstall from "../plugins/management-mutations.js";
import * as managedUninstall from "../plugins/management-uninstall.js";
import * as pluginPreflight from "../plugins/plugin-install-preflight.js";
import * as skillLifecycle from "../skills/lifecycle/clawhub.js";
import * as packageLease from "../state/claw-package-lifecycle-lease.js";
import * as addState from "./add-state-write.js";
import { installTemplatePackages as installPackages } from "./packages.js";
import * as pluginProbe from "./plugin-capability-probe.js";
import type { readTemplatePackageRefs } from "./provenance.js";

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
    assertOwned: async () => {},
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
    Parameters<typeof pluginProbe.probeTemplatePluginArtifact>[2]
  >["probePlugin"];
  inspectPluginCapabilities?: typeof pluginProbe.inspectTemplatePluginCapabilities;
  installSkill?: typeof skillLifecycle.installSkillFromClawHub;
  preflightPlugin?: typeof pluginPreflight.preflightPluginInstall;
  preflightSkill?: typeof skillLifecycle.preflightSkillFromClawHub;
  readPackageRefs?: (
    ...args: Parameters<typeof readTemplatePackageRefs>
  ) =>
    | ReturnType<typeof readTemplatePackageRefs>
    | Promise<ReturnType<typeof readTemplatePackageRefs>>;
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
  function mockIf<Dependency>(
    dependency: Dependency | undefined,
    create: (value: Dependency) => { mockRestore(): void },
  ) {
    if (dependency !== undefined) {
      mocks.push(create(dependency));
    }
  }
  try {
    mockIf(deps.installPlugin, (install) =>
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
    mockIf(deps.uninstallPlugin, (uninstall) =>
      vi.spyOn(managedUninstall, "uninstallPluginWithPolicy").mockImplementation(async (params) => {
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
    mockIf(deps.preflightPlugin, (implementation) =>
      vi.spyOn(pluginPreflight, "preflightPluginInstall").mockImplementation(implementation),
    );
    mockIf(deps.installSkill, (implementation) =>
      vi.spyOn(skillLifecycle, "installSkillFromClawHub").mockImplementation(implementation),
    );
    mockIf(deps.preflightSkill, (implementation) =>
      vi.spyOn(skillLifecycle, "preflightSkillFromClawHub").mockImplementation(implementation),
    );
    mockIf(deps.readPackageRefs, (read) =>
      vi
        .spyOn(addState, "readTemplatePackageRefsForAdd")
        .mockImplementation(async (...args) => await read(...args)),
    );
    mockIf(deps.acquirePackageLease, (implementation) =>
      vi.spyOn(packageLease, "acquireClawPackageLifecycleLease").mockImplementation(implementation),
    );
    if (deps.resolvePlugin || deps.installPlugin) {
      mocks.push(
        vi
          .spyOn(pluginPreflight, "resolveInstalledClawHubPlugin")
          .mockImplementation(deps.resolvePlugin ?? (async () => ({ status: "missing" }))),
      );
    }
    if (deps.probePlugin || deps.inspectPluginCapabilities) {
      const probe = pluginProbe.probeTemplatePluginArtifact;
      mocks.push(
        vi
          .spyOn(pluginProbe, "probeTemplatePluginArtifact")
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

export function installTemplatePackages(
  plan: Parameters<typeof installPackages>[0],
  { deps, ...options }: PackageInstallFixtureOptions = {},
) {
  return withPackageBoundaries(() => installPackages(plan, options), deps);
}
