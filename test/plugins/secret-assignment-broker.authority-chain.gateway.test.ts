/**
 * Production-path authority-chain proof for the secret-assignment broker.
 *
 * Unlike the unit suites, this exercises the real path end to end:
 * - persisted assignment writes through actual Gateway RPC admission
 * - authorized vs unauthorized admin writes rejected before persistence
 * - self inventory identity derived from the authenticated client
 * - allowed assigned launch and unassigned denial through the real hook runner
 * - deferred revocation re-checked at the final spawn boundary
 * - restart/reload persistence through the host keyed store
 *
 * Only synthetic names and fake secret sentinels appear here; no real values.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import brokerPlugin from "../../extensions/secret-assignment-broker/index.js";
import { authorizeSecretEnvForExec } from "../../src/agents/bash-tools.exec-secret-authorize.js";
import {
  createPluginGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../../src/gateway/methods/registry.js";
import { ADMIN_SCOPE, READ_SCOPE } from "../../src/gateway/operator-scopes.js";
import { handleGatewayRequest } from "../../src/gateway/server-methods.js";
import { createPluginStateKeyedStoreForTests } from "../../src/plugin-sdk/plugin-state-test-runtime.js";
import { resetPluginStateStoreForTests } from "../../src/plugin-state/plugin-state-store.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../src/plugins/hook-runner-global.js";
import { runPluginRegisterSyncInRegistry } from "../../src/plugins/loader-module-runtime.js";
import type { PluginRegistry } from "../../src/plugins/registry-types.js";
import { createPluginRegistry } from "../../src/plugins/registry.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../src/plugins/runtime.js";
import type { PluginRuntime } from "../../src/plugins/runtime/types.js";
import { createPluginRecord } from "../../src/plugins/status.test-fixtures.js";
import type { SecretStoreExecEnvironment } from "../../src/secrets/store/secret-store.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

const PLUGIN_ID = "secret-assignment-broker";
const NAMESPACE = "agent-assignments";
/** A resolved exec snapshot with synthetic names and sentinels only. */
function storeEnv(): SecretStoreExecEnvironment {
  return {
    env: { DEPLOY_ENV_A: "synthetic-a", DEPLOY_ENV_B: "synthetic-b" },
    secretSentinels: { DEPLOY_SEC_C: "SENTINEL_DEPLOY_SEC_C" },
    secretEgressBindings: [
      { name: "DEPLOY_SEC_C", sentinel: "SENTINEL_DEPLOY_SEC_C", allowedHosts: ["x.test"] },
    ],
  };
}

type Harness = {
  registry: PluginRegistry;
  keyed: ReturnType<typeof createPluginStateKeyedStoreForTests<unknown>>;
  respond: ReturnType<typeof vi.fn>;
};

/** Builds a real plugin registry with the broker registered against a host keyed store. */
function buildHarness(): Harness {
  // Pre-open the plugin's own namespace with the exact options the plugin uses
  // (`createStore` in index.ts), so the option policy sees one consistent
  // signature across registration and later reads.
  const keyed = createPluginStateKeyedStoreForTests<unknown>(PLUGIN_ID, {
    namespace: NAMESPACE,
    maxEntries: 10_000,
  });
  const runtime = {
    state: { openKeyedStore: () => keyed },
  } as unknown as PluginRuntime;
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: PLUGIN_ID,
    source: `/source/extensions/${PLUGIN_ID}/index.ts`,
    origin: "bundled",
    enabled: true,
    configSchema: false,
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {} });
  runPluginRegisterSyncInRegistry(brokerPlugin.register!, api, builder.registry, PLUGIN_ID);

  setActivePluginRegistry(builder.registry);
  initializeGlobalHookRunner(builder.registry);

  return { registry: builder.registry, keyed, respond: vi.fn() };
}

function methodRegistry(registry: PluginRegistry) {
  return createGatewayMethodRegistry(createPluginGatewayMethodDescriptors(registry), registry);
}

type OperatorClient = Parameters<typeof handleGatewayRequest>[0]["client"];

function operatorClient(scopes: string[]): OperatorClient {
  return {
    connId: `conn-${scopes.join("-") || "none"}`,
    connect: {
      role: "operator",
      scopes,
      client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
      minProtocol: 1,
      maxProtocol: 1,
    },
  };
}

function agentClient(agentId: string): OperatorClient {
  return {
    ...operatorClient([READ_SCOPE]),
    connId: `conn-agent-${agentId}`,
    internal: { agentRuntimeIdentity: { agentId } },
  } as OperatorClient;
}

/** Dispatches one Gateway request through the real admission + dispatch path. */
async function dispatch(params: {
  harness: Harness;
  method: string;
  reqParams?: Record<string, unknown>;
  client: OperatorClient;
}) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: `proof-${params.method}`,
      method: params.method,
      params: params.reqParams ?? {},
    },
    respond,
    client: params.client,
    isWebchatConnect: () => false,
    context: { logGateway: { warn: vi.fn() } } as unknown as Parameters<
      typeof handleGatewayRequest
    >[0]["context"],
    methodRegistry: methodRegistry(params.harness.registry),
  });
  return respond;
}

/** Reads the persisted assignment for one agent straight from the host keyed store. */
async function persistedAssignment(keyed: Harness["keyed"], agentId: string) {
  return await keyed.lookup(agentId);
}

describe("secret-assignment broker authority chain", () => {
  beforeEach(() => {
    resetGlobalHookRunner();
    resetPluginRuntimeStateForTest();
  });

  afterEach(() => {
    resetGlobalHookRunner();
    resetPluginRuntimeStateForTest();
    resetPluginStateStoreForTests();
  });

  async function withState<T>(label: string, run: () => Promise<T>): Promise<T> {
    let result: T | undefined;
    await withOpenClawTestState({ label }, async () => {
      result = await run();
    });
    return result as T;
  }

  it("persists an authorized admin write through real RPC admission", async () => {
    await withState("broker-authority-write", async () => {
      const harness = buildHarness();
      const respond = await dispatch({
        harness,
        method: "secrets.assignments.broker.set",
        reqParams: { agentId: "agent-assigned", mode: "selected", names: ["DEPLOY_ENV_A"] },
        client: operatorClient([ADMIN_SCOPE]),
      });

      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(respond.mock.calls[0]?.[1]).toEqual({
        agentId: "agent-assigned",
        assignment: { mode: "selected", names: ["DEPLOY_ENV_A"] },
      });
      // The write is persisted, not merely echoed.
      expect(await persistedAssignment(harness.keyed, "agent-assigned")).toEqual({
        mode: "selected",
        names: ["DEPLOY_ENV_A"],
      });
    });
  });

  it("rejects an unauthorized admin write before persistence", async () => {
    await withState("broker-authority-unauthorized", async () => {
      const harness = buildHarness();
      const respond = await dispatch({
        harness,
        method: "secrets.assignments.broker.set",
        reqParams: { agentId: "agent-assigned", mode: "all" },
        client: operatorClient([READ_SCOPE]),
      });

      const [ok, payload, error] = respond.mock.calls[0] ?? [];
      expect(ok).toBe(false);
      expect(payload).toBeUndefined();
      expect(error).toBeDefined();
      // Nothing was written: the store has no entry for the agent.
      expect(await persistedAssignment(harness.keyed, "agent-assigned")).toBeUndefined();
    });
  });

  it("derives self inventory identity from the authenticated client, never params", async () => {
    await withState("broker-authority-self", async () => {
      const harness = buildHarness();
      await dispatch({
        harness,
        method: "secrets.assignments.broker.set",
        reqParams: { agentId: "agent-a", mode: "all" },
        client: operatorClient([ADMIN_SCOPE]),
      });

      // The connection is agent-b but params impersonate agent-a.
      const respond = await dispatch({
        harness,
        method: "secrets.assignments.broker.self",
        reqParams: { agentId: "agent-a" },
        client: agentClient("agent-b"),
      });
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(respond.mock.calls[0]?.[1]).toEqual({
        agentId: "agent-b",
        assignment: { mode: "none", names: [] },
      });
    });
  });

  it("grants exactly the assigned launch and denies the unassigned agent", async () => {
    await withState("broker-authority-launch", async () => {
      const harness = buildHarness();
      await dispatch({
        harness,
        method: "secrets.assignments.broker.set",
        reqParams: { agentId: "agent-assigned", mode: "selected", names: ["DEPLOY_ENV_A"] },
        client: operatorClient([ADMIN_SCOPE]),
      });

      const assigned = await authorizeSecretEnvForExec({
        storeEnv: storeEnv(),
        host: "gateway",
        agentId: "agent-assigned",
      });
      expect(assigned.denied).toBeUndefined();
      expect(Object.keys(assigned.storeEnv.env ?? {})).toEqual(["DEPLOY_ENV_A"]);
      expect(assigned.storeEnv.secretSentinels).toBeUndefined();

      const unassigned = await authorizeSecretEnvForExec({
        storeEnv: storeEnv(),
        host: "gateway",
        agentId: "agent-unassigned",
      });
      expect(unassigned.denied).toBeUndefined();
      expect(unassigned.storeEnv).toEqual({});
    });
  });

  it("denies at the final spawn boundary when the assignment is revoked while approval waits", async () => {
    await withState("broker-authority-revocation", async () => {
      const harness = buildHarness();
      await dispatch({
        harness,
        method: "secrets.assignments.broker.set",
        reqParams: { agentId: "agent-assigned", mode: "selected", names: ["DEPLOY_ENV_A"] },
        client: operatorClient([ADMIN_SCOPE]),
      });

      // The foreground owner validated and produced the spawn-boundary recheck.
      const authorization = await authorizeSecretEnvForExec({
        storeEnv: storeEnv(),
        host: "gateway",
        agentId: "agent-assigned",
      });
      expect(authorization.denied).toBeUndefined();
      expect(authorization.beforeSpawn).toBeTypeOf("function");
      // Initially the launch is authorized.
      await expect(authorization.beforeSpawn!()).resolves.toBeUndefined();

      // Revoke during the deferred approval window via the real RPC.
      const revoke = await dispatch({
        harness,
        method: "secrets.assignments.broker.set",
        reqParams: { agentId: "agent-assigned", mode: "none" },
        client: operatorClient([ADMIN_SCOPE]),
      });
      expect(revoke.mock.calls[0]?.[0]).toBe(true);
      expect(revoke.mock.calls[0]?.[1]).toEqual({
        agentId: "agent-assigned",
        assignment: { mode: "none", names: [] },
      });

      // The deferred launch owner must now deny before spawning.
      const denial = await authorization.beforeSpawn!();
      expect(denial?.details.status).toBe("failed");
      expect(JSON.stringify(denial)).toContain("revoked");
    });
  });

  it("preserves persisted assignments across a plugin reload", async () => {
    await withState("broker-authority-reload", async () => {
      const first = buildHarness();
      await dispatch({
        harness: first,
        method: "secrets.assignments.broker.set",
        reqParams: { agentId: "agent-reload", mode: "selected", names: ["DEPLOY_SEC_C"] },
        client: operatorClient([ADMIN_SCOPE]),
      });

      // Simulate a Gateway/plugin reload: a fresh registry + api instance binds to
      // the same host keyed store and must observe the persisted assignment.
      resetGlobalHookRunner();
      resetPluginRuntimeStateForTest();
      const second = buildHarness();
      const respond = await dispatch({
        harness: second,
        method: "secrets.assignments.broker.self",
        reqParams: {},
        client: agentClient("agent-reload"),
      });
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(respond.mock.calls[0]?.[1]).toEqual({
        agentId: "agent-reload",
        assignment: { mode: "selected", names: ["DEPLOY_SEC_C"] },
      });

      const authorized = await authorizeSecretEnvForExec({
        storeEnv: storeEnv(),
        host: "gateway",
        agentId: "agent-reload",
      });
      expect(Object.keys(authorized.storeEnv.secretSentinels ?? {})).toEqual(["DEPLOY_SEC_C"]);
    });
  });
});
