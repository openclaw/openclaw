import assert from "node:assert/strict";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  AgentHarnessSessionDeletionMutation,
  AgentHarnessV2,
} from "../../agents/harness/types.js";
import { deleteSessionEntryLifecycle } from "../../config/sessions/session-accessor.sqlite-lifecycle.js";
import { rewindSessionToMessage } from "../../config/sessions/session-accessor.sqlite-message-cut.js";
import { replaceTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import * as lifecycle from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";

type Hook = "withSessionDeletion" | "withSessionContextReset";
type HostTarget = Parameters<NonNullable<AgentHarnessV2["withSessionContextReset"]>>[0];

/** Exercise plugin cleanup around a real host worker commit or compensated refusal. */
export async function withNativeSessionMutationForTest(params: {
  pluginId: string;
  harness: AgentHarnessV2;
  hook: Hook;
  target: HostTarget & { storePath: string };
  run: (settle: (outcome?: "commit" | "rollback") => Promise<void>) => Promise<void>;
}): Promise<void> {
  const prepare = params.harness[params.hook];
  assert(prepare, `Missing native session fixture hook: ${params.hook}`);
  const refusal = new Error("Synthetic agent transaction commit refusal");
  const refuseCommit = () =>
    sqliteWorkerOwnerProbe.admission(admission, (request, grant, admit) => {
      const facts = isRecord(request.facts) ? request.facts.publication : undefined;
      const nativeBinding = isRecord(facts) && facts.kind === "session-native-binding";
      if (request.stage === "commit" && nativeBinding) {
        throw refusal;
      }
      admit(request, grant);
    });
  let prepared = false;
  const wrapped = async <T>(
    hostTarget: HostTarget,
    commit: (mutation: AgentHarnessSessionDeletionMutation) => Promise<T>,
  ): Promise<T> => {
    for (const key of ["agentId", "sessionKey", "sessionId", "previousSessionId"] as const) {
      assert.equal(hostTarget[key], params.target[key], `Native session target ${key}`);
    }
    prepared = true;
    const assertCurrent = () => {
      hostTarget.assertCurrent();
      params.target.assertCurrent();
    };
    return prepare<T>({ ...hostTarget, assertCurrent }, async (mutation) => {
      const settled: { result?: { value: T } | { error: unknown } } = {};
      await params.run(async (outcome = "commit") => {
        assert(!settled.result, "Native session fixture already settled");
        const probe = outcome === "rollback" ? refuseCommit() : undefined;
        try {
          settled.result = { value: await commit(mutation) };
          assert.notEqual(outcome, "rollback", "Expected agent commit refusal");
        } catch (error) {
          settled.result = { error };
          if (error !== refusal) {
            throw error;
          }
        } finally {
          probe?.mockRestore();
        }
      });
      assert(settled.result, "Native session fixture did not settle its worker transaction");
      if ("error" in settled.result) {
        throw settled.result.error;
      }
      return settled.result.value;
    });
  };
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: params.pluginId }));
  registry.agentHarnesses.push({
    pluginId: params.pluginId,
    source: "runtime",
    harness: { ...params.harness, [params.hook]: wrapped },
  });
  const { agentId, sessionId, sessionKey, storePath } = params.target;
  const scope = { agentId, sessionId, sessionKey, storePath };
  if (params.hook === "withSessionContextReset") {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const message = { role: "user", content: "Synthetic context cut", timestamp: 1 };
    replaceTranscriptEventsSync(scope, [
      { type: "session", id: sessionId, cwd: "/synthetic/workspace", timestamp },
      { type: "message", id: "fixture-user", message },
    ]);
  }
  lifecycle.markPluginRegistryActive(registry);
  try {
    await withPluginRuntimeRegistryScope(registry, async () => {
      if (params.hook === "withSessionContextReset") {
        const result = await rewindSessionToMessage({ ...scope, entryId: "fixture-user" });
        assert.equal(result.status, "created", "Native session rewind");
      } else {
        const result = await deleteSessionEntryLifecycle({
          ...scope,
          target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
          archiveTranscript: false,
        });
        assert(result.deleted, "Native session fixture did not delete its session");
      }
    });
  } catch (error) {
    if (error !== refusal) {
      throw error;
    }
  } finally {
    lifecycle.markPluginRegistryRetired(registry);
  }
  assert(prepared, "Native session fixture host did not invoke its registered harness");
}
