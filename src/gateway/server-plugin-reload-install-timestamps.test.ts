import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  buildGatewayReloadPlan,
  resolveConfigReloadMetadata,
  resolvePluginInstallReloadMetadata,
} from "./config-reload-plan.js";
import { resolvePluginReloadReplacementIds } from "./server-plugin-reload-recovery.js";
import type { GatewayReloadHandlerParams } from "./server-reload-contracts.js";
import {
  createHotReloadHandlerTestParams,
  makePluginReloadResult,
} from "./server-reload-handlers.config.test-support.js";
import { createGatewayReloadHandlers } from "./server-reload-hot.js";

const EMPTY_DECLARED_SURFACE = {
  channels: [],
  providers: [],
  tools: [],
  contracts: [],
  hooks: [],
  mcpServers: [],
  cliCommands: [],
  cliBackends: [],
  skills: [],
  dangerousConfigFlags: [],
};

const BASE_INSTALL = {
  source: "npm" as const,
  spec: "@openclaw/bystander",
  installPath: "/tmp/openclaw/plugins/bystander",
  installedAt: "2026-04-22T00:00:00.000Z",
  resolvedAt: "2026-04-22T00:00:00.000Z",
  acceptedSurface: { ...EMPTY_DECLARED_SURFACE, tools: ["bystander.read"] },
  acceptedSurfaceHash: "hash-v1",
  acceptedSurfaceAt: "2026-04-22T00:00:00.000Z",
  acceptedSurfaceIntegrity: "sha512-v1",
};

describe("plugin reload install timestamp handling", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
  });

  it("treats acceptedSurfaceAt like installedAt/resolvedAt when capability approval is unchanged", () => {
    const prevConfig: OpenClawConfig = {
      plugins: {
        installs: { bystander: BASE_INSTALL },
        entries: { target: { enabled: false } },
      },
    };
    const nextConfig: OpenClawConfig = {
      plugins: {
        installs: {
          bystander: {
            ...BASE_INSTALL,
            installedAt: "2026-04-22T00:05:00.000Z",
            resolvedAt: "2026-04-22T00:05:00.000Z",
            acceptedSurfaceAt: "2026-04-22T00:05:00.000Z",
          },
        },
        entries: { target: { enabled: true } },
      },
    };

    expect(resolveConfigReloadMetadata("plugins.installs.bystander.acceptedSurfaceAt")).toEqual({
      kind: "none",
    });

    const installMetadata = resolvePluginInstallReloadMetadata(prevConfig, nextConfig);
    expect(installMetadata.forceChangedPaths).toEqual([]);
    expect(installMetadata.noopPaths).toEqual([
      "plugins.installs.bystander.installedAt",
      "plugins.installs.bystander.resolvedAt",
      "plugins.installs.bystander.acceptedSurfaceAt",
    ]);

    const plan = buildGatewayReloadPlan(
      [
        "plugins.installs.bystander.installedAt",
        "plugins.installs.bystander.resolvedAt",
        "plugins.installs.bystander.acceptedSurfaceAt",
        "plugins.entries.target.enabled",
      ],
      {
        ...installMetadata,
        pluginLifecycle: { pluginIds: ["target"], reason: "enable", operationId: "enable-1" },
      },
    );

    expect(plan.noopPaths).toEqual([
      "plugins.installs.bystander.installedAt",
      "plugins.installs.bystander.resolvedAt",
      "plugins.installs.bystander.acceptedSurfaceAt",
    ]);
    expect(plan.reloadPluginPaths).toEqual(["plugins.entries.target.enabled"]);
  });

  it("keeps acceptedSurfaceAt actionable when capability approval changes", () => {
    const prevConfig: OpenClawConfig = {
      plugins: {
        installs: { bystander: BASE_INSTALL },
      },
    };
    const nextConfig: OpenClawConfig = {
      plugins: {
        installs: {
          bystander: {
            ...BASE_INSTALL,
            acceptedSurface: {
              ...EMPTY_DECLARED_SURFACE,
              tools: ["bystander.read", "bystander.write"],
            },
            acceptedSurfaceHash: "hash-v2",
            acceptedSurfaceAt: "2026-04-22T00:05:00.000Z",
            acceptedSurfaceIntegrity: "sha512-v2",
          },
        },
      },
    };

    const installMetadata = resolvePluginInstallReloadMetadata(prevConfig, nextConfig);
    expect(installMetadata.noopPaths).toEqual([]);
    expect(installMetadata.forceChangedPaths).toContain(
      "plugins.installs.bystander.acceptedSurfaceAt",
    );

    const plan = buildGatewayReloadPlan(
      [
        "plugins.installs.bystander.acceptedSurface",
        "plugins.installs.bystander.acceptedSurfaceHash",
        "plugins.installs.bystander.acceptedSurfaceAt",
        "plugins.installs.bystander.acceptedSurfaceIntegrity",
      ],
      installMetadata,
    );

    expect(plan.reloadPlugins).toBe(true);
    expect(plan.noopPaths).toEqual([]);
    expect(plan.reloadPluginPaths).toContain("plugins.installs.bystander.acceptedSurfaceAt");
  });

  it.each(["with-target-entry-diff", "timestamps-only-diff"] as const)(
    "excludes pending install timestamp no-ops from reloadPlugins changedPaths (%s)",
    async (mode) => {
      const prevConfig: OpenClawConfig = {
        plugins: {
          installs: { bystander: BASE_INSTALL },
          entries: { target: { enabled: false } },
        },
      };
      const nextConfig: OpenClawConfig = {
        plugins: {
          installs: {
            bystander: {
              ...BASE_INSTALL,
              installedAt: "2026-04-22T00:05:00.000Z",
              resolvedAt: "2026-04-22T00:05:00.000Z",
              acceptedSurfaceAt: "2026-04-22T00:05:00.000Z",
            },
          },
          entries: { target: { enabled: true } },
        },
      };

      const installMetadata = resolvePluginInstallReloadMetadata(prevConfig, nextConfig);
      setRuntimeConfigSnapshot(prevConfig);
      const changedPaths = [
        "plugins.installs.bystander.installedAt",
        "plugins.installs.bystander.resolvedAt",
        "plugins.installs.bystander.acceptedSurfaceAt",
        ...(mode === "with-target-entry-diff" ? ["plugins.entries.target.enabled"] : []),
      ];
      const plan = buildGatewayReloadPlan(changedPaths, {
        ...installMetadata,
        pluginLifecycle: { pluginIds: ["target"], reason: "enable", operationId: "enable-2" },
      });

      const previousRegistry = createEmptyPluginRegistry();
      previousRegistry.plugins.push(
        createPluginRecord({ id: "bystander", status: "error", error: "quarantined" }),
        createPluginRecord({ id: "target", enabled: false, status: "disabled" }),
      );

      let replacementIds: Set<string> | undefined;
      let forwardedChangedPaths: readonly string[] | undefined;
      const params = createHotReloadHandlerTestParams({
        scheduler: createTestGatewayScheduler(),
        deps: {} as GatewayReloadHandlerParams["deps"],
        reloadPlugins: async (reloadParams) => {
          forwardedChangedPaths = reloadParams.changedPaths;
          replacementIds = resolvePluginReloadReplacementIds(
            previousRegistry,
            [
              ...(reloadParams.pluginLifecycle?.pluginIds ?? []),
              ...(reloadParams.reloadPluginIds ?? []),
            ],
            reloadParams.changedPaths,
          );
          await reloadParams.commitRuntime();
          return makePluginReloadResult();
        },
      });
      const handlers = createGatewayReloadHandlers(params);
      try {
        await handlers.applyHotReload(plan, nextConfig);
      } finally {
        handlers.stopRestartRetries();
      }

      expect(forwardedChangedPaths).toEqual(
        mode === "with-target-entry-diff" ? ["plugins.entries.target.enabled"] : [],
      );
      expect(replacementIds).toBeDefined();
      expect(replacementIds?.has("target")).toBe(true);
      expect(replacementIds?.has("bystander")).toBe(false);
    },
  );
});
