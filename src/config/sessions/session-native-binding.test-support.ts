import type { MockInstance } from "vitest";
import type { AgentHarnessV2 } from "../../agents/harness/types.js";
import { withEngineStoreAdmission as admitted } from "../../infra/database-engine/admission-scope.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import {
  createPluginStateKeyedStore,
  createPluginStateKeyedStoreV2,
  createPluginStateSyncKeyedStore,
} from "../../plugin-state/plugin-state-store.js";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
  PluginStateSyncKeyedStore,
} from "../../plugin-state/plugin-state-store.types.js";
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
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type NativeBindingTestApi = {
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
    this: void,
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
  run: (fixture: Awaited<ReturnType<typeof createNativeBindingFixture>>) => Promise<T>,
  mode: "worker" | "legacy" = "worker",
): Promise<T> {
  return withOpenClawTestState(
    { scenario: "minimal", label: "native-binding-settlement" },
    async (state) => {
      const fixture = await createNativeBindingFixture(kind, mode, state.env);
      try {
        return await run(fixture);
      } finally {
        markPluginRegistryRetired(fixture.registry);
        await fixture.harness.dispose?.();
      }
    },
  );
}

export async function createNativeBindingFixture(
  kind: "codex" | "agentsapi",
  mode: "worker" | "legacy",
  env: NodeJS.ProcessEnv,
  sessionId = "native-binding-session",
) {
  const database = admitted(() => openOpenClawAgentDatabase({ agentId: "main", env }));
  const shared = admitted(() => openOpenClawStateDatabase({ env }));
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey:
      sessionId === "native-binding-session"
        ? "agent:main:native-binding"
        : `agent:main:${sessionId}`,
    storePath: database.path,
    env,
  };
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
  admitted(() => {
    replaceSessionEntrySync(scope, {
      sessionId,
      lifecycleRevision: "native-binding-generation",
      updatedAt: 1,
      agentHarnessId: kind,
    });
    replaceTranscriptEventsSync(scope, events);
  });
  const runtime = createPluginRuntimeMock({
    state: {
      openSyncKeyedStore: <Value>(options: OpenKeyedStoreOptions) =>
        createPluginStateSyncKeyedStore<Value>(kind, { ...options, env }),
      openKeyedStore: <Value>(options: OpenAsyncKeyedStoreOptions) =>
        createPluginStateKeyedStore<Value>(kind, { ...options, env }),
      openKeyedStoreV2: <Value>(
        options: OpenAsyncKeyedStoreOptions,
        authority = { assertCurrent() {} },
      ) => createPluginStateKeyedStoreV2<Value>(kind, { ...options, env }, authority),
    },
  });
  const { createNativeBindingDeletionFixture } =
    await loadBundledPluginFacade<NativeBindingTestApi>({
      pluginId: kind,
      artifactBasename: "native-session-binding.test-api.js",
    });
  const native = admitted(() => createNativeBindingDeletionFixture(runtime, scope));
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: kind }));
  registry.agentHarnesses.push({ pluginId: kind, source: "runtime", harness: native.harness });
  if (mode === "legacy") {
    // Legacy opaque cleanup must coexist with the typed worker participant.
    registry.agentHarnesses.push({
      pluginId: "core",
      source: "runtime",
      harness: {
        ...native.harness,
        withSessionDeletion: async (_params, run) => run({ commit() {}, rollback() {} }),
      },
    });
  }
  markPluginRegistryActive(registry);
  const target = { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] };
  const inRegistry =
    <Args extends unknown[], T>(run: (...args: Args) => T) =>
    (...args: Args) =>
      withPluginRuntimeRegistryScope(registry, () => run(...args));
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
    readEntry: () => admitted(() => readExactSessionEntryRow(database, scope.sessionKey)?.entry),
    readBinding: () => admitted(() => native.store.lookup(native.key)),
    cleanup: inRegistry(() =>
      cleanupSessionLifecycleArtifactsCore({
        ...scope,
        sessionKeySegmentPrefix: "native-binding",
        transcriptContentMarker: "Retain this transcript",
        orphanTranscriptMinAgeMs: 0,
        archiveRemovedEntryTranscripts: false,
      }),
    ),
    maintain: inRegistry((expectedEntry: SessionEntry) => {
      const plan = emptySessionEntryMaintenancePlan();
      plan.entryRemovals.push({
        sessionKey: scope.sessionKey,
        expectedEntry,
        maintenanceReason: "pruned",
      });
      return finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(
        { ...scope, path: database.path },
        [plan],
      );
    }),
    cut: inRegistry((cutMode: "rewind" | "switch", entryId: string) =>
      cutMode === "rewind"
        ? rewindSessionToMessage({ ...scope, entryId })
        : switchSessionBranch({ ...scope, leafEntryId: entryId }),
    ),
    remove: inRegistry((options: { archiveTranscript?: boolean } = {}) =>
      deleteSessionEntryLifecycle({
        ...scope,
        target,
        archiveTranscript: options.archiveTranscript ?? false,
        deleteTranscriptWithoutArchive: true,
      }),
    ),
  };
}
