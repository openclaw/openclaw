import { describe, expect, it } from "vitest";
import type { AgentHarness } from "../../agents/harness/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { markPluginRegistryActive } from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
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

function nativeOwner() {
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
    run: <T>(operation: () => T) => withPluginRuntimeRegistryScope(registry, operation),
  };
}

describe("message cuts and native context ownership", () => {
  it.each(["rewind", "switch"] as const)(
    "retires native context only with a committed %s",
    async (mode) => {
      const { env, scope } = await createSession();
      const owner = nativeOwner();
      const result = await owner.run(() =>
        mode === "rewind"
          ? rewindSessionToMessage({ agentId, env, sessionKey, entryId: "user-2" })
          : switchSessionBranch({ agentId, env, sessionKey, leafEntryId: "off-path-user" }),
      );

      expect(result.status).toBe("created");
      expect(loadSessionEntry(scope)?.previousSessionId).toBe(scope.sessionId);
      expect(owner.binding()).toBeUndefined();
      expect(owner.finalized()).toBe(true);
    },
  );

  it.each(["rewind", "switch"] as const)(
    "restores native context when the local %s transaction fails",
    async (mode) => {
      const { env, scope } = await createSession();
      const owner = nativeOwner();
      const before = loadSessionEntry(scope);
      openOpenClawAgentDatabase({ agentId, env }).db.exec(
        "CREATE TEMP TRIGGER reject_context_cut BEFORE UPDATE ON session_nodes BEGIN SELECT RAISE(ABORT, 'injected context cut failure'); END",
      );
      await expect(
        owner.run(() =>
          mode === "rewind"
            ? rewindSessionToMessage({ agentId, env, sessionKey, entryId: "user-2" })
            : switchSessionBranch({ agentId, env, sessionKey, leafEntryId: "off-path-user" }),
        ),
      ).rejects.toThrow("injected context cut failure");
      expect(loadSessionEntry(scope)).toEqual(before);
      expect(owner.binding()).toBe("native-history-before-cut");
      expect(owner.finalized()).toBe(false);
    },
  );

  it.each([
    ["rewind", "missing", "missing-entry"],
    ["rewind", "assistant-1", "not-user-message"],
    ["rewind", "off-path-user", "off-active-path"],
    ["switch", "missing", "missing-entry"],
    ["switch", "user-1", "not-branch-tip"],
    ["switch", "assistant-2", "already-active"],
  ])("preserves native context after %s rejects %s", async (mode, entryId, status) => {
    const { env, scope } = await createSession();
    const before = loadSessionEntry(scope);
    const owner = nativeOwner();
    const result = await owner.run(() =>
      mode === "rewind"
        ? rewindSessionToMessage({ agentId, env, sessionKey, entryId })
        : switchSessionBranch({ agentId, env, sessionKey, leafEntryId: entryId }),
    );
    expect(result.status).toBe(status);
    expect(loadSessionEntry(scope)).toEqual(before);
    expect(owner.binding()).toBe("native-history-before-cut");
    expect(owner.finalized()).toBe(false);
  });

  it("leaves the source native context intact when forking", async () => {
    const { env, scope } = await createSession();
    const before = loadSessionEntry(scope);
    const owner = nativeOwner();
    const result = await owner.run(() =>
      forkSessionAtMessage({
        agentId,
        env,
        sessionKey,
        entryId: "user-2",
        targetKey: `${sessionKey}:fork`,
      }),
    );
    expect(result.status).toBe("created");
    expect(loadSessionEntry(scope)).toEqual(before);
    expect(owner.binding()).toBe("native-history-before-cut");
    expect(owner.finalized()).toBe(false);
  });
});
