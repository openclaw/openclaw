import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  GatewayOperatorAccessDeniedError,
  resolveGatewayOperatorAccessAuthority,
} from "../gateway/operator-access-policy.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createLazyPluginRuntime } from "./loader-module-runtime.js";
import {
  loadAndActivateRootPluginRegistry,
  loadPluginRegistryHandle,
  resolveCompatibleRuntimePluginRegistry,
} from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
  writePluginMetadata,
} from "./loader.test-fixtures.js";
import { bindPluginRegistryRuntime, getPluginRegistryRuntime } from "./registry-runtime-binding.js";
import { createEmptyPluginRegistry } from "./registry.js";
import {
  clearActivePluginRegistry,
  getActivePluginRegistry,
  setActivePluginRegistry,
} from "./runtime.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";
import * as sdkAlias from "./sdk-alias.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginStateStoreForTests();
  resetPluginLoaderTestStateForTest();
  clearRuntimeConfigSnapshot();
});

afterAll(cleanupPluginLoaderFixturesForTest);

it.each([
  { explicit: "neither facet", nodes: false, subagent: false, activate: false },
  { explicit: "nodes", nodes: true, subagent: false, activate: false },
  { explicit: "subagent", nodes: false, subagent: true, activate: false },
  { explicit: "both facets", nodes: true, subagent: true, activate: false },
  {
    explicit: "neither facet after root activation",
    nodes: false,
    subagent: false,
    activate: true,
  },
])("refreshes borrowed Gateway bindings with explicit $explicit", async (explicit) => {
  useNoBundledPlugins();
  const plugin = writePlugin({
    id: "runtime-owner-probe",
    registration: `api.registerTool({
      name: "runtime_owner_probe", description: "Read bound runtime owners",
      parameters: { type: "object", properties: {} },
      async execute() {
        const { nodes } = await api.runtime.nodes.list();
        const { messages } = await api.runtime.subagent.getSessionMessages({ sessionKey: "probe" });
        return { content: [], details: { nodes: nodes.map(node => node.nodeId), messages } };
      },
    });`,
  });
  writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: plugin.id,
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      contracts: { tools: ["runtime_owner_probe"] },
    }),
  );
  const createFacets = (owner: string): Pick<PluginRuntime, "nodes" | "subagent"> => {
    const facets: Pick<PluginRuntime, "nodes" | "subagent"> = {
      nodes: {
        list: async () => ({ nodes: [{ nodeId: owner }] }),
        invoke: vi.fn<PluginRuntime["nodes"]["invoke"]>(),
        openDuplex: vi.fn<PluginRuntime["nodes"]["openDuplex"]>(),
      },
      subagent: {
        complete: vi.fn<PluginRuntime["subagent"]["complete"]>(),
        run: vi.fn<PluginRuntime["subagent"]["run"]>(),
        waitForRun: vi.fn<PluginRuntime["subagent"]["waitForRun"]>(),
        getSessionMessages: async () => ({ messages: [owner] }),
        deleteSession: vi.fn<PluginRuntime["subagent"]["deleteSession"]>(),
      },
    };
    bindGatewayContextResolver(facets.subagent, () => undefined);
    return facets;
  };
  const resolveRuntimeModule = vi
    .spyOn(sdkAlias, "resolvePluginRuntimeModulePathWithDiagnostics")
    .mockImplementation(() => {
      throw new Error("borrowed facets must not load the broad runtime");
    });
  const createDonor = (owner: string) => {
    const facets = createFacets(owner);
    const reads = {
      nodes: vi.fn(() => facets.nodes),
      subagent: vi.fn(() => facets.subagent),
    };
    const registry = createEmptyPluginRegistry();
    const runtime = createLazyPluginRuntime({
      runtimeOptions: {
        get nodes() {
          return reads.nodes();
        },
        get subagent() {
          return reads.subagent();
        },
      },
    });
    const resolveGatewayContext = getGatewayContextResolver(facets.subagent);
    bindGatewayContextResolver(runtime, resolveGatewayContext);
    bindPluginRegistryRuntime(registry, runtime);
    return { registry, reads, resolveGatewayContext };
  };
  const supplied = createFacets("explicit");
  const options = {
    config: {
      plugins: {
        allow: [plugin.id],
        load: { paths: [plugin.file] },
        slots: { memory: "none" },
      },
    },
    runtimeOptions: {
      allowGatewaySubagentBinding: true,
      ...(explicit.nodes ? { nodes: supplied.nodes } : {}),
      ...(explicit.subagent ? { subagent: supplied.subagent } : {}),
    },
  };
  const read = async (registry: ReturnType<typeof loadPluginRegistryHandle>) => {
    const tool = registry.tools[0]?.factory({ config: options.config });
    if (!tool || Array.isArray(tool)) {
      throw new Error("expected one runtime owner probe tool");
    }
    return await tool.execute("probe", {});
  };
  if (explicit.activate) {
    const donor = createDonor("gateway-a");
    setActivePluginRegistry(donor.registry, "gateway-a", "gateway-bindable");
    const registry = loadAndActivateRootPluginRegistry(options);
    const expected = { details: { nodes: ["gateway-a"], messages: ["gateway-a"] } };
    expect(await read(registry)).toMatchObject(expected);
    expect(getActivePluginRegistry()).toBe(registry);
    expect(loadAndActivateRootPluginRegistry(options)).toBe(registry);
    expect(resolveCompatibleRuntimePluginRegistry(options)).toBe(registry);
    expect(await read(registry)).toMatchObject(expected);
    expect(resolveRuntimeModule).not.toHaveBeenCalled();
    return;
  }
  let previous: ReturnType<typeof loadPluginRegistryHandle> | undefined;
  for (const owner of ["gateway-a", "gateway-b"]) {
    const donor = createDonor(owner);
    setActivePluginRegistry(donor.registry, owner, "gateway-bindable");
    const registry = loadPluginRegistryHandle(options);
    expect(donor.reads.nodes).not.toHaveBeenCalled();
    expect(donor.reads.subagent).not.toHaveBeenCalled();
    expect(getGatewayContextResolver(getPluginRegistryRuntime(registry)!)).toBe(
      explicit.subagent
        ? getGatewayContextResolver(supplied.subagent)
        : donor.resolveGatewayContext,
    );
    expect(await read(registry)).toMatchObject({
      details: {
        nodes: [explicit.nodes ? "explicit" : owner],
        messages: [explicit.subagent ? "explicit" : owner],
      },
    });
    expect(donor.reads.nodes.mock.calls.length > 0).toBe(!explicit.nodes);
    expect(donor.reads.subagent.mock.calls.length > 0).toBe(!explicit.subagent);
    expect(loadPluginRegistryHandle(options)).toBe(registry);
    if (previous) {
      expect(registry === previous).toBe(explicit.nodes && explicit.subagent);
    }
    previous = registry;
  }
  expect(resolveRuntimeModule).not.toHaveBeenCalled();
});

it.each([
  "missing manifest",
  "malformed manifest",
  "import failure",
  "registration failure",
  "disabled",
  "loaded",
] as const)("enforces a role's access-policy binding after %s", async (state) => {
  await withOpenClawTestState({ label: "loader-access-policy" }, async (testState) => {
    useNoBundledPlugins();
    const id = "required-access-policy";
    const owner = writePlugin({
      id,
      filename: "index.cjs",
      body:
        state === "import failure"
          ? 'throw new Error("access policy import failed");'
          : `module.exports = { id: "${id}", register(api) {
              ${state === "registration failure" ? 'throw new Error("access policy registration failed");' : ""}
              api.registerGatewayAccessPolicy({ authorize({ profile, requiredByRole }) {
                if (!requiredByRole || profile.assignedRole !== null) return undefined;
                return { signal: new AbortController().signal, assertCurrent() {} };
              } });
            } };`,
    });
    // Package-directory discovery requires its manifest; directly configured
    // standalone files intentionally support manifestless compatibility.
    writePluginMetadata({
      dir: owner.dir,
      id,
      packageJson: { name: id, version: "1.0.0", openclaw: { extensions: ["./index.cjs"] } },
    });
    const manifestPath = path.join(owner.dir, "openclaw.plugin.json");
    if (state === "missing manifest") {
      rmSync(manifestPath);
    } else if (state === "malformed manifest") {
      writeFileSync(manifestPath, "{", "utf8");
    }
    const optionalCheckEvent = `loader-access-policy:${testState.root}`;
    const optionalChecks = vi.fn();
    const optional = writePlugin({
      id: "optional-access-policy",
      registration: `api.registerGatewayAccessPolicy({ authorize({ profile, requiredByRole }) {
        process.emit(${JSON.stringify(optionalCheckEvent)}, profile.profileId, requiredByRole);
        return undefined;
      } });`,
    });
    const config = {
      gateway: {
        roles: {
          default: "visitor",
          definitions: {
            visitor: {
              sessions: { others: "view" },
              agents: ["main"],
              scopes: ["operator.sessions.read", "operator.sessions.write"],
              accessPolicyPlugin: id,
            },
            staff: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
            unbound: {
              sessions: { others: "view" },
              agents: ["main"],
              scopes: ["operator.sessions.read"],
            },
          },
        },
      },
      plugins: {
        allow: [id, optional.id],
        load: { paths: [owner.dir, optional.file] },
        entries: { [id]: { enabled: state !== "disabled" } },
        slots: { memory: "none" },
      },
    } satisfies OpenClawConfig;
    const visitor = ensureProfileForEmail("loader-visitor@example.test");
    const staff = ensureProfileForEmail("loader-staff@example.test");
    const unbound = ensureProfileForEmail("loader-unbound@example.test");
    setUserProfileRole(staff.id, "staff");
    setUserProfileRole(unbound.id, "unbound");
    let registry: ReturnType<typeof loadAndActivateRootPluginRegistry> | undefined;
    process.on(optionalCheckEvent, optionalChecks);
    try {
      registry = loadAndActivateRootPluginRegistry({ config, cache: false });
      expect(getActivePluginRegistry()).toBe(registry);
      const record = registry.plugins.find((plugin) => plugin.id === id);
      if (state === "missing manifest" || state === "malformed manifest") {
        expect(record).toBeUndefined();
        expect(registry.diagnostics).toContainEqual(
          expect.objectContaining({
            level: "error",
            source: manifestPath,
            message: expect.stringContaining(
              state === "missing manifest"
                ? "plugin manifest not found"
                : "failed to parse plugin manifest",
            ),
          }),
        );
      } else if (state === "import failure" || state === "registration failure") {
        expect(record).toMatchObject({
          status: "error",
          failurePhase: state === "import failure" ? "load" : "register",
          error: expect.stringContaining(
            state === "import failure"
              ? "access policy import failed"
              : "access policy registration failed",
          ),
        });
      } else {
        expect(record).toMatchObject({ status: state, enabled: state === "loaded" });
      }
      expect(registry.plugins).toContainEqual(
        expect.objectContaining({ id: optional.id, enabled: true, status: "loaded" }),
      );
      expect(registry.gatewayAccessPolicies.some((policy) => policy.pluginId === id)).toBe(
        state === "loaded",
      );
      if (state === "loaded") {
        const authority = expectDefined(
          resolveGatewayOperatorAccessAuthority(visitor.id, config),
          "loaded required access policy authority",
        );
        expect(authority.assertCurrent).not.toThrow();
        expect(optionalChecks).toHaveBeenCalledWith(visitor.id, false);
        const staffDefault = {
          ...config,
          gateway: { roles: { ...config.gateway.roles, default: "staff" } },
        };
        for (const unboundConfig of [staffDefault, { ...config, gateway: {} }]) {
          expect(resolveGatewayOperatorAccessAuthority(visitor.id, unboundConfig)).toBeNull();
          expect(resolveGatewayOperatorAccessAuthority(staff.id, unboundConfig)).toBeNull();
        }
      } else {
        expect(() => resolveGatewayOperatorAccessAuthority(visitor.id, config)).toThrow(
          GatewayOperatorAccessDeniedError,
        );
        expect(optionalChecks).not.toHaveBeenCalled();
      }
      expect(resolveGatewayOperatorAccessAuthority(staff.id, config)).toBeNull();
      expect(resolveGatewayOperatorAccessAuthority(unbound.id, config)).toBeNull();
      expect(optionalChecks).toHaveBeenCalledWith(staff.id, false);
      expect(optionalChecks).toHaveBeenCalledWith(unbound.id, false);
      optionalChecks.mockClear();
      expect(resolveGatewayOperatorAccessAuthority(GATEWAY_OWNER_PROFILE_ID, config)).toBeNull();
      expect(optionalChecks).not.toHaveBeenCalled();
    } finally {
      process.off(optionalCheckEvent, optionalChecks);
      if (registry) {
        await clearActivePluginRegistry(registry);
      }
    }
  });
});
