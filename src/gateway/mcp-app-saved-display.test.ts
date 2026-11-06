import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { staticRuntime } from "../agents/agent-bundle-mcp-fixture.test-support.js";
import {
  buildMcpAppCanvasPayload,
  fetchMcpAppView,
  getMcpAppViewLease,
} from "../agents/mcp-ui-resource.js";
import { testing } from "../agents/mcp-ui-resource.test-support.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  createSessionEntryWithTranscript,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { acquireSessionActorStorage } from "../config/sessions/session-actor-storage-acquisition.js";
import {
  runWithSessionActorStorage,
  type SelectedSessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import { useUserProfileCatalogForTest } from "../test-utils/user-profile-catalog.js";
import { mcpAppHandlers } from "./server-methods/mcp-app.js";
import type { GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { useTranscriptFixture } from "./session-transcript-fixtures.test-support.js";
import {
  readSessionMessagesAsync,
  readSessionTranscriptSummaryAsync,
} from "./session-transcript-readers.js";

describe("saved MCP App display", () => {
  const fixture = useTranscriptFixture("mcp-app-saved-display-");
  const prepareProfiles = useUserProfileCatalogForTest();
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
      if (storage === "durable") {
        await prepareProfiles();
      }
      const alice = storage === "durable" ? roleClient("view", "saved-display-alice") : undefined;
      const bob = storage === "durable" ? roleClient("view", "saved-display-bob") : undefined;
      const requesterId = alice?.authenticatedUserProfile!.profileId ?? "alice";
      const cfg: OpenClawConfig = {
        ...rolePolicyConfig(),
        session: { store: scope.storePath },
        agents: { entries: { main: {} } },
        mcp: { apps: { enabled: true } },
      };
      setRuntimeConfigSnapshot(cfg);
      const authority = { assertCurrent() {}, authorize() {} };
      const consume = async (run: () => Promise<void>) => {
        if (storage === "durable") {
          expect(
            await createSessionEntryWithTranscript(
              scope,
              () => ({
                ok: true,
                entry: {
                  sessionId: scope.sessionId,
                  updatedAt: 1,
                  visibility: "shared",
                  createdActor: { type: "human", source: "profile", id: requesterId },
                },
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
          mcpAppsEnabled: true,
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
          requesterId,
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
          requesterId,
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
          requesterId,
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
        if (alice && bob) {
          // Exercise the final Gateway payload boundary with real session/profile
          // authority. The MCP transport alone is synthetic, as above.
          const invoke = async (
            client = alice,
            sandbox: () => Promise<number> = async () => 18790,
          ) => {
            const respond = vi.fn<RespondFn>();
            await mcpAppHandlers["mcp.app.view"]!({
              params: { sessionKey: scope.sessionKey, viewId: restored.viewId },
              req: { type: "req", id: "saved-display", method: "mcp.app.view" },
              isWebchatConnect: () => true,
              client,
              respond,
              context: {
                getRuntimeConfig: () => cfg,
                ensureSandboxHostPort: sandbox,
              } as GatewayRequestContext,
            });
            return respond;
          };
          const allowed = await invoke();
          expect(allowed.mock.calls[0]).toMatchObject([
            true,
            { html, toolResult, messageSupported: false },
          ]);
          const denied = await invoke(bob);
          expect(denied.mock.calls[0]?.[0]).toBe(false);
          expect(denied.mock.calls[0]?.[1]).toBeUndefined();
          for (const change of ["requester revoked", "session reassigned"]) {
            const entered = createDeferred();
            const release = createDeferred<number>();
            const pending = invoke(alice, () => {
              entered.resolve();
              return release.promise;
            });
            try {
              await Promise.race([
                entered.promise,
                pending.then(() => {
                  throw new Error("View settled before final-disclosure gate");
                }),
              ]);
              if (change === "requester revoked") {
                alice.invalidated = true;
              } else {
                await upsertSessionEntryCore(scope, { sessionId: "replacement-session" });
              }
            } finally {
              release.resolve(18790);
            }
            const rejected = await pending;
            expect(rejected.mock.calls[0]?.[0], change).toBe(false);
            expect(rejected.mock.calls[0]?.[1], change).toBeUndefined();
            alice.invalidated = false;
          }
        }
      });
    },
  );
});
