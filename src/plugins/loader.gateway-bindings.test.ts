import { rmSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  GatewayOperatorAccessDeniedError,
  resolveGatewayOperatorAccessAuthority as resolveAccess,
} from "../gateway/operator-access-policy.js";
import type { RepositoryPublicationProvider } from "../gateway/repository-publication-contract.js";
import {
  RepositoryPublicationFailureError,
  RepositoryPublicationRequesterUnavailableError,
} from "../gateway/repository-publication-errors.js";
import {
  createRepositoryPublicationGitTransfer,
  type RepositoryPublicationGitTransfer,
} from "../gateway/repository-publication-git-transfer.js";
import { createGatewayRequestContext } from "../gateway/server-request-context.js";
import { makeContextParams } from "../gateway/server-request-context.test-support.js";
import type { WorkerWorkspaceSyncRequest } from "../gateway/worker-environments/tunnel-contract.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { pluginFixtureConfig, writeFixtureJson } from "./loader-fixture-builders.test-support.js";
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
  createRepositoryCheckoutTransfer,
  type RepositoryCheckoutTransfer,
} from "./repository-checkout-transfer.js";
import {
  clearActivePluginRegistry,
  getActivePluginRegistry,
  setActivePluginRegistry,
} from "./runtime.js";
import { captureGatewayContextResolver } from "./runtime/gateway-context-binding.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
  getGatewayContextLifetime,
  withPluginRuntimeGatewayContextResolver,
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
  { explicit: "nodes", nodes: true, activate: false },
  { explicit: "neither facet after root activation", nodes: false, activate: true },
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
  writeFixtureJson(plugin.dir, "openclaw.plugin.json", {
    id: plugin.id,
    configSchema: { type: "object", additionalProperties: false, properties: {} },
    contracts: { tools: ["runtime_owner_probe"] },
  });
  const createFacets = (owner: string): Pick<PluginRuntime, "nodes" | "subagent"> => {
    const facets: Pick<PluginRuntime, "nodes" | "subagent"> = {
      nodes: {
        list: async () => ({ nodes: [{ nodeId: owner }] }),
        invoke: vi.fn<PluginRuntime["nodes"]["invoke"]>(),
        openDuplex: vi.fn<PluginRuntime["nodes"]["openDuplex"]>(),
      },
      subagent: {
        complete: vi.fn<PluginRuntime["subagent"]["complete"]>(),
        forkSession: vi.fn<PluginRuntime["subagent"]["forkSession"]>(),
        runForkedTurn: vi.fn(async () => ({
          status: "refused" as const,
          reason: "tool_policy" as const,
        })),
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
    config: pluginFixtureConfig(plugin),
    runtimeOptions: {
      allowGatewaySubagentBinding: true,
      ...(explicit.nodes ? { nodes: supplied.nodes } : {}),
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
    const registry = await loadAndActivateRootPluginRegistry(options);
    const expected = { details: { nodes: ["gateway-a"], messages: ["gateway-a"] } };
    expect(await read(registry)).toMatchObject(expected);
    expect(getActivePluginRegistry()).toBe(registry);
    expect(await loadAndActivateRootPluginRegistry(options)).toBe(registry);
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
      donor.resolveGatewayContext,
    );
    expect(await read(registry)).toMatchObject({
      details: {
        nodes: [explicit.nodes ? "explicit" : owner],
        messages: [owner],
      },
    });
    expect(donor.reads.nodes.mock.calls.length > 0).toBe(!explicit.nodes);
    expect(donor.reads.subagent.mock.calls.length > 0).toBe(true);
    expect(loadPluginRegistryHandle(options)).toBe(registry);
    if (previous) {
      expect(registry).not.toBe(previous);
    }
    previous = registry;
  }
  expect(resolveRuntimeModule).not.toHaveBeenCalled();
});

it.each(["missing manifest", "registration failure", "disabled", "loaded"] as const)(
  "enforces a role's access-policy binding after %s",
  async (state) => {
    await withOpenClawTestState({ label: "loader-access-policy" }, async (testState) => {
      useNoBundledPlugins();
      const id = "required-access-policy";
      const owner = writePlugin({
        id,
        filename: "index.cjs",
        body: `module.exports = { id: "${id}", register(api) {
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
      const withRole = (role: string) => {
        const profile = ensureProfileForEmail(`loader-${role}@example.test`);
        setUserProfileRole(profile.id, role);
        return profile;
      };
      const staff = withRole("staff");
      const unbound = withRole("unbound");
      let registry: Awaited<ReturnType<typeof loadAndActivateRootPluginRegistry>> | undefined;
      const catalog = await prepareUserProfileCatalog();
      process.on(optionalCheckEvent, optionalChecks);
      try {
        registry = await loadAndActivateRootPluginRegistry({ config, cache: false });
        expect(getActivePluginRegistry()).toBe(registry);
        const record = registry.plugins.find((plugin) => plugin.id === id);
        if (state === "missing manifest") {
          expect(record).toBeUndefined();
          expect(registry.diagnostics).toContainEqual(
            expect.objectContaining({
              level: "error",
              source: manifestPath,
              message: expect.stringContaining("plugin manifest not found"),
            }),
          );
        } else if (state === "registration failure") {
          expect(record).toMatchObject({
            status: "error",
            failurePhase: "register",
            error: expect.stringContaining("access policy registration failed"),
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
            resolveAccess(visitor.id, config),
            "loaded required access policy authority",
          );
          expect(authority.assertCurrent).not.toThrow();
          expect(optionalChecks).toHaveBeenCalledWith(visitor.id, false);
          const staffDefault = {
            ...config,
            gateway: { roles: { ...config.gateway.roles, default: "staff" } },
          };
          for (const unboundConfig of [staffDefault, { ...config, gateway: {} }]) {
            expect(resolveAccess(visitor.id, unboundConfig)).toBeNull();
            expect(resolveAccess(staff.id, unboundConfig)).toBeNull();
          }
        } else {
          expect(() => resolveAccess(visitor.id, config)).toThrow(GatewayOperatorAccessDeniedError);
          expect(optionalChecks).not.toHaveBeenCalled();
        }
        for (const profile of [staff, unbound]) {
          expect(resolveAccess(profile.id, config)).toBeNull();
          expect(optionalChecks).toHaveBeenCalledWith(profile.id, false);
        }
        optionalChecks.mockClear();
        expect(resolveAccess(GATEWAY_OWNER_PROFILE_ID, config)).toBeNull();
        expect(optionalChecks).not.toHaveBeenCalled();
      } finally {
        process.off(optionalCheckEvent, optionalChecks);
        catalog.release();
        if (registry) {
          await clearActivePluginRegistry(registry);
        }
      }
    });
  },
);

it("preserves private Gateway ownership through a native public SDK consumer", async () => {
  await withOpenClawTestState({ label: "loader-native-gateway-owner" }, async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "gateway-service-owner-probe",
      filename: "index.cjs",
      body: `const { captureNativeGitHubServiceHost, performNativeGitHubPublicationGit, NativeGitHubPublicationRequesterUnavailableError } = require("openclaw/plugin-sdk/native-github-publication-host");
const { performRepositoryCheckout } = require("openclaw/plugin-sdk/repository-sources");
module.exports = { id: "gateway-service-owner-probe", register(api) {
  api.registerTool({ name: "gateway_service_owner_probe", description: "Read the bound service lifetime",
    parameters: { type: "object", properties: {} },
    async execute(_id, { transfer, checkout, requesterUnavailable }) {
      const host = captureNativeGitHubServiceHost();
      if (!host) throw new Error("Expected the bound Gateway service");
      host.assertCurrent();
      if (!host.publicationAvailable) throw new Error("Expected the bound workspace publication host");
      if (requesterUnavailable) throw new NativeGitHubPublicationRequesterUnavailableError();
      if (transfer) await performNativeGitHubPublicationGit(transfer, {
        httpAuthorization: "Bearer synthetic-publication",
        assertCurrent: host.assertCurrent,
      });
      if (checkout) await performRepositoryCheckout(checkout, {
        token: "synthetic-checkout",
        assertCurrent: host.assertCurrent,
        start: async (run) => { host.assertCurrent(); return await run(); },
      });
      return { content: [], details: host.identity };
    }
  });
} };`,
    });
    writeFixtureJson(plugin.dir, "openclaw.plugin.json", {
      id: plugin.id,
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      contracts: { tools: ["gateway_service_owner_probe"] },
    });
    const config = pluginFixtureConfig(plugin);
    const registry = loadPluginRegistryHandle({ config });
    expect(registry.plugins.find((entry) => entry.id === plugin.id)?.status).toBe("loaded");
    const params = makeContextParams();
    const { createWorkspacePublicationHost } =
      await import("../gateway/workspace-publication-provider.js");
    const { createWorkerSessionPlacementStore } =
      await import("../gateway/worker-environments/placement-store.js");
    const { openOpenClawStateDatabase } = await import("../state/openclaw-state-db.js");
    const { loadWorkerPlacementSessionRuntimeModule } =
      await import("../gateway/server-worker-placement-startup.js");
    const publicationHost = createWorkspacePublicationHost({
      placements: createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() }),
      scheduler: params.runtime.scheduler,
      getCommittedRuntimeConfig: () => config,
      loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
      managedByPlacement: true,
      warn() {},
    });
    params.runtime.workspacePublicationHost = publicationHost;
    const context = createGatewayRequestContext(params);
    context.resolveGatewayContext = () => context;
    const lifetime = getGatewayContextLifetime(context.resolveGatewayContext);
    const wrapper = expectDefined(
      captureGatewayContextResolver(context.resolveGatewayContext),
      "captured Gateway wrapper",
    );
    const read = (
      transfer?: RepositoryPublicationGitTransfer,
      checkout?: RepositoryCheckoutTransfer,
      requesterUnavailable = false,
    ) =>
      withPluginRuntimeGatewayContextResolver(wrapper, async () => {
        const tool = registry.tools[0]?.factory({ config });
        if (!tool || Array.isArray(tool)) {
          throw new Error("Expected one Gateway service owner probe tool");
        }
        return await tool.execute("owner-probe", { transfer, checkout, requesterUnavailable });
      });
    try {
      await publicationHost.ready;
      const retained = (await read()).details;
      expect(retained).toBe(lifetime.signal);
      const denied = read(undefined, undefined, true);
      await expect(denied).rejects.toBeInstanceOf(RepositoryPublicationRequesterUnavailableError);
      await expect(denied).rejects.toBeInstanceOf(RepositoryPublicationFailureError);
      let dispatches = 0;
      const accept = () =>
        createRepositoryPublicationGitTransfer(
          async (authorization, assertCurrent) => {
            assertCurrent();
            expect(authorization).toBe("Bearer synthetic-publication");
            dispatches++;
            return "bound-publication-result";
          },
          () => lifetime.signal.throwIfAborted(),
        );
      const accepted = accept();
      await read(accepted.transfer);
      expect(accepted.result()).toBe("bound-publication-result");
      expect(dispatches).toBe(1);
      await expect(read(accepted.transfer)).rejects.toThrow("no longer available");
      expect(dispatches).toBe(1);
      const checkoutRequest: WorkerWorkspaceSyncRequest = {
        sessionId: "native-sdk-checkout",
        generation: 1,
        source: {
          kind: "repository",
          url: "https://github.com/synthetic/repository.git",
          branch: "proof/checkout",
        },
      };
      let checkouts = 0;
      const acceptCheckout = () =>
        createRepositoryCheckoutTransfer(
          {
            async syncWorkspace(request) {
              request.authorize?.();
              expect(request).toMatchObject({
                ...checkoutRequest,
                source: { ...checkoutRequest.source, gitToken: "synthetic-checkout" },
              });
              checkouts++;
              return {
                mode: "repository",
                remoteWorkspaceDir: "/worker/native-sdk-checkout",
                manifestRef: "prepared-checkout",
                baseCommit: "a".repeat(40),
                baseManifestRef: "base-checkout",
              };
            },
          },
          checkoutRequest,
          () => lifetime.signal.throwIfAborted(),
        );
      const checkout = acceptCheckout();
      await read(undefined, checkout.transfer);
      expect(checkout.result()).toMatchObject({
        remoteWorkspaceDir: "/worker/native-sdk-checkout",
        manifestRef: "prepared-checkout",
      });
      expect(checkouts).toBe(1);
      await expect(read(undefined, checkout.transfer)).rejects.toThrow("no longer available");
      expect(checkouts).toBe(1);
      const cancelled = accept();
      const cancelledCheckout = acceptCheckout();
      lifetime.abort(new Error("Gateway closed"));
      expect(lifetime.signal.aborted).toBe(true);
      await expect(read(cancelled.transfer)).rejects.toThrow("Gateway closed");
      expect(() => cancelled.result()).toThrow("did not dispatch");
      expect(dispatches).toBe(1);
      await expect(read(undefined, cancelledCheckout.transfer)).rejects.toThrow("Gateway closed");
      expect(() => cancelledCheckout.result()).toThrow("did not dispatch");
      expect(checkouts).toBe(1);
    } finally {
      lifetime.abort();
      try {
        await publicationHost.close();
      } finally {
        await params.runtime.scheduler.stop();
      }
    }
  });
});

it("allows a healthy publisher install after identity subscription setup fails", async () => {
  await withOpenClawTestState({ label: "publisher-install-rollback" }, async () => {
    const params = makeContextParams();
    const { createWorkspacePublicationHost } =
      await import("../gateway/workspace-publication-provider.js");
    const { createWorkerSessionPlacementStore } =
      await import("../gateway/worker-environments/placement-store.js");
    const { openOpenClawStateDatabase } = await import("../state/openclaw-state-db.js");
    const { loadWorkerPlacementSessionRuntimeModule } =
      await import("../gateway/server-worker-placement-startup.js");
    const host = createWorkspacePublicationHost({
      placements: createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() }),
      scheduler: params.runtime.scheduler,
      getCommittedRuntimeConfig: () => ({}),
      loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
      managedByPlacement: true,
      warn() {},
    });
    const owner = new AbortController();
    const failure = new Error("Identity subscription setup failed");
    const stopSubscription = vi.fn();
    const unexpected = () => {
      throw new Error("Installation must not perform remote publication work");
    };
    const provider: RepositoryPublicationProvider = {
      id: "fixture-publisher",
      assertCurrent: () => owner.signal.throwIfAborted(),
      supportsOrigin: (origin) => origin === "https://example.test/owner/repository.git",
      subscribeWorkerIdentityChanges: vi
        .fn(() => stopSubscription)
        .mockImplementationOnce(() => {
          throw failure;
        }),
      formatReport: unexpected,
      preparePublisher: unexpected,
      bindPersonal: unexpected,
      readOptionsIdentity: unexpected,
      preparePersonalAccountStatus: unexpected,
      isPublicationSuperseded: unexpected,
      readPersonalSelection: unexpected,
      performPullRequestAction: unexpected,
      inspectPullRequest: unexpected,
      prepareBoundPublication: unexpected,
      prepareTarget: unexpected,
      preparePublishedTarget: unexpected,
      readBase: unexpected,
      observeBranch: unexpected,
      findPullRequest: unexpected,
      createPullRequest: unexpected,
      reconcile: unexpected,
      formatContent: unexpected,
      prepareChangeGuard: unexpected,
      executeRepository: unexpected,
      resolveFailure: unexpected,
      isDefinitiveFailure: unexpected,
    };
    try {
      await host.ready;
      await expect(host.install(provider, owner.signal)).rejects.toBe(failure);
      const installed = await host.install(provider, owner.signal);
      expect(installed.api.supportsOrigin("https://example.test/owner/repository.git")).toBe(true);
      expect(host.readApi()).toBe(installed.api);
      installed.uninstall();
      expect(host.readApi()).toBeUndefined();
      expect(stopSubscription).toHaveBeenCalledTimes(1);
    } finally {
      owner.abort();
      try {
        await host.close();
      } finally {
        await params.runtime.scheduler.stop();
      }
    }
  });
});
