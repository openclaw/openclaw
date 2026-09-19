import { describe, expect, it } from "vitest";
import {
  assertTaskflowSnapshot,
  createTaskflowFixture,
  normalizeTaskflowSnapshot,
  TASKFLOW_PLUGIN_MANIFEST,
} from "../../scripts/e2e/lib/upgrade-survivor/taskflow-restoration-fixture.mjs";
import { resolveWorkerCellExport } from "../../scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs";
import { resolveGatewayStartupPluginPlanFromRegistry } from "../../src/plugins/gateway-startup-plugin-plan.js";
import type { PluginManifestRecord } from "../../src/plugins/manifest-registry.js";
import type { PluginRegistrySnapshot } from "../../src/plugins/plugin-registry-snapshot.js";

describe("taskflow survivor evidence", () => {
  it("loads the SDK fixture through the actual Gateway startup plan", () => {
    const manifest: PluginManifestRecord = {
      ...TASKFLOW_PLUGIN_MANIFEST,
      origin: "config",
      channels: [],
      providers: [],
      cliBackends: [],
      skills: [],
      hooks: [],
      rootDir: "/fixtures/taskflow-survivor",
      source: "/fixtures/taskflow-survivor/taskflow-restoration-plugin.mjs",
      manifestPath: "/fixtures/taskflow-survivor/openclaw.plugin.json",
    };
    const index: PluginRegistrySnapshot = {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: "test",
      generatedAtMs: 0,
      installRecords: {},
      diagnostics: [],
      plugins: [
        {
          pluginId: manifest.id,
          manifestPath: manifest.manifestPath,
          manifestHash: "fixture",
          rootDir: manifest.rootDir,
          origin: manifest.origin,
          enabled: true,
          startup: {
            sidecar: manifest.activation?.onStartup === true,
            memory: false,
            agentHarnesses: [],
            configPaths: [],
          },
          compat: [],
        },
      ],
    };
    const plan = resolveGatewayStartupPluginPlanFromRegistry({
      config: { plugins: { allow: [manifest.id], entries: { [manifest.id]: { enabled: true } } } },
      env: {},
      index,
      manifestRegistry: { plugins: [manifest], diagnostics: [] },
    });
    expect(plan.pluginIds).toEqual([manifest.id]);
  });

  it("compares complete persisted records regardless of owner Map insertion order", () => {
    const fixture = createTaskflowFixture(1_800_000_000_000);
    const snapshot = {
      tasks: new Map(fixture.tasks.toReversed().map((task) => [task.taskId, task])),
      flows: new Map(fixture.flows.toReversed().map((flow) => [flow.flowId, flow])),
      deliveryStates: new Map(fixture.deliveryStates.map((row) => [row.taskId, row])),
    };
    expect(() => assertTaskflowSnapshot(snapshot, fixture)).not.toThrow();
    expect(normalizeTaskflowSnapshot(snapshot)).toEqual(fixture);
    const changed = structuredClone(fixture);
    for (const task of changed.tasks) {
      task.detail.payload.enabled = false;
    }
    expect(() => assertTaskflowSnapshot(changed, fixture)).toThrow();
    const missing = structuredClone(fixture);
    missing.deliveryStates.pop();
    expect(() => assertTaskflowSnapshot(missing, fixture)).toThrow();
    const revision = structuredClone(fixture);
    for (const flow of revision.flows) {
      flow.revision += 1;
    }
    expect(() => assertTaskflowSnapshot(revision, fixture)).toThrow();
  });

  it("seeds only settled tasks with existing parent flows and no execution owner", () => {
    const now = 1_800_000_000_000;
    const fixture = createTaskflowFixture(now);
    expect(fixture.tasks).toHaveLength(3);
    for (const task of fixture.tasks) {
      expect(task.status).toBe("succeeded");
      expect(task.notifyPolicy).toBe("silent");
      expect(task.deliveryStatus).toBe("not_applicable");
      expect(task.endedAt).toBeLessThan(now);
      expect(task.cleanupAfter).toBeGreaterThan(now);
      expect(task).not.toHaveProperty("executionOwner");
      expect(task).not.toHaveProperty("childSessionKey");
      expect(fixture.flows.some((flow) => flow.flowId === task.parentFlowId)).toBe(true);
    }
  });

  it("resolves named or minified owner exports without substituting another symbol", () => {
    expect(resolveWorkerCellExport("export { loadSnapshot, other as a };", "loadSnapshot")).toBe(
      "loadSnapshot",
    );
    expect(
      resolveWorkerCellExport("export { loadSnapshot as c, close as r };", "loadSnapshot"),
    ).toBe("c");
    expect(
      resolveWorkerCellExport("export { other as loadSnapshot };", "loadSnapshot"),
    ).toBeUndefined();
    expect(
      resolveWorkerCellExport("export { loadSnapshot } from './different.mjs';", "loadSnapshot"),
    ).toBeUndefined();
    expect(() =>
      resolveWorkerCellExport("export { loadSnapshot as a, loadSnapshot as b };", "loadSnapshot"),
    ).toThrow("Ambiguous");
  });
});
