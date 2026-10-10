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
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";

type Hook = "withSessionDeletion" | "withSessionContextReset";
type Target = Parameters<NonNullable<AgentHarnessV2["withSessionContextReset"]>>[0] & {
  storePath: string;
};

/** Exercise plugin cleanup around a real host worker commit or compensated refusal. */
export async function withNativeSessionMutationForTest(params: {
  pluginId: string;
  harness: AgentHarnessV2;
  hook: Hook;
  target: Target;
  run: (settle: (outcome?: "commit" | "rollback") => Promise<void>) => Promise<void>;
}): Promise<void> {
  const prepare = params.harness[params.hook];
  if (!prepare) {
    throw new Error(`Missing native session fixture hook: ${params.hook}`);
  }
  const refusal = new Error("Synthetic agent transaction commit refusal");
  let prepared = false;
  const wrapped = async <T>(
    hostTarget: Parameters<NonNullable<AgentHarnessV2["withSessionContextReset"]>>[0],
    commit: (mutation: AgentHarnessSessionDeletionMutation) => Promise<T>,
  ): Promise<T> => {
    if (
      hostTarget.agentId !== params.target.agentId ||
      hostTarget.sessionKey !== params.target.sessionKey ||
      hostTarget.sessionId !== params.target.sessionId ||
      hostTarget.previousSessionId !== params.target.previousSessionId
    ) {
      throw new Error("Native session fixture host target differs from its expected identity");
    }
    prepared = true;
    return prepare<T>(
      {
        ...hostTarget,
        assertCurrent() {
          hostTarget.assertCurrent();
          params.target.assertCurrent();
        },
      },
      async (mutation) => {
        const settled: { result?: { value: T } | { error: unknown } } = {};
        await params.run(async (outcome = "commit") => {
          if (settled.result) {
            throw new Error("Native session fixture already settled");
          }
          const probe =
            outcome === "rollback"
              ? sqliteWorkerOwnerProbe.admission(admission, (request, grant, admit) => {
                  const facts = isRecord(request.facts) ? request.facts.publication : undefined;
                  if (
                    request.stage === "commit" &&
                    isRecord(facts) &&
                    facts.kind === "session-native-binding"
                  ) {
                    throw refusal;
                  }
                  admit(request, grant);
                })
              : undefined;
          try {
            settled.result = { value: await commit(mutation) };
            if (outcome === "rollback") {
              throw new Error("Native session fixture did not reach agent commit refusal");
            }
          } catch (error) {
            settled.result = { error };
            if (error !== refusal) {
              throw error;
            }
          } finally {
            probe?.mockRestore();
          }
        });
        if (!settled.result) {
          throw new Error("Native session fixture did not settle its worker transaction");
        }
        if ("error" in settled.result) {
          throw settled.result.error;
        }
        return settled.result.value;
      },
    );
  };
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: params.pluginId }));
  registry.agentHarnesses.push({
    pluginId: params.pluginId,
    source: "runtime",
    harness: { ...params.harness, [params.hook]: wrapped },
  });
  const scope = {
    agentId: params.target.agentId,
    sessionId: params.target.sessionId,
    sessionKey: params.target.sessionKey,
    storePath: params.target.storePath,
  };
  if (params.hook === "withSessionContextReset") {
    replaceTranscriptEventsSync(scope, [
      {
        type: "session",
        id: scope.sessionId,
        cwd: "/synthetic/workspace",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        type: "message",
        id: "fixture-user",
        message: { role: "user", content: "Synthetic context cut", timestamp: 1 },
      },
    ]);
  }
  markPluginRegistryActive(registry);
  try {
    await withPluginRuntimeRegistryScope(registry, async () => {
      if (params.hook === "withSessionContextReset") {
        const result = await rewindSessionToMessage({ ...scope, entryId: "fixture-user" });
        if (result.status !== "created") {
          throw new Error(`Native session fixture rewind returned ${result.status}`);
        }
      } else {
        const result = await deleteSessionEntryLifecycle({
          ...scope,
          target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
          archiveTranscript: false,
        });
        if (!result.deleted) {
          throw new Error("Native session fixture did not delete its session");
        }
      }
    });
  } catch (error) {
    if (error !== refusal) {
      throw error;
    }
  } finally {
    markPluginRegistryRetired(registry);
  }
  if (!prepared) {
    throw new Error("Native session fixture host did not invoke its registered harness");
  }
}
