import { isProxy } from "node:util/types";
import { expect, it } from "vitest";
import { getRegisteredAgentHarness } from "../agents/harness/registry.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { createUnavailableRuntime } from "../plugins/api-builder.js";
import { createRuntimeTestRegistry } from "../plugins/registry-runtime.test-helpers.js";
import {
  captureActivePluginRegistrySnapshot,
  disposePluginRegistryInstances,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { isDeeplyFrozenPlainData } from "../shared/immutable-data.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createTestProjection,
  holdForeground,
} from "./session-row-projection.read-fixture.test-support.js";
import { listProjectedSessions } from "./session-utils-list.js";

it("materializes hosted-workspace metadata from a managed harness without freezing its view", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {
      agents: { entries: { main: {} }, defaults: { model: "example/model" } },
    };
    setRuntimeConfigSnapshot(cfg);
    const builder = createRuntimeTestRegistry(createUnavailableRuntime("setup-only"));
    const record = createPluginRecord({ id: "hosted-fixture" });
    const workspaceEnvironment = { kind: "provider-hosted" as const, label: "Hosted fixture" };
    builder.createApi(record, { config: cfg }).registerAgentHarness({
      id: "hosted-fixture",
      label: "Hosted fixture",
      workspaceEnvironment,
      supports: () => ({ supported: true }),
      async runAttempt() {
        throw new Error("Row presentation must not run a model");
      },
    });
    const previousRegistry = captureActivePluginRegistrySnapshot();
    setActivePluginRegistry(builder.registry);
    try {
      const managedEnvironment =
        getRegisteredAgentHarness("hosted-fixture")!.harness.workspaceEnvironment!;
      expect(isProxy(managedEnvironment)).toBe(true);
      const key = "agent:main:dashboard:hosted-fixture";
      const entry = {
        sessionId: "hosted-fixture-session",
        updatedAt: 1,
        agentHarnessId: "hosted-fixture",
        modelSelectionLocked: true,
      };
      replaceSessionEntrySync({ agentId: "main", sessionKey: key }, entry);
      using _ = holdForeground();
      using projection = await createTestProjection({ cfg, modelCatalog: [] });
      const query = { agentId: "main", key };
      const listed = await listProjectedSessions({ projection, opts: {} });
      const row = projection.snapshot(query).row!;
      expect(row.agentRuntime?.workspaceEnvironment).toEqual({
        kind: "provider-hosted",
        label: "Hosted fixture",
      });
      expect(isDeeplyFrozenPlainData(row.agentRuntime)).toBe(true);
      expect(row.agentRuntime?.workspaceEnvironment).not.toBe(managedEnvironment);
      expect(Object.isFrozen(workspaceEnvironment)).toBe(false);
      expect(Object.isExtensible(managedEnvironment)).toBe(true);
      expect(listed.sessions).toEqual([
        expect.objectContaining({ key, agentRuntime: row.agentRuntime }),
      ]);
      // A committed session update must also survive the resident refresh path.
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        { ...entry, updatedAt: 2, label: "Updated fixture" },
      );
      await projection.ensureMaterialized();
      expect(projection.snapshot(query).row).toMatchObject({
        label: "Updated fixture",
        agentRuntime: {
          workspaceEnvironment: { kind: "provider-hosted", label: "Hosted fixture" },
        },
      });
    } finally {
      restoreActivePluginRegistrySnapshot(previousRegistry);
      await disposePluginRegistryInstances(builder.registry);
    }
  });
});
