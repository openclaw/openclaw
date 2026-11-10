import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { PluginInstallRuntimeBatch } from "../plugins/install-runtime-batch.js";
import { getPluginCache } from "../plugins/plugin-cache.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { createInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { assertTemplatesLabsEnabled } from "./labs-gate.js";
import { runTemplatePluginBatch } from "./plugin-runtime.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

it.each(["unchanged", "removed", "replaced", "disabled"] as const)(
  "validates the %s plugin requirement after runtime activation before returning to setup",
  async (outcome) => {
    const root = dirs.make("template-activation-owner-");
    const env = {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    };
    let config: OpenClawConfig = {};
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
    await withEnvAsync(env, async () => {
      const original = { source: "path" as const, installPath: root, version: "1" };
      const publishIndex = (records: Record<string, typeof original>) =>
        writeConfigMachineState(
          "plugins.installedIndex",
          {
            revision: 1,
            index: createInstalledPluginIndex({ plugins: [], installRecords: records }),
          },
          { env },
        );
      publishIndex({ fixture: original });
      const reloadPlugins = vi.fn(async () => {
        if (outcome === "removed") {
          publishIndex({});
        }
        if (outcome === "replaced") {
          publishIndex({ fixture: { ...original, version: "2" } });
        }
        if (outcome === "disabled") {
          config = { plugins: { entries: { fixture: { enabled: false } } } };
        }
        return { operationId: "activation", generation: 3, pluginIds: ["fixture"] };
      });
      const nextSetup = vi.fn();
      const runtimeReady = vi.fn<(assertCurrent: () => Promise<void>) => void>();
      const pending = runTemplatePluginBatch(
        {
          env,
          reloadPlugins,
          getCurrentConfig: () => config,
          onPluginRuntimeReady: runtimeReady,
          runtime: {
            log() {},
            error() {},
            exit() {
              throw new Error("unexpected exit");
            },
          },
        },
        ["fixture"],
        async (batch) => {
          batch!.retain("fixture");
          return "requirements-installed";
        },
        (failure) => new Error(String(failure)),
      ).then((result) => {
        nextSetup();
        return result;
      });
      if (outcome === "unchanged") {
        await expect(pending).resolves.toBe("requirements-installed");
        expect(nextSetup).toHaveBeenCalledOnce();
        const assertCurrent = runtimeReady.mock.calls[0]?.[0];
        if (!assertCurrent) {
          throw new Error("Requirement readiness guard was not published");
        }
        publishIndex({});
        await expect(assertCurrent()).rejects.toThrow("no installed owner");
        publishIndex({ fixture: { ...original, version: "2" } });
        await expect(assertCurrent()).rejects.toThrow("owner changed");
        publishIndex({ fixture: original });
        config = { plugins: { entries: { fixture: { enabled: false } } } };
        await expect(assertCurrent()).rejects.toThrow("no longer enabled");
      } else {
        await expect(pending).rejects.toThrow(
          outcome === "removed"
            ? "no installed owner"
            : outcome === "replaced"
              ? "owner changed"
              : "no longer enabled",
        );
        expect(nextSetup).not.toHaveBeenCalled();
      }
      expect(reloadPlugins).toHaveBeenCalledOnce();
    });
  },
);

// These scenarios used to mock the retired Gateway staging protocol. The package
// owner now settles activation before the shared installer may continue setup.
it.each([
  "staging-failure",
  "staging-and-runtime-failure",
  "runtime-failure",
  "prepare-failure",
  "lease-finalizer-failure",
  "authority-lost",
  "policy-drift-at-commit",
  "zero-target-success",
  "zero-target-owner-removed",
  "zero-target-plugin-disabled",
] as const)(
  "settles %s at the package activation boundary before further setup",
  async (outcome) => {
    const root = dirs.make("template-package-settlement-");
    const env = {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    };
    let config: OpenClawConfig = { gateway: { controlUi: { experimental: { templates: true } } } };
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
    await withEnvAsync(env, async () => {
      const publishIndex = (present: boolean) =>
        writeConfigMachineState(
          "plugins.installedIndex",
          {
            revision: 1,
            index: createInstalledPluginIndex({
              plugins: [],
              installRecords: present
                ? { fixture: { source: "path", installPath: root, version: "1" } }
                : {},
            }),
          },
          { env },
        );
      publishIndex(true);
      let authorityActive = true;
      const reloadPlugins = vi.fn(async (_targets, options) => {
        if (outcome === "policy-drift-at-commit") {
          config = { gateway: { controlUi: { experimental: { templates: false } } } };
          options?.commitGuard?.();
        }
        if (outcome === "runtime-failure" || outcome === "staging-and-runtime-failure") {
          throw new Error("Runtime activation failed");
        }
        if (outcome === "authority-lost") {
          authorityActive = false;
        }
        return { operationId: "activation", generation: 3, pluginIds: ["fixture"] };
      });
      const zeroTarget = outcome.startsWith("zero-target");
      const nextSetup = vi.fn();
      const pending = runTemplatePluginBatch(
        {
          env,
          reloadPlugins,
          getCurrentConfig: () => config,
          assertForwardCurrent: () => {
            if (!authorityActive) {
              throw new Error("Add authority ended");
            }
            assertTemplatesLabsEnabled(config);
          },
          prepareEffect: async () => {
            if (outcome === "zero-target-owner-removed") {
              publishIndex(false);
            }
            if (outcome === "zero-target-plugin-disabled") {
              config = { ...config, plugins: { entries: { fixture: { enabled: false } } } };
            }
          },
          runtime: {
            log() {},
            error() {},
            exit() {
              throw new Error("Unexpected exit");
            },
          },
        },
        ["fixture"],
        async (batch) => {
          if (!zeroTarget) {
            batch!.retain(outcome === "prepare-failure" ? "missing" : "fixture");
          }
          if (outcome === "lease-finalizer-failure") {
            getPluginCache().instances.add({
              pluginId: "fixture",
              quiesce: () => true,
              dispose: async () => {
                throw new Error("Plugin cache finalizer failed");
              },
            });
          }
          if (outcome.startsWith("staging-")) {
            throw new Error("Package installation failed");
          }
          return "installed";
        },
        (failure, operation) =>
          new Error(
            [!operation.ok ? String(operation.error) : undefined, String(failure)]
              .filter(Boolean)
              .join("\n"),
          ),
      ).then((value) => {
        nextSetup();
        return value;
      });
      if (outcome === "zero-target-success") {
        await expect(pending).resolves.toBe("installed");
        expect(nextSetup).toHaveBeenCalledOnce();
      } else {
        const expected = {
          "staging-failure": "Package installation failed",
          "staging-and-runtime-failure": "Runtime activation failed",
          "runtime-failure": "Runtime activation failed",
          "prepare-failure": "no longer installed",
          "lease-finalizer-failure": "Plugin cache resource",
          "authority-lost": "Add authority ended",
          "policy-drift-at-commit": "Templates",
          "zero-target-owner-removed": "no installed owner",
          "zero-target-plugin-disabled": "no longer enabled",
        }[outcome];
        await expect(pending).rejects.toThrow(expected);
        expect(nextSetup).not.toHaveBeenCalled();
      }
      expect(reloadPlugins).toHaveBeenCalledTimes(
        zeroTarget || outcome === "prepare-failure" || outcome === "lease-finalizer-failure"
          ? 0
          : 1,
      );
    });
  },
);

it("refuses runtime batch handoff while any plugin lease is held", async () => {
  const root = dirs.make("template-batch-lease-");
  const env = { OPENCLAW_STATE_DIR: root };
  await withEnvAsync(env, async () => {
    const batch = new PluginInstallRuntimeBatch({ env }, vi.fn());
    await withPluginLifecycleLease({ env }, async (lease) => {
      await batch.prepare(lease);
      await expect(batch.finish(() => {})).rejects.toThrow(
        "Plugin batch was not prepared or its handoff already started",
      );
    });
    batch.close();
  });
});
