import { resolveEffectiveAgentDir } from "../../agents/agent-scope-config.js";
import { resolveSharedAuthStoreOwnershipAsync } from "../../agents/auth-profiles/path-resolve.js";
import { getRegisteredAgentHarness } from "../../agents/harness/registry.js";
import { readSessionRuntimeOwnershipAsync } from "../../agents/harness/session-runtime-ownership.js";
import type { AgentHarnessSessionRuntimeOwnership } from "../../agents/harness/types.js";
import { resolveLegacyInheritedAuthAgentId } from "../../agents/legacy-inherited-auth-dir.js";
import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../agents/model-selection-cli.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection-config.js";
import { resolveSessionConfiguredDefault } from "../../agents/session-model-ref.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { captureRuntimeStateEnvironment } from "../../config/paths.js";
import type { SessionEntry } from "../../config/sessions.js";
import { withSessionEntriesFromStoresInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareBundledDiscoveryMode } from "../../plugins/bundled-discovery-state.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { resolvePluginMetadataSnapshotAsync } from "../../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "../../plugins/runtime-state.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import { resolveStoredModelOverrideAsync } from "../../sessions/stored-model-overrides.js";
import type { GatewayAgentRuntime } from "../../shared/session-types.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import { resolveSessionSelectedModelRef } from "../session-utils-model-selection.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import type { GatewaySessionStoreTargetWithStore } from "../session-utils-store.types.js";
import { resolveWorkerPlacementCapabilities } from "./placement-capabilities.js";
import type { WorkerPlacementExecutionMode } from "./placement-record.js";

export { resolveWorkerPlacementCapabilities } from "./placement-capabilities.js";

export function resolveWorkerPlacementSessionRuntime(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  agentId: string;
  sessionKey: string;
  preparedRuntimeOwnership?: AgentHarnessSessionRuntimeOwnership | null;
  readSourceEntry: (key: string) => SessionEntry | undefined;
}): string {
  const { provider, model } = resolveSessionSelectedModelRef({
    ...params,
    preparedRuntimeOwnership: params.preparedRuntimeOwnership,
    source: {
      entry: params.entry,
      readSourceEntry: params.readSourceEntry,
    },
  });
  return resolveWorkerPlacementModelRuntime({ ...params, provider, model });
}

export async function resolveWorkerPlacementSessionRuntimeAsync(
  params: Omit<
    Parameters<typeof resolveWorkerPlacementSessionRuntime>[0],
    "preparedRuntimeOwnership" | "readSourceEntry"
  > & {
    assertCurrent?: () => void;
    readSourceEntry?: (key: string) => Promise<SessionEntry | undefined>;
  },
): Promise<string> {
  const preparedEnvironment = captureRuntimeStateEnvironment();
  const workspaceDir = getActivePluginRegistryWorkspaceDirFromState();
  const [metadataSnapshot, activateDiscovery] = await Promise.all([
    resolvePluginMetadataSnapshotAsync({
      config: params.cfg,
      env: preparedEnvironment,
      ...(workspaceDir ? { workspaceDir } : {}),
      allowWorkspaceScopedCurrent: true,
    }),
    prepareBundledDiscoveryMode(preparedEnvironment),
    resolveSharedAuthStoreOwnershipAsync(
      captureOpenClawStateReadWorkerContext({ env: preparedEnvironment }),
    ),
  ]);
  params.assertCurrent?.();
  activateDiscovery();
  return withPluginMetadataSnapshotScope(
    metadataSnapshot,
    async () => {
      const ownership = await readSessionRuntimeOwnershipAsync({
        config: params.cfg,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionEntry: params.entry,
        assertCurrent: params.assertCurrent,
        readPreparedPreviousSessionId: () => params.entry.previousSessionId,
      });
      params.assertCurrent?.();
      const configured =
        ownership?.modelRef ?? resolveSessionConfiguredDefault(params.cfg, params.agentId);
      const storedOverride = ownership?.modelRef
        ? null
        : await resolveStoredModelOverrideAsync({
            sessionEntry: params.entry,
            sessionKey: params.sessionKey,
            parentSessionKey: params.entry.parentSessionKey,
            defaultProvider: configured.provider,
            loadSessionEntry:
              params.readSourceEntry ?? ((key) => readWorkerPlacementModelSource(params, key)),
          });
      params.assertCurrent?.();
      return resolveWorkerPlacementModelRuntime({
        ...params,
        provider: storedOverride?.provider ?? configured.provider,
        model: storedOverride?.model ?? configured.model,
        preparedRuntimeOwnership: ownership ?? null,
        preparedEnvironment,
        metadataSnapshot,
      });
    },
    {
      config: params.cfg,
      env: preparedEnvironment,
      ...(workspaceDir ? { workspaceDir } : {}),
    },
  );
}

/** Preserve qualified parent precedence and sentinel physical ownership during async selection. */
export async function readWorkerPlacementModelSource(
  params: Pick<
    Parameters<typeof resolveWorkerPlacementSessionRuntimeAsync>[0],
    "cfg" | "agentId" | "sessionKey" | "assertCurrent"
  > & {
    initialTarget?: GatewaySessionStoreTargetWithStore;
  },
  key: string,
): Promise<SessionEntry | undefined> {
  const metadata = captureSessionEntryMetadataRead(
    { sessionKey: key, agentId: params.agentId },
    () => params.assertCurrent?.(),
  );
  if (metadata) {
    return metadata.readCurrent();
  }
  if (key === "global" || key === "unknown") {
    const target =
      params.initialTarget ??
      (await resolveGatewaySessionStoreTargetInWorker({
        cfg: params.cfg,
        agentId: params.agentId,
        key: params.sessionKey,
        assertActive: params.assertCurrent,
      }));
    return await withSessionEntriesFromStoresInWorker(
      [
        {
          agentId: target.readSource?.agentId ?? target.agentId,
          storePath: target.readSource?.path ?? target.storePath,
          sessionKeys: [key],
          projection: "exact",
        },
      ],
      ([read]) => {
        params.assertCurrent?.();
        return read!.result.entries.find((row) => row.sessionKey === key)?.entry;
      },
    );
  }
  const agentId = parseAgentSessionKey(key)?.agentId ?? params.agentId;
  const storedKey = resolveStoredSessionKeyForAgentStore({
    cfg: params.cfg,
    agentId,
    sessionKey: key,
    preserveQualifiedAddress: true,
  });
  const stored = await resolveGatewaySessionStoreTargetInWorker({
    cfg: params.cfg,
    agentId,
    key: storedKey,
    preserveQualifiedAddress: true,
    assertActive: params.assertCurrent,
  });
  const entry = stored.store[storedKey];
  if (entry || isIncognitoSessionKey(storedKey)) {
    return entry;
  }
  const aliasKey = resolveStoredSessionKeyForAgentStore({
    cfg: params.cfg,
    agentId,
    sessionKey: key,
  });
  if (aliasKey === storedKey) {
    return undefined;
  }
  const aliased = await resolveGatewaySessionStoreTargetInWorker({
    cfg: params.cfg,
    agentId: params.agentId,
    key,
    assertActive: params.assertCurrent,
  });
  return aliased.store[aliased.canonicalKey];
}

export function resolveWorkerPlacementModelRuntime(
  params: Omit<Parameters<typeof resolveWorkerPlacementSessionRuntime>[0], "readSourceEntry"> & {
    provider: string;
    model: string;
    preparedEnvironment?: NodeJS.ProcessEnv;
    metadataSnapshot?: PluginMetadataSnapshot | null;
    resolveEmbeddedRuntime?: () => string;
  },
): string {
  const sessionRuntimeOverride = resolveSessionRuntimeOverrideForProvider(params);
  if (params.cfg.cloudWorkers?.requiredProfile) {
    return "openclaw";
  }
  const pinnedHarnessId = resolveSessionPinnedHarnessId(params.entry);
  const locksPersistedHarness =
    pinnedHarnessId !== undefined && pinnedHarnessId === sessionRuntimeOverride;
  const pinnedCliRuntime =
    !locksPersistedHarness &&
    sessionRuntimeOverride &&
    isCliProvider(sessionRuntimeOverride, params.cfg, params.metadataSnapshot)
      ? sessionRuntimeOverride
      : undefined;
  // When a non-CLI override is active the dispatch path skips CLI aliasing
  // entirely and runs the embedded runtime; the guard must not reject that.
  const cliExecutionProvider =
    pinnedCliRuntime ??
    (sessionRuntimeOverride
      ? undefined
      : resolveCliRuntimeExecutionProvider({
          ...params,
          metadataSnapshot:
            params.metadataSnapshot === null ? { plugins: [] } : params.metadataSnapshot,
          modelId: params.model,
          authProfileId: params.entry.authProfileOverride,
          preparedAuthDirectories: {
            env: params.preparedEnvironment ?? captureRuntimeStateEnvironment(),
            get agentDir() {
              return resolveEffectiveAgentDir(params.cfg, params.agentId, { env: this.env });
            },
            get inheritedAuthDir() {
              return resolveEffectiveAgentDir(
                params.cfg,
                resolveLegacyInheritedAuthAgentId(params.cfg),
                { env: this.env },
              );
            },
          },
        }));
  const useCliExecution =
    pinnedCliRuntime !== undefined ||
    (!sessionRuntimeOverride &&
      isCliProvider(cliExecutionProvider ?? params.provider, params.cfg, params.metadataSnapshot));
  return useCliExecution
    ? (cliExecutionProvider ?? params.provider)
    : (params.resolveEmbeddedRuntime?.() ??
        resolveEffectiveAgentRuntime({
          cfg: params.cfg,
          provider: params.provider,
          modelId: params.model,
          agentScope: { kind: "prepared", agentId: params.agentId },
          sessionKey: params.sessionKey,
          sessionEntry: params.entry,
        }));
}

export function resolveWorkerPlacementExecutionMode(
  runtime: string,
): WorkerPlacementExecutionMode | undefined {
  return resolveWorkerPlacementCapabilities(runtime).executionMode;
}

/** Projects the same configured runtime choice a new default-model dashboard session will persist. */
export function resolveDefaultWorkerPlacementExecutionMode(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): WorkerPlacementExecutionMode | undefined {
  const { provider, model } = resolveDefaultModelForAgent(params);
  const runtime = resolveWorkerPlacementModelRuntime({
    ...params,
    provider,
    model,
    entry: { sessionId: "prepared-pool-presence", updatedAt: 0 },
    sessionKey: `agent:${params.agentId}:dashboard:prepared-pool-presence`,
  });
  return resolveWorkerPlacementExecutionMode(runtime);
}

export function projectWorkerPlacementAgentRuntime(
  runtime: GatewayAgentRuntime,
): GatewayAgentRuntime & {
  cloudPlacementSupported: boolean;
  cloudPlacementExecutionMode?: WorkerPlacementExecutionMode;
  devicePlacement?: NonNullable<GatewayAgentRuntime["devicePlacement"]>;
  devicePlacementSupported: boolean;
} {
  const { source, workspaceEnvironment: _previousEnvironment, ...identity } = runtime;
  const { executionMode, devicePlacement } = resolveWorkerPlacementCapabilities(runtime.id);
  const workspaceEnvironment = getRegisteredAgentHarness(runtime.id)?.harness.workspaceEnvironment;
  return {
    ...identity,
    // Registered harness metadata can be a managed view; rows own the JSON they freeze.
    ...(workspaceEnvironment ? { workspaceEnvironment: { ...workspaceEnvironment } } : {}),
    cloudPlacementSupported: executionMode !== undefined,
    ...(executionMode ? { cloudPlacementExecutionMode: executionMode } : {}),
    ...(devicePlacement ? { devicePlacement } : {}),
    devicePlacementSupported: devicePlacement !== undefined,
    source,
  };
}
