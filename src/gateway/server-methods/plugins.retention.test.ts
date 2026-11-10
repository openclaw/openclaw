import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { PluginsInspectResultSchema } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { emptyInstalledPluginComponents } from "../../plugins/installed-plugin-components.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { withPluginRetentionOwner } from "../../plugins/plugin-retention-diagnostics.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import {
  captureActivePluginRegistrySnapshot,
  clearActivePluginRegistry,
  createPluginRegistryOwner,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
  waitForPluginRegistryRetirement,
} from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { gatewayConnect } from "../server/client-fixtures.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const inspectManagedPlugin = vi.hoisted(() => vi.fn());
// mock-isolation: Inventory I/O must not load installed plugins or operator state.
vi.mock("../../plugins/management-service.js", () => ({
  inspectManagedPlugin,
  listManagedPlugins: vi.fn(),
}));

const { pluginsHandlers } = await import("./plugins.js");
const inspection = {
  ok: true,
  plugin: { id: "retained-plugin", name: "Retention fixture", installed: true, enabled: true },
  declared: {
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
  },
  grants: {
    hooks: {
      allowPromptInjection: { effective: false },
      allowConversationAccess: { effective: false },
    },
  },
  components: emptyInstalledPluginComponents(),
};
const acquisitionOwner = {
  agentId: "fixture",
  sessionKey: "private-session",
  runId: "private-run",
};

const adminClient = () => ({
  connect: gatewayConnect(["operator.admin"], { id: "test", mode: "test" }, 3),
});

// Real instances retain host work; no plugin module needs to be evaluated.
function retainedPlugin(registry = createEmptyPluginRegistry(), id = inspection.plugin.id) {
  const record = createPluginRecord({ id });
  registry.plugins.push(record);
  const instance = new PluginInstance(id, { record, registry });
  const release = withPluginRetentionOwner(acquisitionOwner, () =>
    instance.retainWork("prepared-generation-lease"),
  );
  onTestFinished(release);
  return { registry, release, run: vi.spyOn(instance, "run") };
}

async function inspect(
  registry: PluginRegistry,
  overrides: Partial<GatewayRequestHandlerOptions> = {},
) {
  const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
  const params = overrides.params ?? { pluginId: inspection.plugin.id };
  await withPluginRuntimeGatewayRequestScope(
    { pluginRegistry: registry, isWebchatConnect: () => false },
    () =>
      pluginsHandlers["plugins.inspect"]!({
        req: { type: "req", id: "retention-inspection", method: "plugins.inspect", params },
        params,
        client: adminClient(),
        isWebchatConnect: () => false,
        context: { getRuntimeConfig: () => ({}) } as GatewayRequestHandlerOptions["context"],
        ...overrides,
        respond,
      }),
  );
  expect(respond).toHaveBeenCalledExactlyOnceWith(true, expect.any(Object), undefined);
  const response = respond.mock.calls[0]![1];
  expect(Value.Check(PluginsInspectResultSchema, response)).toBe(true);
  return response;
}

beforeEach(() => inspectManagedPlugin.mockReset().mockResolvedValue(inspection));
afterEach(() => vi.restoreAllMocks());

describe("plugins.inspect runtime retention disclosure", () => {
  it("shows local owners without execution and removes released acquisitions", async () => {
    const fixture = retainedPlugin();
    expect(await inspect(fixture.registry)).toMatchObject({
      runtimeRetention: {
        pluginId: inspection.plugin.id,
        total: 1,
        omitted: 0,
        references: [
          { kind: "work", reason: "prepared-generation-lease", owner: acquisitionOwner },
        ],
      },
    });
    fixture.release();
    expect(await inspect(fixture.registry)).toMatchObject({
      runtimeRetention: { total: 0, omitted: 0, references: [] },
    });
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it("returns null when no runtime instance exists", async () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(createPluginRecord({ id: inspection.plugin.id }));
    expect(await inspect(registry)).toMatchObject({ runtimeRetention: null });
  });

  it.each([false, true])(
    "reports a retained predecessor with a current instance: %s",
    async (hasCurrent) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const previous = captureActivePluginRegistrySnapshot();
        const fixture = retainedPlugin();
        const successor = createEmptyPluginRegistry();
        const current = hasCurrent ? retainedPlugin(successor) : undefined;
        const owner = createPluginRegistryOwner(fixture.registry);
        setActivePluginRegistry(fixture.registry);
        try {
          setActivePluginRegistry(successor);
          owner.publish(successor, async () => {});
          expect(await inspect(successor)).toMatchObject({
            runtimeRetention: {
              predecessors: [{ pluginId: inspection.plugin.id, total: 1 }],
            },
          });
          fixture.release();
          await waitForPluginRegistryRetirement(fixture.registry);
          const response = await inspect(successor);
          expect(response).toMatchObject({
            runtimeRetention: hasCurrent ? { pluginId: inspection.plugin.id, total: 1 } : null,
          });
          expect(response).not.toHaveProperty("runtimeRetention.predecessors");
          expect(fixture.run).not.toHaveBeenCalled();
        } finally {
          fixture.release();
          current?.release();
          await owner.close();
          restoreActivePluginRegistrySnapshot(previous);
        }
      });
    },
  );

  it("does not disclose another Gateway's predecessor to owned or ownerless requests", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const previous = captureActivePluginRegistrySnapshot();
      const fixture = retainedPlugin();
      const successor = createEmptyPluginRegistry();
      const owner = createPluginRegistryOwner(fixture.registry);
      setActivePluginRegistry(fixture.registry);
      let unrelatedOwner: ReturnType<typeof createPluginRegistryOwner> | undefined;
      const unrelated = retainedPlugin();
      try {
        setActivePluginRegistry(successor);
        owner.publish(successor, async () => {});
        unrelatedOwner = createPluginRegistryOwner(unrelated.registry);
        setActivePluginRegistry(unrelated.registry);

        const response = await inspect(unrelated.registry);
        expect(response).toMatchObject({ runtimeRetention: { total: 1 } });
        expect(response).not.toHaveProperty("runtimeRetention.predecessors");
        expect(await inspect(createEmptyPluginRegistry())).toMatchObject({
          runtimeRetention: null,
        });
      } finally {
        fixture.release();
        unrelated.release();
        await Promise.all([owner.close(), unrelatedOwner?.close()]);
        restoreActivePluginRegistrySnapshot(previous);
      }
    });
  });

  it.each(["no client", "read-only operator", "remote package"])(
    "omits cross-session diagnostics for %s",
    async (visibility) => {
      const fixture = retainedPlugin();
      const client = adminClient();
      if (visibility === "read-only operator") {
        client.connect.scopes = ["operator.read"];
      }
      const response = await inspect(fixture.registry, {
        params:
          visibility === "remote package"
            ? { source: "clawhub", packageName: "community/plugin" }
            : { pluginId: inspection.plugin.id },
        client: visibility === "no client" ? null : client,
      });
      expect(response).toEqual({ ...inspection, decisions: [] });
    },
  );

  it("rechecks live authority after awaiting inventory", async () => {
    const fixture = retainedPlugin();
    let current = true;
    inspectManagedPlugin.mockImplementationOnce(async () => {
      current = false;
      return inspection;
    });
    const hasCurrentClientAuthority = vi.fn(() => current);
    expect(await inspect(fixture.registry, { hasCurrentClientAuthority })).toEqual({
      ...inspection,
      decisions: [],
    });
    expect(hasCurrentClientAuthority).toHaveReturnedWith(false);
  });

  it("uses the request registry after another Gateway publishes during inventory", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const previous = captureActivePluginRegistrySnapshot();
      const request = retainedPlugin();
      const unrelated = retainedPlugin();
      const entered = createDeferredCore();
      const catalog = createDeferredCore<typeof inspection>();
      inspectManagedPlugin.mockImplementationOnce(() => {
        entered.resolve();
        return catalog.promise;
      });
      setActivePluginRegistry(request.registry);
      const pending = inspect(request.registry);
      try {
        await awaitGateBeforeSettlement(entered.promise, pending, "inspection skipped inventory");
        // A colliding ID in the process projection cannot replace this request's owner.
        setActivePluginRegistry(unrelated.registry);
        unrelated.release();
        catalog.resolve(inspection);
        expect(await pending).toMatchObject({
          runtimeRetention: {
            pluginId: inspection.plugin.id,
            references: expect.arrayContaining([
              expect.objectContaining({ owner: acquisitionOwner }),
            ]),
          },
        });
      } finally {
        catalog.resolve(inspection);
        await Promise.allSettled([pending]);
        request.release();
        unrelated.release();
        try {
          await clearActivePluginRegistry();
        } finally {
          restoreActivePluginRegistrySnapshot(previous);
        }
      }
    });
  });
});
