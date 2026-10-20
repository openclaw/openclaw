import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import type { AgentHarness } from "../../agents/harness/types.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { markPluginRegistryActive } from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import {
  forkSessionAtMessage,
  loadSessionEntry,
  rewindSessionToMessage,
  switchSessionBranch,
} from "./session-accessor.js";
import {
  agentId,
  sessionKey,
  useSessionMessageCutFixtures,
} from "./session-accessor.sqlite-message-cut.test-support.js";

const { createSession } = useSessionMessageCutFixtures();

function nativeOwner(env: NodeJS.ProcessEnv) {
  let binding: string | undefined = "native-history-before-cut";
  let finalized = false;
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "native-cut-owner" });
  const harness: AgentHarness = {
    id: "native-context",
    label: "Native cut owner",
    supports: () => ({ supported: true }),
    runAttempt: async () => {
      throw new Error("not used");
    },
    withSessionContextReset: async (params, run) => {
      params.assertCurrent();
      const previous = binding;
      let committed = false;
      try {
        return await run({
          commit() {
            params.assertCurrent();
            binding = undefined;
            committed = true;
          },
          rollback() {
            params.assertCurrent();
            binding = previous;
            committed = false;
          },
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
    binding: () => binding,
    finalized: () => finalized,
    run: (mode: "rewind" | "switch" | "fork", entryId = "user-2") =>
      withPluginRuntimeRegistryScope(registry, () => {
        const params = { agentId, env, sessionKey, entryId };
        return mode === "rewind"
          ? rewindSessionToMessage(params)
          : mode === "switch"
            ? switchSessionBranch({ ...params, leafEntryId: entryId })
            : forkSessionAtMessage({ ...params, targetKey: `${sessionKey}:fork` });
      }),
  };
}

it.each(["rewind", "switch", "fork"] as const)(
  "preserves source context only when the committed cut is a fork (%s)",
  async (mode) => {
    const { env, scope } = await createSession();
    const before = loadSessionEntry(scope);
    const owner = nativeOwner(env);
    const result = await owner.run(mode, mode === "switch" ? "off-path-user" : "user-2");

    expect(result.status).toBe("created");
    if (mode === "fork") {
      expect(loadSessionEntry(scope)).toEqual(before);
    } else {
      expect(loadSessionEntry(scope)?.previousSessionId).toBe(scope.sessionId);
    }
    expect(owner.binding()).toBe(mode === "fork" ? "native-history-before-cut" : undefined);
    expect(owner.finalized()).toBe(mode !== "fork");
  },
);

it("preserves native context when the worker cut commit is refused", async () => {
  const { env, scope } = await createSession();
  const owner = nativeOwner(env);
  const before = loadSessionEntry(scope);
  const fault = probe.admission(admission, (request, grant, callback) => {
    const facts = isRecord(request.facts) ? request.facts.publication : undefined;
    if (request.stage === "commit" && isRecord(facts) && facts.kind === "session-native-binding") {
      throw new Error("injected context cut failure");
    }
    callback(request, grant);
  });
  try {
    await expect(owner.run("rewind")).rejects.toThrow("injected context cut failure");
  } finally {
    fault.mockRestore();
  }
  expect(loadSessionEntry(scope)).toEqual(before);
  expect(owner.binding()).toBe("native-history-before-cut");
  expect(owner.finalized()).toBe(false);
});

it.each([
  ["rewind", "missing", "missing-entry"],
  ["rewind", "assistant-1", "not-user-message"],
  ["rewind", "off-path-user", "off-active-path"],
  ["switch", "missing", "missing-entry"],
  ["switch", "user-1", "not-branch-tip"],
  ["switch", "assistant-2", "already-active"],
] as const)("preserves native context after %s rejects %s", async (mode, entryId, status) => {
  const { env, scope } = await createSession();
  const before = loadSessionEntry(scope);
  const owner = nativeOwner(env);
  const result = await owner.run(mode, entryId);
  expect(result.status).toBe(status);
  expect(loadSessionEntry(scope)).toEqual(before);
  expect(owner.binding()).toBe("native-history-before-cut");
  expect(owner.finalized()).toBe(false);
});
