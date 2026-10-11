import { expect, it, vi } from "vitest";
import { getAcpSessionManager, testing } from "../../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../../acp/control-plane/manager.lifecycle.js";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../../acp/runtime/registry.js";
import { readAcpSessionMetaAsync } from "../../acp/runtime/session-meta-read.js";
import * as preparedRuntime from "../../agents/prepared-model-runtime.js";
import * as runtimePlugins from "../../agents/runtime-plugins.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  listSessionParticipantsReadOnly,
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import { tryDispatchAcpReplyHook } from "../../plugin-sdk/acp-runtime.js";
import { buildChannelInboundEventContext } from "../../plugin-sdk/channel-inbound.js";
import { inspectRuntimeConversationBindingRoute } from "../../plugin-sdk/conversation-binding-runtime.js";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  disposePluginRegistryInstances,
  initializeGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugin-sdk/plugin-test-runtime.js";
import { createReplyDispatcher, dispatchInboundMessage } from "../../plugin-sdk/reply-runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { waitForSessionParticipantRecording } from "../../sessions/session-participant-recording.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleAcpSpawnAction } from "./commands-acp/lifecycle.js";
import { buildCommandTestParams } from "./commands.test-harness.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";

it.each(["spawned", "legacy", "configured", "removed", "reassigned", "reopened"] as const)(
  "dispatches %s ACP sessions without confusing the configured owner and harness storage",
  async (kind) => {
    await withOpenClawTestState(
      { label: "acp-spawn-owner", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const backendId = "synthetic-owner";
        const cfg = withFullRuntimeReplyConfig({
          agents: {
            ownership: "explicit",
            entries: { main: { workspace: state.workspaceDir }, work: {} },
          },
          acp: {
            enabled: true,
            dispatch: { enabled: true },
            backend: backendId,
            allowedAgents: ["free-harness"],
          },
          plugins: { enabled: true, allow: ["acpx"], entries: { acpx: { enabled: true } } },
        });
        await state.writeConfig(cfg);
        const registry = createPluginRegistry({
          logger: { info() {}, warn() {}, error() {}, debug() {} },
          runtime: createPluginRuntimeMock(),
          activateGlobalSideEffects: false,
        });
        const plugin = createPluginRecord({
          id: "acpx",
          origin: "bundled",
          source: state.path("acpx", "index.ts"),
          status: "loaded",
        });
        const api = registry.createApi(plugin, { config: cfg });
        registry.registry.plugins.push(plugin);
        api.on("reply_dispatch", tryDispatchAcpReplyHook, { eligibleDispatchKinds: ["acp"] });
        setActivePluginRegistry(registry.registry);
        initializeGlobalHookRunner(registry.registry);
        // Exercise dispatch with the synthetic backend, not the installed ACPX plugin.
        const pluginRegistry = vi
          .spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle")
          .mockReturnValue(registry.registry);
        let afterRuntimePrepared: (() => void) | undefined;
        const publishedRuntime = vi
          .spyOn(preparedRuntime, "loadPublishedGatewayReplyDispatchRuntime")
          .mockImplementation(async ({ agentId }) => {
            if (agentId !== (kind === "configured" ? "work" : "main")) {
              throw new Error(`No published runtime for ${agentId}`);
            }
            afterRuntimePrepared?.();
            return undefined;
          });
        const turns: Array<{ agentId: string | undefined; sessionKey: string }> = [];
        registerAcpRuntimeBackend({
          id: backendId,
          runtime: {
            ownerAwareSessions: 1,
            async ensureSession(input) {
              return {
                ...input,
                backend: backendId,
                runtimeSessionName: input.agentId + "/" + input.sessionKey,
              };
            },
            async *runTurn({ handle }) {
              turns.push({ agentId: handle.agentId, sessionKey: handle.sessionKey });
              yield { type: "text_delta", text: "owner reply" };
              yield { type: "done" };
            },
            async close() {},
            async cancel() {},
          },
        });
        testing.resetAcpSessionManagerForTests();
        let manager = getAcpSessionManager();
        let binding: SessionBindingRecord | null = null;
        const adapter = {
          channel: "discord",
          accountId: "default",
          listBySession: () => (binding ? [binding] : []),
          resolveByConversation: () => binding,
        };
        registerSessionBindingAdapter(adapter);
        const delivered: string[] = [];
        const dispatcher = createReplyDispatcher({
          deliver: async (payload) => {
            if (payload.text) {
              delivered.push(payload.text);
            }
          },
        });
        try {
          let sessionKey: string;
          const storeAgentId =
            kind === "spawned" ? "main" : kind === "configured" ? "work" : "free-harness";
          if (kind === "spawned") {
            const params = buildCommandTestParams(
              "/acp spawn free-harness --thread off --label owner-proof",
              cfg,
              { AgentId: "main", SessionKey: "agent:main:main" },
              { workspaceDir: state.workspaceDir },
            );
            const result = await handleAcpSpawnAction(params, [
              "free-harness",
              "--thread",
              "off",
              "--label",
              "owner-proof",
            ]);
            expect(result?.reply?.text).toContain("Spawned ACP session agent:main:acp:");
            sessionKey = result?.reply?.text?.match(/Spawned ACP session (\S+)/)?.[1] ?? "";
            expect(loadSessionEntryReadOnly({ agentId: storeAgentId, sessionKey })?.label).toBe(
              "owner-proof",
            );
          } else {
            sessionKey = `agent:${storeAgentId}:acp:${kind}`;
            await manager.initializeSession({
              cfg,
              sessionKey,
              agentId: storeAgentId,
              agent: "free-harness",
              mode: "persistent",
            });
          }
          if (kind === "reopened") {
            await disposeAcpSessionManagerInstance(manager, "simulate-restart");
            testing.resetAcpSessionManagerForTests();
            manager = getAcpSessionManager();
          }
          binding = {
            bindingId: "owner-proof",
            targetSessionKey: sessionKey,
            targetKind: "session",
            status: "active",
            boundAt: 1,
            conversation: {
              channel: "discord",
              accountId: "default",
              conversationId: "owner-room",
            },
          };
          const { route } = inspectRuntimeConversationBindingRoute({
            route: {
              agentId: "main",
              channel: "discord",
              accountId: "default",
              sessionKey: "agent:main:source",
              mainSessionKey: "agent:main:main",
              lastRoutePolicy: "session",
              matchedBy: "default",
            },
            inspection: { status: "available", binding },
          });
          const ctx = buildChannelInboundEventContext({
            channel: "discord",
            accountId: "default",
            messageId: "owner-" + kind,
            from: "synthetic-user",
            sender: { id: "synthetic-user" },
            conversation: { kind: "direct", id: "owner-room" },
            route: { ...route, routeSessionKey: route.sessionKey },
            reply: { to: "owner-room" },
            message: { rawBody: "hello owner" },
          });
          const rejectBinding = kind === "removed" || kind === "reassigned";
          if (rejectBinding) {
            const preparedBinding = binding;
            afterRuntimePrepared = () => {
              binding =
                kind === "removed"
                  ? null
                  : { ...preparedBinding, targetSessionKey: "agent:main:acp:replacement" };
            };
          }
          const dispatch = withPluginRuntimeRegistryScope(registry.registry, () =>
            dispatchInboundMessage({ ctx, cfg, dispatcher }),
          );
          if (rejectBinding) {
            await expect(dispatch).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
            expect(turns).toEqual([]);
            return;
          }
          await dispatch;
          dispatcher.markComplete();
          await dispatcher.waitForIdle();
          expect(delivered.join("")).toContain("owner reply");
          expect(turns).toEqual([{ agentId: storeAgentId, sessionKey }]);
          await waitForSessionParticipantRecording({
            agentId: storeAgentId,
            sessionKey,
            storePath: resolveSessionStorePathCore(undefined, { agentId: storeAgentId }),
          });
          expect(
            listSessionParticipantsReadOnly({ agentId: storeAgentId, sessionKey }).get(sessionKey),
          ).toHaveLength(1);
          const entry = loadSessionEntryReadOnly({ agentId: storeAgentId, sessionKey });
          if (!entry) {
            throw new Error("ACP dispatch lost its canonical session");
          }
          expect(
            (await readAcpSessionMetaAsync({ cfg, agentId: storeAgentId, sessionKey }))?.agent,
          ).toBe("free-harness");
          expect(
            await loadTranscriptEvents({
              agentId: storeAgentId,
              sessionKey,
              sessionId: entry.sessionId,
            }),
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "message",
                message: expect.objectContaining({ role: "assistant" }),
              }),
            ]),
          );
          expect(
            loadSessionEntryReadOnly({
              agentId: kind === "spawned" ? "free-harness" : "main",
              sessionKey,
            }),
          ).toBeUndefined();
        } finally {
          dispatcher.markComplete();
          await dispatcher.waitForIdle();
          unregisterSessionBindingAdapter({ channel: "discord", accountId: "default", adapter });
          await disposeAcpSessionManagerInstance(manager, "test-complete");
          testing.resetAcpSessionManagerForTests();
          unregisterAcpRuntimeBackend(backendId);
          pluginRegistry.mockRestore();
          publishedRuntime.mockRestore();
          await disposePluginRegistryInstances(registry.registry);
          resetPluginRuntimeStateForTest();
          resetInboundDedupe();
        }
      },
    );
  },
);
