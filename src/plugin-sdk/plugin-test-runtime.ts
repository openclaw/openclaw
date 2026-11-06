// Focused public test helpers for plugin runtime, registry, and setup fixtures.

import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { AgentHarness } from "../agents/harness/types.js";
import type {
  IsolatedCompletionBoundaryFixture,
  IsolatedCompletionBoundaryFixtureParams,
} from "../agents/isolated-completion.adapter.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import type { PluginRegistryParams } from "../plugins/registry-types.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { createHostChannelInboundRuntime } from "../plugins/runtime/runtime-channel-admission.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { ReplyOperation } from "../sessions/session-controller.contracts.js";

/** Builds a bundled-plugin Gateway runtime backed by the real session projection and handlers. */
export async function createTestPluginGatewayRuntime(params: {
  pluginId: string;
  config: OpenClawConfig;
}): Promise<{ gateway: PluginRuntime["gateway"]; close: () => Promise<void> }> {
  const [
    runtimeModule,
    requestScope,
    serverPlugins,
    projectionModule,
    projectionAccess,
    dispatchTestSupport,
  ] = await Promise.all([
    import("../plugins/runtime/index.js"),
    import("../plugins/runtime/gateway-request-scope.js"),
    import("../gateway/server-plugins.js"),
    import("../gateway/session-row-projection.js"),
    import("../gateway/session-row-projection-access.js"),
    import("../gateway/server-plugin-in-process-dispatch.test-support.js"),
  ]);
  const gatewayContext: GatewayRequestContext = {
    ...dispatchTestSupport.createContext(),
    getRuntimeConfig: () => params.config,
    getCommittedRuntimeConfig: () => params.config,
  };
  const projection = await projectionModule.createSessionRowProjection({
    cfg: params.config,
    modelCatalog: [],
  });
  projectionAccess.bindSessionRowProjection(gatewayContext, () => projection);
  await projection.ensureMaterialized();
  const base = runtimeModule.createPluginRuntime().gateway;
  const resolveGatewayContext = () => gatewayContext;
  let closed = false;
  return {
    gateway: {
      ...base,
      isAvailable: async () => !closed,
      request: <T>(
        method: string,
        requestParams?: Record<string, unknown>,
        options?: Parameters<PluginRuntime["gateway"]["request"]>[2],
      ) =>
        requestScope.withPluginRuntimePluginScope(
          { pluginId: params.pluginId, pluginOrigin: "bundled" },
          () =>
            serverPlugins.dispatchTrustedPluginGatewayMethod<T>(
              method,
              requestParams,
              options,
              resolveGatewayContext,
            ),
        ),
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await projection.ensureMaterialized();
      projection.dispose();
    },
  };
}

type AgentHarnessHostTestAttempt = Omit<
  Parameters<
    typeof import("../agents/harness/host-capability.js").createAgentHarnessHostCapabilities
  >[0]["attempt"],
  "admittedRunContext" | "hostCapabilities" | "disableToolSearch" | "sessionReadScopeKey"
>;

type PluginHarnessTestOperatorSource = Pick<
  AdmittedRunOperatorAuthority,
  "profileId" | "scopes" | "assertCurrent" | "modelPolicy" | "onModelPolicyChanged"
>;

async function admitPluginHarnessRunForTest(params: {
  attempt: Pick<AgentHarnessHostTestAttempt, "config" | "runId" | "agentId">;
  pluginId: string;
  operatorSource?: PluginHarnessTestOperatorSource;
}) {
  const {
    createAdmittedRunOperatorAuthority,
    createOperationalRunInstanceRef,
    prepareAgentRunAdmission,
  } = await import("../agents/admitted-run-context.js");
  const admission = prepareAgentRunAdmission({
    cfg: params.attempt.config ?? {},
    operatorAuthority: params.operatorSource
      ? createAdmittedRunOperatorAuthority(params.operatorSource)
      : undefined,
    facts: {
      runId: params.attempt.runId,
      agentId: params.attempt.agentId ?? "main",
      ingress: { kind: "system", boundary: "plugin-test-runtime", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(params.attempt.runId),
  });
  return {
    admittedRunContext: await admission.admit("plugin-harness", params.pluginId),
    close: () => admission.close(),
  };
}

/** Builds the production admitted-run host boundary for plugin integration tests. */
export async function createAgentHarnessHostCapabilitiesForTest(params: {
  attempt: AgentHarnessHostTestAttempt;
  pluginId: string;
  nativeModelPolicySupport?: "exact";
  operatorSource?: PluginHarnessTestOperatorSource;
}) {
  const { createAgentHarnessHostCapabilities } =
    await import("../agents/harness/host-capability.js");
  const { harnessHostAdmissionsForTest } =
    await import("../agents/harness/host-capability.test-support.js");
  const admission = await admitPluginHarnessRunForTest(params);
  const admittedRunContext = admission.admittedRunContext;
  const host = createAgentHarnessHostCapabilities({
    attempt: { ...params.attempt, admittedRunContext },
    pluginId: params.pluginId,
    nativeModelPolicySupport: params.nativeModelPolicySupport,
  });
  harnessHostAdmissionsForTest.set(host.capabilities, admission);
  return {
    capabilities: host.capabilities,
    close: () => {
      harnessHostAdmissionsForTest.delete(host.capabilities);
      host.close();
      admission.close();
    },
  };
}

/**
 * Loads plugins for `config` through the real loader and runs callbacks inside one plugin's
 * instance scope, the way the host runs that plugin's tools, hooks, commands and services.
 * Call `dispose` before loading again.
 */
export async function loadPluginInstanceForTest(params: {
  config: OpenClawConfig;
  pluginId: string;
  workspaceDir?: string;
}) {
  const [{ loadOpenClawPlugins }, { getPluginInstance }, { disposePluginRegistryInstances }] =
    await Promise.all([
      import("../plugins/loader.js"),
      import("../plugins/plugin-instance-scope.js"),
      import("../plugins/runtime.js"),
    ]);
  const registry = loadOpenClawPlugins({
    config: params.config,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    cache: false,
    activate: false,
  });
  const record = registry.plugins.find((plugin) => plugin.id === params.pluginId);
  const instance = record ? getPluginInstance(record) : undefined;
  if (!record || !instance) {
    throw new Error(
      `Plugin ${params.pluginId} did not load (${record?.status ?? "missing"}${record?.error ? `: ${record.error}` : ""}).`,
    );
  }
  return {
    registry,
    run: <T>(run: () => T): T => instance.runInRegistry(registry, run),
    dispose: async () => {
      await disposePluginRegistryInstances(registry);
    },
  };
}

/**
 * Loads one plugin through the real loader and makes its registry the active one, so its
 * registered tools, prompt guidance and hooks serve the test. The returned restore reinstates
 * the previous registry and disposes the plugin; pass it to `onTestFinished`.
 */
export async function activatePluginForTest(params: {
  config: OpenClawConfig;
  pluginId: string;
}): Promise<() => Promise<void>> {
  const { getActivePluginRegistry, resetPluginRuntimeStateForTest, setActivePluginRegistry } =
    await import("../plugins/runtime.js");
  const plugin = await loadPluginInstanceForTest(params);
  const previous = getActivePluginRegistry();
  setActivePluginRegistry(plugin.registry);
  return async () => {
    if (previous) {
      setActivePluginRegistry(previous);
    } else {
      resetPluginRuntimeStateForTest();
    }
    await plugin.dispose();
  };
}

/** Admits a native harness fixture through the production session mailbox. */
export async function withAdmittedSessionTurnForTest<T>(
  params: {
    sessionKey: string;
    sessionId: string;
    agentId?: string;
    storePath?: string;
    abortSignal?: AbortSignal;
  },
  run: (operation: ReplyOperation, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const { withSessionTurn } = await import("../sessions/session-controller.admission.js");
  return await withSessionTurn(params, async (operation, signal) => {
    if (!operation) {
      throw new Error(`Session turn admission did not materialize ${params.sessionKey}`);
    }
    return await run(operation, signal);
  });
}

type HarnessToolAuthorityBoundary = Parameters<
  typeof import("../agents/harness/tool-authority.runtime.js").withPreparedEmbeddedRunToolAuthority
>;
type HarnessToolAuthorityTestAttempt = HarnessToolAuthorityBoundary[1] & {
  replyOperation?: ReplyOperation;
  trigger?: HarnessToolAuthorityBoundary[0]["trigger"];
  sessionPersistence?: HarnessToolAuthorityBoundary[0]["sessionPersistence"];
};

/** Uses the host boundary to derive tool authority and native liveness for a fixture. */
export async function runInHarnessToolAuthorityForTest<
  T,
  Attempt extends HarnessToolAuthorityTestAttempt,
>(
  attempt: Attempt,
  pluginId: string,
  run: (
    attempt: Omit<Attempt, "replyOperation"> & { toolAuthorityFingerprint?: string },
  ) => Promise<T>,
  options?: { registeredHarness: AgentHarness },
): Promise<T> {
  if (attempt.toolAuthorityFingerprint) {
    throw new Error("The tool-authority boundary derives its own fingerprint");
  }
  const { withPreparedEmbeddedRunToolAuthority } =
    await import("../agents/harness/tool-authority.runtime.js");
  const queueInputAdapter = options
    ? await import("../agents/harness/registry.js").then((registry) => {
        const harness = options.registeredHarness;
        if (registry.resolveAgentHarnessOwnerPluginId(harness) !== pluginId) {
          throw new Error("Fixture harness does not belong to the admitted plugin");
        }
        return registry.resolveAgentHarnessQueueInputAdapter(harness);
      })
    : undefined;
  const { resolveAgentIdFromSessionKey } = await import("../routing/session-key.js");
  const { harnessHostAdmissionsForTest } =
    await import("../agents/harness/host-capability.test-support.js");
  const agentId = attempt.agentId ?? resolveAgentIdFromSessionKey(attempt.sessionKey);
  // A production host already owns this run's admission; replacing it retires the host.
  const hostAdmission =
    attempt.hostCapabilities && harnessHostAdmissionsForTest.get(attempt.hostCapabilities);
  const admission = hostAdmission ?? (await admitPluginHarnessRunForTest({ attempt, pluginId }));
  try {
    const { replyOperation, ...pluginAttempt } = attempt;
    return await withPreparedEmbeddedRunToolAuthority(
      {
        admittedRunContext: admission.admittedRunContext,
        replyOperation,
        trigger: attempt.trigger,
        sessionPersistence: attempt.sessionPersistence,
        queueInputAdapter,
      },
      { ...pluginAttempt, agentId },
      undefined,
      async (prepared) => {
        attempt.toolAuthorityFingerprint = prepared.toolAuthorityFingerprint;
        try {
          return await run(prepared);
        } finally {
          if (attempt.toolAuthorityFingerprint === prepared.toolAuthorityFingerprint) {
            delete attempt.toolAuthorityFingerprint;
          }
        }
      },
    );
  } finally {
    if (!hostAdmission) {
      admission.close();
    }
  }
}

export { setDefaultChannelPluginRegistryForTests } from "../commands/channel-test-registry.js";
export { createEmptyPluginRegistry, type PluginRecord } from "../plugins/registry.js";

/** Test hosts supply admission without requiring callers to know private loader bindings. */
export function createPluginTestRegistry(
  params: Omit<PluginRegistryParams, "createHostChannelInboundRuntime">,
) {
  return createPluginRegistry({ ...params, createHostChannelInboundRuntime });
}
export {
  getPluginRegistrationContracts,
  resolveProviderContractProvidersForPluginIds,
  resolveWebFetchProviderContractEntriesForPluginId,
  resolveWebSearchProviderContractEntriesForPluginId,
} from "../plugins/contracts/registry.js";
export { loadPluginManifestRegistryCore } from "../plugins/manifest-registry.js";
export {
  emitDiagnosticEventWithTrustedTraceContext,
  emitInternalDiagnosticEvent as emitInternalDiagnosticEventForTest,
  emitTrustedSecurityEvent,
} from "../infra/diagnostic-events.js";
export { registerDiagnosticTracePropagationBridge } from "../infra/diagnostic-trace-propagation.js";
export { runWithDiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
export { prepareSystemRunMutableFileApproval } from "../infra/system-run-approval-binding.js";
export { logMessageDispatchStarted, logMessageProcessed } from "../logging/diagnostic.js";
export {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
export { addTestHook } from "../plugins/hooks.test-helpers.js";
export { createPluginRecord } from "../plugins/status.test-helpers.js";
export { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
export { waitForPluginCacheRetirement } from "../plugins/plugin-cache.js";
export { useProviderCatalogMetadata } from "./test-helpers/provider-catalog.js";
export { useProviderToolSchemaRuntimeForTest } from "./test-helpers/provider-tool-schemas.test-support.js";
export { useBundledProviderPolicyArtifactsForTest } from "./test-helpers/provider-policy-artifacts.test-support.js";
export { mockPublishedModelRuntimeForTest } from "./test-helpers/published-model-runtime.js";
export {
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts,
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
} from "../plugins/web-provider-public-artifacts.explicit.js";
export {
  clearActivePluginRegistry,
  createPluginRegistryOwner,
  disposePluginRegistryInstances,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
  waitForPluginRegistryRetirement,
} from "../plugins/runtime.js";
export {
  listImportedBundledPluginFacadeIds,
  resetFacadeRuntimeStateForTest,
} from "./facade-runtime.js";
export { capturePluginRegistration } from "../plugins/captured-registration.js";
export { clearHealthChecksForTest } from "../flows/health-check-registry.js";
export { runProviderCatalog } from "../plugins/provider-discovery.js";
export { onTrustedInternalDiagnosticEvent } from "../infra/diagnostic-events.js";
export {
  buildProviderPluginMethodChoice,
  resolveProviderModelPickerEntries,
} from "../plugins/provider-wizard.js";
export { resolveProviderPluginChoice } from "../plugins/provider-auth-choice.runtime.js";
export {
  clearEmbeddingProviders,
  getRegisteredEmbeddingProvider,
  listRegisteredEmbeddingProviders,
  registerEmbeddingProvider,
  restoreRegisteredEmbeddingProviders,
  type RegisteredEmbeddingProvider,
} from "../plugins/embedding-providers.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { PluginHookRegistration } from "../plugins/hook-types.js";
export type { RuntimeEnv } from "../runtime.js";
export type { MockFn } from "../test-utils/vitest-mock-fn.js";
export { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
export { readQueuedEntries as readQueuedDeliveryEntriesForTest } from "../infra/outbound/delivery-queue.test-helpers.js";
export {
  registerProviderPlugin,
  registerProviderPlugins,
  registerSingleProviderPlugin,
  requireRegisteredProvider,
  type RegisteredProviderCollections,
} from "../test-utils/plugin-registration.js";
export { createNonExitingRuntimeEnv, createRuntimeEnv } from "../test-utils/plugin-runtime-env.js";
export {
  createPluginSetupWizardAdapter,
  createPluginSetupWizardConfigure,
  createPluginSetupWizardStatus,
  createQueuedWizardPrompter,
  createSetupWizardAdapter,
  createTestWizardPrompter,
  promptSetupWizardAllowFrom,
  resolveSetupWizardAllowFromEntries,
  resolveSetupWizardGroupAllowlist,
  runSetupWizardConfigure,
  runSetupWizardFinalize,
  runSetupWizardPrepare,
  type WizardPrompter,
} from "../test-utils/plugin-setup-wizard.js";
export { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
export { registerSkillsChangeListener } from "../skills/runtime/refresh-state.js";
type AdmittedHostCapabilityTestFixtureFactory =
  typeof import("../agents/harness/host-capability.test-support.js").createAdmittedHostCapabilityTestFixture;

// Keep unrelated consumers of this test barrel out of the host capability runtime.
export async function createAdmittedHostCapabilityTestFixture(
  ...args: Parameters<AdmittedHostCapabilityTestFixtureFactory>
): ReturnType<AdmittedHostCapabilityTestFixtureFactory> {
  const fixture = await import("../agents/harness/host-capability.test-support.js");
  return fixture.createAdmittedHostCapabilityTestFixture(...args);
}

// Load the core fixture only for adapter tests that need the real isolated entrypoint.
export async function createIsolatedCompletionBoundaryFixture(
  params: IsolatedCompletionBoundaryFixtureParams,
): Promise<IsolatedCompletionBoundaryFixture> {
  const fixture = await import("../agents/isolated-completion.adapter.test-support.js");
  return fixture.createIsolatedCompletionBoundaryFixture(params);
}
export async function loadWebFetchToolFactoryForTest() {
  return (await import("../agents/tools/web-fetch.js")).createWebFetchTool;
}
export async function loadUserTurnTranscriptRecorderFactoryForTest() {
  return (await import("../sessions/user-turn-transcript.js")).createUserTurnTranscriptRecorder;
}
export { buildPluginApi } from "../plugins/api-builder.js";
export {
  createCapturedPluginRegistration,
  type CapturedPluginRegistration,
} from "../plugins/captured-registration.js";
export {
  createPluginRuntimeMediaMock,
  createPluginRuntimeMock,
  type PluginRuntimeMediaMock,
} from "./test-helpers/plugin-runtime-mock.js";

export { createHookRunner } from "../plugins/hooks.js";
export { explainToolAvailability } from "../agents/tool-availability-explanation.js";
