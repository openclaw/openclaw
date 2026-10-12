import type { MockInstance } from "vitest";
import type { AgentHarnessV2 } from "../../agents/harness/types.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import {
  createPluginStateKeyedStore,
  createPluginStateKeyedStoreV2,
  createPluginStateSyncKeyedStore,
} from "../../plugin-state/plugin-state-store.js";
import type { PluginStateSyncKeyedStore } from "../../plugin-state/plugin-state-store.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionLifecycleArtifactsCore } from "./session-accessor.sqlite-artifact-cleanup.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "./session-accessor.sqlite-lifecycle.js";
import { emptySessionEntryMaintenancePlan } from "./session-accessor.sqlite-maintenance-store.js";
import { finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort } from "./session-accessor.sqlite-maintenance.js";
import {
  rewindSessionToMessage,
  switchSessionBranch,
} from "./session-accessor.sqlite-message-cut.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";

type NativeBindingTestApi = {
  createNativeBindingDeletionFixture(
    this: void,
    runtime: PluginRuntime,
    session: { agentId: string; sessionId: string; sessionKey: string },
  ): {
    key: string;
    store: PluginStateSyncKeyedStore<Record<string, unknown>>;
    harness: AgentHarnessV2;
  };
};

export type NativeBindingClientTestApi = {
  attachNativeBindingDeletionClient(
    store: PluginStateSyncKeyedStore<Record<string, unknown>>,
    key: string,
  ): Promise<{
    release: MockInstance;
    request: MockInstance;
    subscribed(): boolean;
    close(): void;
  }>;
};

export async function withNativeBindingFixture<T>(
  kind: "codex" | "agentsapi",
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<T>,
  mode: "worker" | "native" = "worker",
): Promise<T> {
  return withOpenClawTestState(
    { scenario: "minimal", label: "native-binding-settlement" },
    async (state) => {
      const fixture = await createFixture(kind, mode, state.env);
      try {
        return await run(fixture);
      } finally {
        markPluginRegistryRetired(fixture.registry);
        await fixture.harness.dispose?.();
      }
    },
  );
}

async function createFixture(
  kind: "codex" | "agentsapi",
  mode: "worker" | "native",
  env: NodeJS.ProcessEnv,
) {
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  const shared = openOpenClawStateDatabase({ env });
  const scope = {
    agentId: "main",
    sessionId: "native-binding-session",
    sessionKey: "agent:main:native-binding",
    storePath: database.path,
    env,
  };
  replaceSessionEntrySync(scope, {
    sessionId: scope.sessionId,
    lifecycleRevision: "native-binding-generation",
    updatedAt: 1,
    agentHarnessId: kind,
  });
  const events = [
    {
      type: "session",
      id: scope.sessionId,
      cwd: "/synthetic/workspace",
      timestamp: "2026-01-01T00:00:00.000Z",
    },
    {
      type: "message",
      id: "synthetic-user",
      message: { role: "user", content: "Retain this transcript", timestamp: 1 },
    },
  ];
  replaceTranscriptEventsSync(scope, events);
  const runtime = createPluginRuntimeMock({
    state: {
      openSyncKeyedStore: <Value>(options: Parameters<typeof createPluginStateSyncKeyedStore>[1]) =>
        createPluginStateSyncKeyedStore<Value>(kind, { ...options, env }),
      openKeyedStore: <Value>(options: Parameters<typeof createPluginStateKeyedStore>[1]) => {
        return createPluginStateKeyedStore<Value>(kind, { ...options, env });
      },
      openKeyedStoreV2: <Value>(
        options: Parameters<typeof createPluginStateKeyedStoreV2>[1],
        authority: Parameters<typeof createPluginStateKeyedStoreV2>[2] = { assertCurrent() {} },
      ) => createPluginStateKeyedStoreV2<Value>(kind, { ...options, env }, authority),
    },
  });
  const { createNativeBindingDeletionFixture } =
    await loadBundledPluginFacade<NativeBindingTestApi>({
      pluginId: kind,
      artifactBasename: "native-session-binding.test-api.js",
    });
  const native = createNativeBindingDeletionFixture(runtime, scope);
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: kind }));
  registry.agentHarnesses.push({ pluginId: kind, source: "runtime", harness: native.harness });
  if (mode === "native") {
    // A released opaque sibling requires native atomicity before either participant
    // executes. The official harness keeps its V2 store and typed native participant.
    registry.agentHarnesses.push({
      pluginId: "core",
      source: "runtime",
      harness: {
        ...native.harness,
        async withSessionDeletion(_params, run) {
          return run({ commit() {}, rollback() {} });
        },
      },
    });
  }
  markPluginRegistryActive(registry);
  const target = { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] };
  return {
    scope,
    database,
    shared,
    registry,
    target,
    events,
    harness: native.harness,
    bindingKey: native.key,
    bindingStore: native.store,
    readEntry: () => readExactSessionEntryRow(database, scope.sessionKey)?.entry,
    readBinding: () => native.store.lookup(native.key),
    cleanup: () =>
      withPluginRuntimeRegistryScope(registry, () =>
        cleanupSessionLifecycleArtifactsCore({
          ...scope,
          sessionKeySegmentPrefix: "native-binding",
          transcriptContentMarker: "Retain this transcript",
          orphanTranscriptMinAgeMs: 0,
          archiveRemovedEntryTranscripts: false,
        }),
      ),
    maintain: (expectedEntry: NonNullable<ReturnType<typeof readExactSessionEntryRow>>["entry"]) =>
      withPluginRuntimeRegistryScope(registry, () =>
        finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(
          { ...scope, path: database.path },
          [
            {
              ...emptySessionEntryMaintenancePlan(),
              entryRemovals: [
                { sessionKey: scope.sessionKey, expectedEntry, maintenanceReason: "pruned" },
              ],
            },
          ],
        ),
      ),
    cut: (cutMode: "rewind" | "switch", entryId: string) =>
      withPluginRuntimeRegistryScope(registry, () =>
        cutMode === "rewind"
          ? rewindSessionToMessage({ ...scope, entryId })
          : switchSessionBranch({ ...scope, leafEntryId: entryId }),
      ),
    remove: (options: { archiveTranscript?: boolean } = {}) =>
      withPluginRuntimeRegistryScope(registry, () =>
        deleteSessionEntryLifecycle({
          ...scope,
          target,
          archiveTranscript: options.archiveTranscript ?? false,
          deleteTranscriptWithoutArchive: true,
        }),
      ),
  };
}
