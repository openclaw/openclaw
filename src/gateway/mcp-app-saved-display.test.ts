import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { staticRuntime } from "../agents/agent-bundle-mcp-fixture.test-support.js";
import {
  buildMcpAppCanvasPayload,
  fetchMcpAppView,
  getMcpAppViewLease,
} from "../agents/mcp-ui-resource.js";
import { testing } from "../agents/mcp-ui-resource.test-support.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { createSessionEntryWithTranscript } from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { acquireSessionActorStorage } from "../config/sessions/session-actor-storage-acquisition.js";
import {
  runWithSessionActorStorage,
  type SelectedSessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import { useTranscriptFixture } from "./session-transcript-fixtures.test-support.js";
import {
  readSessionMessagesAsync,
  readSessionTranscriptSummaryAsync,
} from "./session-transcript-readers.js";

describe("saved MCP App display", () => {
  const fixture = useTranscriptFixture("mcp-app-saved-display-");
  const bindings: SelectedSessionActorStorageBinding[] = [];
  afterEach(async () => {
    testing.clearViewStore();
    for (const binding of bindings.splice(0)) {
      await binding.actor.release();
      memorySessionActorOwners.closeDatabase(binding);
    }
  });

  it.each(["incognito", "durable"] as const)(
    "restores an expired %s App offline without exposing private display data to chat or model context",
    async (storage) => {
      const env = { OPENCLAW_STATE_DIR: fixture.path(storage) };
      const scope = {
        agentId: "main",
        sessionId: "saved-display",
        sessionKey:
          storage === "incognito"
            ? "agent:main:dashboard:incognito-saved-display"
            : "agent:main:dashboard:saved-display",
        storePath: (storage === "incognito"
          ? resolveIncognitoOpenClawAgentSqlitePath
          : resolveOpenClawAgentSqlitePath)({ agentId: "main", env }),
        env,
      };
      const authority = { assertCurrent() {}, authorize() {} };
      const consume = async (run: () => Promise<void>) => {
        if (storage === "durable") {
          expect(
            await createSessionEntryWithTranscript(
              scope,
              () => ({
                ok: true,
                entry: { sessionId: scope.sessionId, updatedAt: 1 },
              }),
              { cwd: "/tmp" },
            ),
          ).toMatchObject({ ok: true });
          return run();
        }
        const binding = await acquireSessionActorStorage(scope, {
          authority,
          lifetime: { assertCurrent() {}, assertReadable() {} },
          create: true,
        });
        assert(binding);
        bindings.push(binding);
        expect(
          await binding.actor.storage.mutate(
            {
              type: "session.entry.create",
              input: {
                entry: { sessionId: scope.sessionId, lifecycleRevision: "initial", updatedAt: 1 },
                cwd: "/tmp",
              },
            },
            authority,
          ),
        ).toMatchObject({ kind: "committed" });

        return runWithSessionActorStorage(binding, run);
      };
      await consume(async () => {
        const callTool = vi.fn();
        const html = "<main>Saved diagram</main>";
        const readResource = vi.fn(async () => ({
          contents: [{ mimeType: "text/html;profile=mcp-app", text: html }],
        }));
        const runtime = staticRuntime({
          ...scope,
          workspaceDir: "/tmp",
          configFingerprint: "saved",
          readResource,
          callTool,
          getCatalog: async () => ({ version: 1, generatedAt: 0, servers: {}, tools: [] }),
          peekCatalog: () => null,
        });
        const toolResult = {
          content: [{ type: "text" as const, text: "created once" }],
          _meta: { checkpoint: "private-synthetic-checkpoint" },
        };
        const descriptor = await fetchMcpAppView({
          runtime,
          agentId: "main",
          serverName: "demo",
          toolName: "show",
          uiResourceUri: "ui://demo/app",
          toolCallId: "call-1",
          toolInput: { city: "Paris" },
          toolResult,
          requesterId: "alice",
        });
        assert(descriptor);
        const manager = await SessionManager.openAsync(scope, "/tmp");
        await manager.appendMessageAsync({ role: "user", content: "Show Paris", timestamp: 1 });
        await manager.appendMessageAsync(
          makeAgentAssistantMessage({
            content: [
              { type: "toolCall", id: "call-1", name: "demo__show", arguments: { city: "Paris" } },
            ],
            stopReason: "toolUse",
          }),
        );
        await manager.appendMessageAsync({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "demo__show",
          content: toolResult.content,
          details: {
            mcpServer: "demo",
            mcpTool: "show",
            mcpAppPreview: buildMcpAppCanvasPayload({
              ...descriptor,
              resultMetaState: "unavailable",
            }),
          },
          isError: false,
          timestamp: 3,
        });
        const reopened = await SessionManager.openAsync(scope, "/tmp");
        expect(reopened.getEntries().filter((entry) => entry.type === "custom")).toMatchObject([
          {
            type: "custom",
            customType: "mcp-app-display",
            data: { html, toolResult },
          },
        ]);
        const lease = getMcpAppViewLease(descriptor.viewId, runtime);
        assert(lease);
        lease.expiresAtMs = Date.now() - 1;
        expect(getMcpAppViewLease(descriptor.viewId, runtime)).toBeUndefined();
        readResource.mockRejectedValue(new Error("offline"));
        const { data } = await readSessionTranscriptSummaryAsync(scope, {
          kind: "mcp-app",
          lookup: { viewId: descriptor.viewId },
        });
        assert(data?.savedDisplay, "live-admitted display must survive durable selection");
        expect(data.savedDisplay).toMatchObject({
          html,
          requesterId: "alice",
          toolResult,
        });
        const restored = await fetchMcpAppView({
          runtime,
          agentId: "main",
          ...data.descriptor,
          toolInput: data.toolInput,
          toolResult: data.toolResult,
          savedDisplay: data.savedDisplay,
          requesterId: data.savedDisplay.requesterId,
          allowedAppToolNames: new Set(),
          readOnly: true,
        });
        assert(restored);
        expect(getMcpAppViewLease(restored.viewId, runtime)).toMatchObject({
          html,
          toolResult,
          readOnly: true,
          requesterId: "alice",
        });
        expect(readResource).toHaveBeenCalledTimes(1);
        expect(callTool).not.toHaveBeenCalled();
        const messages = await readSessionMessagesAsync(scope, {
          mode: "full",
          reason: "private display exclusion",
        });
        const model = await SessionManager.openModelContextAsync(scope);
        for (const projection of [
          messages,
          reopened.buildSessionContext().messages,
          model.buildSessionContext().messages,
        ]) {
          expect(JSON.stringify(projection)).not.toContain("private-synthetic-checkpoint");
          expect(JSON.stringify(projection)).not.toContain("Saved diagram");
          expect(JSON.stringify(projection)).toContain("created once");
        }
      });
    },
  );
});
