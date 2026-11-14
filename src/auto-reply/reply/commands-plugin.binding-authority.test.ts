import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import type * as EmbeddedAgent from "../../agents/embedded-agent.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import {
  createHostIngressFixture,
  ingressInput,
  ingressMessage,
} from "../../channels/message-access/host-ingress.test-support.js";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { createPluginStateKeyedStore } from "../../plugin-state/plugin-state-store.js";
import {
  bindLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "../../plugins/legacy-sdk-resource-host.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import type { PluginCommandContext } from "../../plugins/plugin-command.types.js";
import { setActivePluginRegistry, disposePluginRegistryInstances } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { changeCanonicalUserChannelIdentity } from "../../state/user-channel-identity-operations.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { resolveCommandAuthorizationAsync } from "../command-auth.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { dispatchInboundMessage } from "../dispatch.js";
import { getRequesterProfile } from "../requester-profile.js";
import type { ReplyPayload } from "../types.js";
import { createReplyAgentDefaults } from "./get-reply-config.test-support.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

// Fixed external transport/model boundary only: ingress, requester policy,
// command dispatch, conversation binding, and state persistence remain real.
vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof EmbeddedAgent>()),
  runEmbeddedAgent: vi.fn(),
}));
afterEach(() => {
  resetInboundDedupe();
  vi.mocked(runEmbeddedAgent).mockReset();
});

it.each(["allowed", "forbidden", "revoked", "reassigned"] as const)(
  "proves the host participant authority chain through text-command persistence: %s",
  async (scenario) =>
    withAdminIngress(
      async ({ cfg, state, admins }) => {
        const [participant, other] = admins;
        assert(participant && other);
        await setCanonicalUserProfileRole(participant.profile.id, "member");
        await setCanonicalUserProfileRole(other.profile.id, "member");
        const pluginId = "binding-ingress-proof";
        const rootDir = state.path("binding-ingress-proof");
        const sessionKey = "agent:main:slack:channel:proof-room";
        const storePath = path.join(state.sessionsDir("main"), "sessions.json");
        const conversation = { channel: "slack", accountId: "team", conversationId: "proof-room" };
        Object.assign(cfg, {
          agents: { defaults: createReplyAgentDefaults(state.workspaceDir) },
          commands: {
            ...cfg.commands,
            text: true,
            allowFrom: { slack: [participant.identity.senderId] },
          },
          session: { ...cfg.session, store: storePath },
          plugins: {
            allow: [pluginId],
            load: { paths: [path.join(rootDir, "index.cjs")] },
            entries: { [pluginId]: { enabled: true } },
          },
        });
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        const host = createHostIngressFixture("slack", cfg);
        host.gateway.resolveGatewayContext = host.owner.resolveGatewayContext;
        await using resources = new AsyncDisposableStack();
        const sdkHost = new LegacyPluginSdkResourceHost();
        resources.defer(() => sdkHost.close());
        bindLegacyPluginSdkResourceHost(host.owner.resolveGatewayContext!, sdkHost);
        const effects = createPluginStateKeyedStore<number>(pluginId, {
          namespace: "proof",
          maxEntries: 10,
          env: state.env,
        });
        await effects.register("moves", 0);
        await replaceSessionEntry(
          { agentId: "main", sessionKey, storePath },
          { sessionId: "proof-session", lifecycleRevision: "proof-generation", updatedAt: 1 },
        );
        const entered = createDeferredCore();
        const resume = createDeferredCore();
        let callbacks = 0;
        let handlerFailure: unknown;
        const bridge = Symbol.for("openclaw.binding-authority-proof." + randomUUID());
        Reflect.set(
          globalThis,
          bridge,
          async (ctx: PluginCommandContext, runtimeState: PluginRuntime["state"]) => {
            try {
              callbacks++;
              expect(ctx.isAuthorizedSender).toBe(true);
              expect(ctx.assertOwnerCurrent).toBeUndefined();
              assert(ctx.withCurrentConversationBinding);
              return await ctx.withCurrentConversationBinding(async (authority) => {
                expect(authority.requester.senderId).toBe(participant.identity.senderId);
                const action = runtimeState.openKeyedStoreV2<number>(
                  { namespace: "proof", maxEntries: 10 },
                  authority,
                );
                const observed = await action.observe("moves");
                entered.resolve();
                await resume.promise;
                await action.compareAndApply("moves", observed.comparison, {
                  operation: "update",
                  action: "set",
                  value: 1,
                });
                return { text: "proof write committed" };
              });
            } catch (error) {
              handlerFailure = error;
              throw error;
            }
          },
        );
        await fs.mkdir(rootDir);
        await fs.writeFile(
          path.join(rootDir, "openclaw.plugin.json"),
          JSON.stringify({
            id: pluginId,
            configSchema: { type: "object", additionalProperties: false, properties: {} },
          }),
        );
        await fs.writeFile(
          path.join(rootDir, "index.cjs"),
          `module.exports = { id: ${JSON.stringify(pluginId)}, register(api) {
      api.registerChannel({ plugin: {
        id: "slack", meta: { id: "slack", label: "Synthetic Slack transport", selectionLabel: "Synthetic Slack transport", docsPath: "/channels/slack", blurb: "Fixed transport fixture" },
        capabilities: { chatTypes: ["group"] },
        config: { listAccountIds: () => ["team"], resolveAccount: () => ({}), resolveAllowFrom: () => ["*"] },
        conversationBindings: { supportsCurrentConversationBinding: true },
        bindings: { resolveCommandConversation: ({ originatingTo }) => ({ conversationId: originatingTo?.replace(/^channel:/, "") ?? "" }) }
      } });
      api.registerCommand({ name: "binding-proof", description: "Synthetic participant effect", requireAuth: true,
        handler(ctx) { return globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(bridge))})](ctx, api.runtime.state); }
      });
    } };`,
        );
        const registry = loadOpenClawPlugins({
          config: cfg,
          workspaceDir: state.workspaceDir,
          cache: false,
          logger: { info() {}, warn() {}, error() {}, debug() {} },
        });
        setActivePluginRegistry(registry);
        expect(registry.diagnostics.filter((entry) => entry.pluginId === pluginId)).toEqual([]);
        await getSessionBindingService().bind({
          conversation,
          targetSessionKey: sessionKey,
          targetKind: "session",
          metadata: { pluginBindingOwner: "plugin", pluginId, pluginRoot: rootDir },
        });
        const sender = scenario === "forbidden" ? other : participant;
        const message = ingressMessage("slack", sessionKey, sender.identity.senderId, {
          accountId: "team",
          messageId: randomUUID(),
          from: "slack:channel:proof-room",
          conversation: { kind: "group", id: "proof-room", nativeChannelId: "proof-room" },
          reply: { to: "channel:proof-room", nativeChannelId: "proof-room" },
          message: { rawBody: "/binding-proof" },
        });
        const admission = await host.ingress.resolveStable(
          ingressInput(message, {
            identity: { authentication: "verified" },
            groupPolicy: "open",
            contextBinding: {
              agentId: "main",
              sessionKey,
              nativeChannelId: "proof-room",
              messageId: message.messageId,
              inboundEventKind: "user_request",
            },
            groupAllowFrom: ["*"],
            command: { cfg, requested: true, allowTextCommands: true, hasControlCommand: true },
          }),
        );
        const ctx = host.buildContext({
          ...message,
          channelIngress: admission,
          access: { commands: { authorized: admission.commandAccess.authorized } },
        });
        const requester = getRequesterProfile(ctx);
        expect(requester?.id).toBe(sender.profile.id);
        expect(requester?.operatorAuthority?.scopes).not.toContain("operator.admin");
        const policy = await resolveCommandAuthorizationAsync({
          ctx,
          cfg,
          commandAuthorized: ctx.CommandAuthorized,
        });
        expect(policy.isAuthorizedSender).toBe(scenario !== "forbidden");
        const replies: ReplyPayload[] = [];
        const dispatcher = createReplyDispatcher({
          deliver: async (reply) => {
            replies.push(reply);
          },
        });
        const pending = withPluginRuntimeGatewayContextResolver(
          host.owner.resolveGatewayContext!,
          () =>
            withReplyDispatcher({
              dispatcher,
              run: () => dispatchInboundMessage({ ctx, cfg, dispatcher }),
            }),
          { inheritRequestScope: false },
        );
        try {
          const phase = await Promise.race([
            entered.promise.then(() => "prepared"),
            pending.then(() => "finished"),
          ]);
          if (scenario !== "forbidden" && phase === "finished") {
            if (handlerFailure) {
              throw new Error("SDK command failed before preparation", { cause: handlerFailure });
            }
            expect({ callbacks, replies }).toEqual({ callbacks: 1, replies: [] });
          }
          expect(phase).toBe(scenario === "forbidden" ? "finished" : "prepared");
          if (scenario === "revoked") {
            cfg.commands!.allowFrom = { slack: [other.identity.senderId] };
            setRuntimeConfigSnapshot(cfg);
          }
          if (scenario === "reassigned") {
            await changeCanonicalUserChannelIdentity(
              "unlink",
              participant.profile.id,
              participant.identity,
            );
            await changeCanonicalUserChannelIdentity(
              "link",
              other.profile.id,
              participant.identity,
            );
          }
          resume.resolve();
          await pending;
          const persisted = await effects.lookup("moves");
          expect(callbacks).toBe(scenario === "forbidden" ? 0 : 1);
          expect(persisted).toBe(scenario === "allowed" ? 1 : 0);
          expect(runEmbeddedAgent).not.toHaveBeenCalled();
          console.info(
            "AUTHORITY_CHAIN " +
              JSON.stringify({
                entry: "host-ingress/text-command",
                scenario,
                hostProfileBound: requester?.id === sender.profile.id,
                gatewayOwner:
                  requester?.operatorAuthority?.scopes.includes("operator.admin") ?? false,
                channelCommandAuthorized: ctx.CommandAuthorized,
                commandAuthorized: policy.isAuthorizedSender,
                callbackEntries: callbacks,
                originalIdentityCurrent: requester?.isCurrent() ?? false,
                preparation: phase,
                persistedMoves: persisted,
                modelCalls: vi.mocked(runEmbeddedAgent).mock.calls.length,
              }),
          );
        } finally {
          resume.resolve();
          await pending;
          host.retire();
          Reflect.deleteProperty(globalThis, bridge);
          await disposePluginRegistryInstances(registry);
        }
      },
      "role",
      "slack",
    ),
);
