import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it } from "vitest";
import type { AgentHarness } from "../../agents/harness/types.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { markPluginRegistryActive } from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import * as sessions from "./session-accessor.js";
import { useSessionMessageCutFixtures } from "./session-accessor.sqlite-message-cut.test-support.js";

const { createSession } = useSessionMessageCutFixtures();

async function nativeOwner() {
  const { scope, params: cutParams } = await createSession();
  let binding: string | undefined = "native-history-before-cut";
  let finalized = false;
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "native-cut-owner" });
  const harness: AgentHarness = {
    id: "native-context",
    label: "Native cut owner",
    supports: () => ({ supported: true }),
    runAttempt: async () => assert.fail("Unexpected native harness attempt"),
    withSessionContextReset: async (params, run) => {
      params.assertCurrent();
      const previous = binding;
      let committed = false;
      const settle = (next: string | undefined, commit: boolean) => {
        params.assertCurrent();
        binding = next;
        committed = commit;
      };
      try {
        return await run({
          commit: () => settle(undefined, true),
          rollback: () => settle(previous, false),
        });
      } finally {
        if (committed) {
          params.assertCurrent();
          finalized = true;
        }
      }
    },
  };
  registry.plugins.push(record);
  registry.agentHarnesses.push({ harness, pluginId: record.id, source: "runtime" });
  markPluginRegistryActive(registry);
  return {
    sourceId: scope.sessionId,
    before: sessions.loadSessionEntry(scope),
    read: () => ({ entry: sessions.loadSessionEntry(scope), binding, finalized }),
    run: (mode: "rewind" | "switch" | "fork", entryId = "user-2") =>
      withPluginRuntimeRegistryScope(registry, () => {
        const params = { ...cutParams, entryId };
        return mode === "rewind"
          ? sessions.rewindSessionToMessage(params)
          : mode === "switch"
            ? sessions.switchSessionBranch({ ...params, leafEntryId: entryId })
            : sessions.forkSessionAtMessage({ ...params, targetKey: `${params.sessionKey}:fork` });
      }),
  };
}

it.each([
  ["rewind", "user-2", "created"],
  ["switch", "off-path-user", "created"],
  ["fork", "user-2", "created"],
  ["rewind", "missing", "missing-entry"],
  ["rewind", "assistant-1", "not-user-message"],
  ["rewind", "off-path-user", "off-active-path"],
  ["switch", "missing", "missing-entry"],
  ["switch", "user-1", "not-branch-tip"],
  ["switch", "assistant-2", "already-active"],
] as const)("%s at %s: %s preserves or resets native context", async (mode, entryId, status) => {
  const owner = await nativeOwner();
  expect((await owner.run(mode, entryId)).status).toBe(status);
  const reset = status === "created" && mode !== "fork";
  expect(owner.read()).toEqual({
    entry: reset ? expect.objectContaining({ previousSessionId: owner.sourceId }) : owner.before,
    binding: reset ? undefined : "native-history-before-cut",
    finalized: reset,
  });
});

it("preserves native context when the worker cut commit is refused", async () => {
  const owner = await nativeOwner();
  {
    using _ = probe.admission(admission, (request, grant, callback) => {
      const facts = isRecord(request.facts) ? request.facts.publication : undefined;
      if (
        request.stage === "commit" &&
        isRecord(facts) &&
        facts.kind === "session-native-binding"
      ) {
        throw new Error("injected context cut failure");
      }
      callback(request, grant);
    });
    await expect(owner.run("rewind")).rejects.toThrow("injected context cut failure");
  }
  expect(owner.read()).toEqual({
    entry: owner.before,
    binding: "native-history-before-cut",
    finalized: false,
  });
});
