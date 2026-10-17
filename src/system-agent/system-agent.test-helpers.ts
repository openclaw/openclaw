import { expect, vi } from "vitest";
import { resolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import * as authStore from "../agents/auth-profiles/store-runtime.js";
import * as cliAuthEpoch from "../agents/cli-auth-epoch.js";
import { resolveCliBackendConfig } from "../agents/cli-backends.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
// OpenClaw test helpers build runtime environments for rescue tests.
import {
  fingerprintAuthProfileOwnerShape,
  fingerprintOpaqueRuntimeOwner,
  fingerprintResolvedAuthProfileCredential,
  fingerprintResolvedProviderAuth,
} from "../agents/execution-auth-binding.js";
import * as harnessRegistry from "../agents/harness/registry.js";
import * as modelAuth from "../agents/model-auth.js";
import { resolveCliRuntimeExecutionProvider } from "../agents/model-runtime-aliases.js";
import { resolveSimpleCompletionSelectionForAgent } from "../agents/simple-completion-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import {
  bindPluginMetadataSnapshotCache,
  getPluginMetadataSnapshotCache,
} from "../plugins/plugin-cache.js";
import { resolvePluginControlPlaneFingerprint } from "../plugins/plugin-control-plane-context.js";
import {
  loadPluginMetadataSnapshot,
  type resolvePluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import * as pluginArtifactIdentity from "../plugins/plugin-runtime-artifact-identity.js";
import { listSystemAgentAuditEntriesForTests } from "./audit.test-support.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import { createSystemAgentVerifiedInferenceBinding } from "./verified-inference.js";
import { mockPluginRegistry, pluginRecord } from "./verified-inference.test-support.js";

export type SystemAgentPluginMetadataTestSnapshot = {
  /** Rebind one prepared inventory to the exact authored config under test. */
  bind: (
    params: Parameters<typeof resolvePluginMetadataSnapshot>[0],
  ) => ReturnType<typeof resolvePluginMetadataSnapshot>;
  bindForConfig: (
    config: OpenClawConfig,
    workspaceDir?: string,
  ) => ReturnType<typeof resolvePluginMetadataSnapshot>;
  run: <T>(run: () => T, config?: OpenClawConfig) => T;
};

/** Install the contract-level selectable CLI backend used by core system-agent tests. */
export function installSystemAgentClaudeCliBackendTestFixture(): () => void {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        pluginId: "anthropic",
        modelProvider: "anthropic",
        bundleMcp: true,
        bundleMcpMode: "claude-config-file",
        config: { command: "claude" },
        normalizeConfig: (config, context) => ({
          ...config,
          args: [
            ...(config.args ?? []),
            "--test-exec-policy",
            JSON.stringify(context?.config?.tools?.exec ?? null),
          ],
        }),
        nativeToolMode: "selectable",
        toolAvailabilityEnforcement: "execution-args",
        sideQuestionToolMode: "disabled",
        resolveExecutionArgs: (context) => context.baseArgs,
      },
    ],
  });
  return () => cliBackendsTesting.resetDepsForTest();
}

/** Prepare one inventory; each test operation owns its scoped config and environment. */
export function createSystemAgentPluginMetadataTestSnapshot(
  config: OpenClawConfig = {},
): SystemAgentPluginMetadataTestSnapshot {
  const prepared = loadPluginMetadataSnapshot({ config, env: process.env, allowCurrent: false });
  let boundParams: Parameters<typeof resolvePluginMetadataSnapshot>[0] = {
    config,
    env: process.env,
  };
  const prepareSnapshot = (params: Parameters<typeof resolvePluginMetadataSnapshot>[0]) => {
    const policyHash = resolveInstalledPluginIndexPolicyHash(params.config);
    const index =
      prepared.index.policyHash === policyHash ? prepared.index : { ...prepared.index, policyHash };
    const snapshot = {
      ...prepared,
      index,
      policyHash,
      configFingerprint: resolvePluginControlPlaneFingerprint({
        config: params.config,
        env: params.env,
        index,
        policyHash,
        workspaceDir: params.workspaceDir,
      }),
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    };
    bindPluginMetadataSnapshotCache(snapshot, getPluginMetadataSnapshotCache(prepared));
    return snapshot;
  };
  const bind = (params: Parameters<typeof resolvePluginMetadataSnapshot>[0]) => {
    boundParams = params;
    return prepareSnapshot(params);
  };
  return {
    bind,
    bindForConfig: (nextConfig, workspaceDir) =>
      bind({ config: nextConfig, env: process.env, workspaceDir }),
    run: (run, nextConfig) => {
      const params = { ...boundParams, config: nextConfig ?? boundParams.config, env: process.env };
      return withPluginMetadataSnapshotScope(prepareSnapshot(params), run, params);
    },
  };
}

export function readLastSystemAgentAuditEntry(): unknown {
  return listSystemAgentAuditEntriesForTests().at(-1)?.value;
}

function requireTestRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

export function expectTestRecordFields(
  record: Record<string, unknown>,
  fields: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

export function expectSystemAgentAuditRecord(
  audit: unknown,
  fields: Record<string, unknown>,
  detailFields: Record<string, unknown>,
): void {
  const auditRecord = requireTestRecord(audit, "audit record");
  expectTestRecordFields(auditRecord, fields);
  expectTestRecordFields(requireTestRecord(auditRecord.details, "audit details"), detailFields);
}

/** Build exact, revalidatable proof for a test config without reading host credentials. */
export async function createSystemAgentVerifiedInferenceTestFixture(config: OpenClawConfig) {
  const routeAgentId = resolveAmbientOwnerAgentId(config);
  const selection = resolveSimpleCompletionSelectionForAgent({
    cfg: config,
    agentId: routeAgentId,
  });
  const selectedProfileId = selection?.profileId;
  const cliExecutionProvider = selection
    ? resolveCliRuntimeExecutionProvider({
        provider: selection.provider,
        cfg: config,
        agentId: routeAgentId,
        modelId: selection.modelId,
        ...(selectedProfileId ? { authProfileId: selectedProfileId } : {}),
      })
    : undefined;
  const selectedCredential =
    selectedProfileId && selection
      ? ({
          type: "api_key",
          provider: cliExecutionProvider ?? selection.runtimeProvider ?? selection.provider,
          key: "test-key",
        } as const)
      : undefined;
  vi.spyOn(authStore, "loadAuthProfileStoreForRuntimeAsync").mockResolvedValue({
    version: 1,
    profiles:
      selectedProfileId && selectedCredential ? { [selectedProfileId]: selectedCredential } : {},
  });
  const configuredRoute = await resolveSystemAgentConfiguredRouteFromConfig(config);
  if (!configuredRoute) {
    throw new Error("missing test route");
  }
  const profileId = configuredRoute.authProfileId;
  const credential = {
    type: "api_key" as const,
    provider: configuredRoute.provider,
    key: "test-key",
  };
  const resolvedAuth = {
    apiKey: "test-key",
    ...(profileId ? { profileId } : {}),
    source: profileId ? `profile:${profileId}` : "models.json",
    mode: "api-key" as const,
  };
  const configuredHarnessId =
    configuredRoute.runner === "embedded"
      ? configuredRoute.agentHarnessRuntimeOverride === "auto"
        ? "codex"
        : configuredRoute.agentHarnessRuntimeOverride
      : undefined;
  const testOwnerPluginIds = [
    configuredRoute.provider,
    configuredHarnessId,
    configuredRoute.provider === "openai" ? "codex" : undefined,
    configuredRoute.provider === "claude-cli" ? "anthropic" : undefined,
  ].filter((id, index, ids): id is string => Boolean(id) && ids.indexOf(id) === index);
  vi.spyOn(modelAuth, "resolveApiKeyForProviderCore").mockResolvedValue(resolvedAuth);
  const records = testOwnerPluginIds.map((pluginId) => pluginRecord(pluginId));
  mockPluginRegistry(records);
  const fingerprintPluginRuntimeArtifact = vi
    .spyOn(pluginArtifactIdentity, "fingerprintPluginRuntimeArtifact")
    .mockImplementation((record) => `${record.pluginId}-test-runtime-v1`);
  const agentHarnessId =
    configuredRoute.runner === "embedded"
      ? configuredRoute.agentHarnessRuntimeOverride === "auto"
        ? "openclaw"
        : (configuredRoute.agentHarnessRuntimeOverride ?? "codex")
      : undefined;
  const authFingerprint =
    configuredRoute.runner === "cli"
      ? undefined
      : profileId && agentHarnessId !== "openclaw"
        ? fingerprintResolvedAuthProfileCredential({ profileId, credential, resolvedAuth })
        : fingerprintResolvedProviderAuth(resolvedAuth);
  const harnessMock = vi
    .spyOn(harnessRegistry, "getRegisteredAgentHarness")
    .mockImplementation((id) =>
      id === configuredHarnessId || id === "codex"
        ? {
            harness: {
              id,
              label: id,
              authBootstrap: "harness",
              supports: () => ({ supported: true }),
              runAttempt: async () => {
                throw new Error("Synthetic inference never runs a harness");
              },
              runtimeArtifact: { validate: async () => true },
              authBinding: { fingerprint: async () => authFingerprint },
            },
          }
        : undefined,
    );

  if (configuredRoute.runner === "cli") {
    const runtimeArtifactId = configuredRoute.provider;
    const runtimeArtifactFingerprint = `${runtimeArtifactId}-artifact-v1`;
    const authProfileOwnerFingerprint = profileId
      ? fingerprintAuthProfileOwnerShape({ profileId, credential })
      : undefined;
    const resolveRuntimeOwnerFingerprint = (currentConfig: OpenClawConfig) => {
      const backend = resolveCliBackendConfig(configuredRoute.provider, currentConfig, {
        agentId: "openclaw",
      });
      if (!backend || backend.id !== runtimeArtifactId) {
        return undefined;
      }
      return fingerprintOpaqueRuntimeOwner({
        kind: "cli-runtime",
        runner: "cli",
        provider: configuredRoute.provider,
        backendId: backend.id,
        backendConfig: {
          config: backend.config,
          bundleMcp: backend.bundleMcp,
          bundleMcpMode: backend.bundleMcpMode,
          authEpochMode: backend.authEpochMode,
          nativeToolMode: backend.nativeToolMode,
          toolAvailabilityEnforcement: backend.toolAvailabilityEnforcement,
          sideQuestionToolMode: backend.sideQuestionToolMode,
        },
        ...(profileId ? { authProfileId: profileId } : {}),
        ...(authProfileOwnerFingerprint ? { authProfileOwnerFingerprint } : {}),
        runtimeArtifactFingerprint,
      });
    };
    const runtimeOwnerFingerprint = resolveRuntimeOwnerFingerprint(config);
    if (!runtimeOwnerFingerprint) {
      throw new Error("missing test CLI runtime owner fingerprint");
    }
    vi.spyOn(cliAuthEpoch, "resolveCliRuntimeArtifactFingerprint").mockResolvedValue(
      runtimeArtifactFingerprint,
    );
    vi.spyOn(cliAuthEpoch, "resolveCliRuntimeOwnerFingerprint").mockImplementation(
      async (params) =>
        params.runtimeArtifactFingerprint === runtimeArtifactFingerprint
          ? resolveRuntimeOwnerFingerprint(params.config)
          : undefined,
    );
    const binding = await createSystemAgentVerifiedInferenceBinding({
      configuredRoute,
      executionRoute: configuredRoute,
      auth: {
        ...(profileId ? { authProfileId: profileId } : {}),
        runtimeOwnerFingerprint,
        runtimeOwnerKind: "cli-runtime",
        runtimeOwnerId: runtimeArtifactId,
        runtimeArtifactId,
        runtimeArtifactFingerprint,
      },
    });
    return { binding, fingerprintPluginRuntimeArtifact, harnessMock };
  }

  if (!authFingerprint) {
    throw new Error("missing test embedded auth fingerprint");
  }
  const binding = await createSystemAgentVerifiedInferenceBinding({
    configuredRoute,
    executionRoute: configuredRoute,
    auth: {
      ...(profileId ? { authProfileId: profileId } : {}),
      authFingerprint,
      agentHarnessId,
      modelId: configuredRoute.model,
      modelApi:
        configuredRoute.provider === "anthropic" ? "anthropic-messages" : "openai-responses",
      ...(agentHarnessId === "openclaw"
        ? {}
        : {
            runtimeOwnerKind: "plugin-harness" as const,
            runtimeOwnerId: agentHarnessId,
            runtimeArtifactId: `${agentHarnessId}-test-artifact`,
            runtimeArtifactFingerprint: `${agentHarnessId}-test-fingerprint`,
          }),
    },
  });
  return { binding, fingerprintPluginRuntimeArtifact, harnessMock };
}
