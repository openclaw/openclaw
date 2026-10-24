import path from "node:path";
import { expect, it } from "vitest";
import { loadCodexDynamicToolBuildTestFixture } from "../extensions/codex/test-api.js";
import { preparePluginHarnessParams as prepareHarness } from "../src/agents/harness/plugin-attempt-params.js";
import { resolveSessionStorePathCore } from "../src/config/sessions/paths.js";
import { upsertSessionEntryCore } from "../src/config/sessions/session-accessor.entry.js";
import type { SessionEntry } from "../src/config/sessions/types.js";
import { createDirectChatContext } from "../src/gateway/server-chat.agent-events.test-helpers.js";
import { SessionRowProjectionBinding } from "../src/gateway/session-row-projection-binding.js";
import { createSessionRowCapabilityReader } from "../src/gateway/session-row-projection-identities.js";
import { withPluginRuntimeGatewayContextResolver } from "../src/plugins/runtime/gateway-request-scope.js";
import { beginAgentDeletionJournal } from "../src/test-utils/agent-deletion-journal.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

const harness = {
  id: "codex",
  label: "Codex",
  conversationToolPolicySupport: "exact" as const,
  supports: () => ({ supported: true as const }),
  async runAttempt() {
    throw new Error("Policy preparation must not dispatch a native turn");
  },
};

it.each(["before preparation", "during tool construction"])(
  "builds harness search policy when deletion dirties topology %s",
  async (deletionTiming) => {
    const { buildDynamicToolsForTest, createParams, createRuntimeDynamicTool } =
      await loadCodexDynamicToolBuildTestFixture();
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:dashboard:harness-search";
      const entry: SessionEntry = {
        sessionId: "harness-search",
        updatedAt: 1,
        spawnedBy: "agent:main:main",
        spawnDepth: 1,
        inheritedToolPolicyVersion: 1,
        inheritedToolDeny: ["web_search"],
      };
      const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
      await upsertSessionEntryCore({ agentId: "main", sessionKey, storePath }, entry);
      let topologyDirty = false;
      const readProjection = createSessionRowCapabilityReader({
        state: () => ({ disposed: false, topologyDirty }),
        lookup: () => undefined,
        matching: () => [],
      });
      const context = createDirectChatContext({
        sessionRowProjectionOwner: new SessionRowProjectionBinding({}, (query) =>
          topologyDirty ? readProjection(query) : { entry },
        ),
      });
      const workspaceDir = state.statePath("workspace");
      const params = createParams(path.join(workspaceDir, "session.jsonl"), workspaceDir);
      params.sessionKey = sessionKey;
      params.config = {};
      params.sessionId = entry.sessionId;
      params.disableTools = false;
      const beginDeletion = () => {
        beginAgentDeletionJournal({
          agentId: "retiring",
          operationId: "harness-search-delete",
          agentDir: state.agentDir("retiring"),
          sessionsDir: state.sessionsDir("retiring"),
          workspaceDir: state.statePath("workspace-retiring"),
          deleteFiles: false,
          phase: "draining",
        });
        topologyDirty = true;
      };
      params.hostCapabilities = {
        ...params.hostCapabilities,
        async createToolSurfaceAsync() {
          if (deletionTiming === "during tool construction") {
            beginDeletion();
          }
          return [createRuntimeDynamicTool("message")];
        },
      };
      let persistent: boolean | undefined;
      let allowed: boolean | undefined;
      await withPluginRuntimeGatewayContextResolver(
        () => context,
        async () => {
          if (deletionTiming === "before preparation") {
            beginDeletion();
          }
          const prepared = await prepareHarness(params, harness, false, () => {}, false);
          const tools = await buildDynamicToolsForTest(prepared, workspaceDir, {
            onPersistentWebSearchPolicyResolved: (value) => (persistent = value),
            onWebSearchPolicyResolved: (value) => (allowed = value),
          });
          expect(tools.map((tool) => tool.name)).toEqual(["message"]);
        },
      );
      expect(topologyDirty).toBe(true);
      expect({ persistent, allowed }).toEqual({ persistent: false, allowed: false });
    });
  },
);
