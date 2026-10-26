import { expect, it } from "vitest";
import { createNativeSessionBindingLifecycleV2 } from "../../agents/harness/native-session/binding-lifecycle.js";
import { bindingTestOptions } from "../../agents/harness/native-session/binding.test-support.js";
import { wrapNativeSessionDeletionMutation } from "../../agents/harness/native-session/deletion-participant.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import { createPluginStateKeyedStoreV2 } from "../../plugin-state/plugin-state-store.js";
import { seedPluginStateEntriesForTests } from "../../plugin-state/plugin-state-store.test-helpers.js";
import type { PluginStateActionAuthority } from "../../plugin-state/plugin-state-store.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  createSessionEntryWithTranscript,
  deleteSessionEntryLifecycle,
  loadSessionEntry,
} from "./session-accessor.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { withSessionActorStorage } from "./session-actor-storage-binding.js";

type Binding = {
  version: 1;
  state: "cleared";
  sessionId: string;
  lease?: { token: string; expiresAt: number };
};

it.each(["commit", "rollback", "revoked"])(
  "settles incognito native binding deletion without MAIN SQL (%s)",
  async (mode) => {
    const rollback = mode === "rollback";
    await withOpenClawTestState({ label: "memory-native-binding" }, async ({ env }) => {
      setRuntimeConfigSnapshot({});
      const sessionKey = "agent:main:dashboard:incognito-native-binding";
      const scope = { agentId: "main", sessionKey, env };
      const withCurrent = (authority: PluginStateActionAuthority) =>
        createPluginStateKeyedStoreV2<Binding>(
          "codex",
          { namespace: "native-binding-proof", maxEntries: 10, env, overflowPolicy: "reject-new" },
          authority,
        );
      const state = { ...withCurrent({ assertCurrent() {} }), withCurrent };
      const original: Binding = { version: 1, state: "cleared", sessionId: "private-session" };
      await state.register(sessionKey, original);
      let settling = false;
      let authorityCurrent = true;
      const lifecycle = createNativeSessionBindingLifecycleV2(state, {
        ...bindingTestOptions,
        readRecord: (raw: unknown) => {
          // Revoke the outer cleanup authority when the worker observation returns.
          if (settling && mode === "revoked") {
            authorityCurrent = false;
          }
          return raw as Binding | undefined;
        },
        workerCodec: "codex",
      });
      const registry = createEmptyPluginRegistry();
      let sql: ReturnType<typeof observeMainThreadSql>;
      const harness: AgentHarness = {
        id: "native-proof",
        label: "Native binding proof",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("unused");
        },
        withSessionDeletion(params, run) {
          return lifecycle.withDeletion(
            sessionKey,
            {
              assertCurrent: params.assertCurrent,
              assertRecordCurrent() {},
              prepareLease: (current, lease) => current && { ...current, lease },
            },
            async (_current, mutation) => {
              if (rollback) {
                seedPluginStateEntriesForTests([
                  {
                    pluginId: "codex",
                    namespace: "native-binding-proof",
                    key: "expired-companion",
                    value: original,
                    expiresAt: 1,
                  },
                ]);
                // Measure settlement after fixture seeding, including restoration's expiry cleanup.
                sql.clear();
              }
              settling = true;
              return run(
                wrapNativeSessionDeletionMutation(mutation, {
                  assertCurrent() {
                    params.assertCurrent();
                    if (!authorityCurrent) {
                      throw new Error("outer cleanup authority revoked");
                    }
                  },
                  committed() {
                    if (rollback) {
                      throw new Error("injected companion failure");
                    }
                  },
                  rolledBack() {},
                }),
              );
            },
          );
        },
      };
      const record = createPluginRecord({ id: "native-proof" });
      registry.plugins.push(record);
      registry.agentHarnesses.push({ harness, pluginId: record.id, source: "runtime" });
      markPluginRegistryActive(registry);
      using registryCleanup = new DisposableStack();
      registryCleanup.defer(() => markPluginRegistryRetired(registry));
      await withPluginRuntimeRegistryScope(registry, () =>
        withSessionActorStorage(
          scope,
          {
            authority: { assertCurrent() {}, authorize() {} },
            lifetime: { assertCurrent() {}, assertReadable() {} },
            create: true,
          },
          async (memory) => {
            using storageCleanup = new DisposableStack();
            storageCleanup.defer(() => memorySessionActorOwners.closeDatabase(memory));
            await createSessionEntryWithTranscript(scope, () => ({
              ok: true,
              entry: {
                sessionId: original.sessionId,
                updatedAt: 1,
                incognito: true,
                agentHarnessId: harness.id,
              },
            }));
            sql = observeMainThreadSql();
            storageCleanup.defer(sql.restore);
            sql.calibrate();
            const deletion = deleteSessionEntryLifecycle({
              ...scope,
              storePath: memory.path,
              target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
              archiveTranscript: false,
              deleteTranscriptWithoutArchive: true,
            });
            if (mode !== "commit") {
              await expect(deletion).rejects.toThrow(
                rollback ? "injected companion failure" : "outer cleanup authority revoked",
              );
              expect(await state.lookup(sessionKey)).toMatchObject(original);
              expect(loadSessionEntry(scope)).toMatchObject({ sessionId: original.sessionId });
            } else {
              expect(await deletion).toMatchObject({ deleted: true });
              expect(await state.lookup(sessionKey)).toBeUndefined();
              expect(loadSessionEntry(scope)).toBeUndefined();
            }
            sql.expectIdle();
          },
        ),
      );
    });
  },
);
