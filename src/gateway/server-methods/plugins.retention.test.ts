import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { withPluginRetentionOwner } from "../../plugins/plugin-retention-diagnostics.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import {
  captureActivePluginRegistrySnapshot,
  createPluginRegistryOwner,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./types.js";

const inspectManagedPlugin = vi.hoisted(() => vi.fn());
// mock-isolation: Inventory I/O must not load installed plugins or operator state.
vi.mock("../../plugins/management-service.js", () => ({
  inspectManagedPlugin,
  listManagedPlugins: vi.fn(),
}));

const { pluginsHandlers } = await import("./plugins.js");
const inspection = { plugin: { id: "retained-plugin", installed: true, enabled: true } };
const acquisitionOwner = {
  agentId: "fixture",
  sessionKey: "private-session",
  runId: "private-run",
};

// Use accepted handshake facts without creating a transport or starting a Gateway.
function adminClient(): GatewayClient {
  return {
    connect: {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: "test", version: "test", platform: "test", mode: "test" },
      role: "operator",
      scopes: ["operator.admin"],
    },
  };
}

// Real instances retain host work; no plugin module needs to be evaluated.
function retainedPlugin(registry = createEmptyPluginRegistry(), id = inspection.plugin.id) {
  const record = createPluginRecord({ id });
  registry.plugins.push(record);
  const instance = new PluginInstance(id, { record, registry });
  const release = withPluginRetentionOwner(acquisitionOwner, () =>
    instance.retainWork("prepared-generation-lease"),
  );
  onTestFinished(release);
  const run = vi.spyOn(instance, "run");
  return { registry, instance, release, run };
}

// Exercise validation, async inventory, scope selection, and response composition together.
async function inspect(
  registry: PluginRegistry,
  overrides: Partial<GatewayRequestHandlerOptions> = {},
) {
  const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
  const params = overrides.params ?? { pluginId: inspection.plugin.id };
  await withPluginRuntimeGatewayRequestScope(
    { pluginRegistry: registry, isWebchatConnect: () => false },
    () =>
      expectDefined(
        pluginsHandlers["plugins.inspect"],
        "plugins.inspect handler",
      )({
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
  return respond.mock.calls[0]![1];
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
      expect(fixture.run).not.toHaveBeenCalled();
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
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it("uses the request registry after another Gateway publishes during inventory", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const previous = captureActivePluginRegistrySnapshot();
      const request = retainedPlugin();
      const unrelated = retainedPlugin();
      const requestOwner = createPluginRegistryOwner(request.registry);
      const unrelatedOwner = createPluginRegistryOwner(unrelated.registry);
      const entered = createDeferredCore();
      const catalog = createDeferredCore<typeof inspection>();
      inspectManagedPlugin.mockImplementationOnce(() => {
        entered.resolve();
        return catalog.promise;
      });
      setActivePluginRegistry(request.registry);
      const pending = inspect(requestOwner.registry);
      try {
        await awaitGateBeforeSettlement(entered.promise, pending, "inspection skipped inventory");
        // A colliding ID in the process projection cannot replace this request's owner.
        setActivePluginRegistry(unrelated.registry);
        unrelated.release();
        catalog.resolve(inspection);
        expect(await pending).toMatchObject({
          runtimeRetention: {
            pluginId: inspection.plugin.id,
            total: 1,
            references: [{ owner: acquisitionOwner }],
          },
        });
        expect(request.run).not.toHaveBeenCalled();
        expect(unrelated.run).not.toHaveBeenCalled();
      } finally {
        catalog.resolve(inspection);
        await Promise.allSettled([pending]);
        request.release();
        unrelated.release();
        try {
          await Promise.all([requestOwner.close(), unrelatedOwner.close()]);
        } finally {
          restoreActivePluginRegistrySnapshot(previous);
        }
      }
    });
  });
});
