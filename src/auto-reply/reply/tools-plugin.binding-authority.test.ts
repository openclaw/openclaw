import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";
import { afterEach, assert, expect, it, vi } from "vitest";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "../../../test/helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../test/helpers/openai-responses-sse.js";
import {
  createHostIngressFixture,
  ingressInput,
  ingressMessage,
} from "../../channels/message-access/host-ingress.test-support.js";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { GatewayScheduler } from "../../infra/gateway-scheduler.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { createPluginStateKeyedStore } from "../../plugin-state/plugin-state-store.js";
import {
  bindLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "../../plugins/legacy-sdk-resource-host.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { setActivePluginRegistry, disposePluginRegistryInstances } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import type { OpenClawPluginToolContext } from "../../plugins/tool-types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { changeCanonicalUserChannelIdentity } from "../../state/user-channel-identity-operations.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { CommandOwnerRevokedError } from "../command-owner-authority.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { dispatchInboundMessage } from "../dispatch.js";
import { getRequesterProfile } from "../requester-profile.js";
import type { ReplyPayload } from "../types.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

// Only external channel payloads/model decisions are synthetic. Ingress,
// linked-profile/run admission, tool construction/execution, and V2 persistence
// are real. No requester fields or assertion are injected at the tool boundary.
afterEach(() => {
  resetInboundDedupe();
  vi.unstubAllEnvs();
});

it.each(["allowed", "reassigned"] as const)(
  "proves host-authenticated V2 tool persistence: %s",
  { timeout: 90_000 },
  async (scenario) =>
    withAdminIngress(
      async ({ cfg, state, admins }) => {
        const [participant, other] = admins;
        assert(participant && other);
        await setCanonicalUserProfileRole(participant.profile.id, "member");
        await setCanonicalUserProfileRole(other.profile.id, "member");
        vi.stubEnv("OPENCLAW_SKIP_PROVIDERS", "");
        const pluginId = "binding-tool-ingress-proof";
        const rootDir = state.path(pluginId);
        const sessionKey = "agent:main:slack:channel:proof-room";
        const storePath = path.join(state.sessionsDir("main"), "sessions.json");
        const conversation = { channel: "slack", accountId: "team", conversationId: "proof-room" };
        let modelCalls = 0;
        let toolOutput = "";
        const server = await startOpenAiResponsesModelServer({
          modelId: "binding-proof",
          bindError: "Synthetic binding model could not bind",
          onRequest: async (request, response) => {
            modelCalls++;
            const body = await text(request);
            if (body.includes('"function_call_output"')) {
              toolOutput = body;
              writeOpenAiResponsesText(response, {
                text: "Binding proof finished.",
                responseId: "response_binding_done",
                messageId: "message_binding_done",
              });
              return;
            }
            expect(JSON.parse(body)).toMatchObject({
              model: "binding-proof",
              tools: expect.arrayContaining([
                expect.objectContaining({ type: "function", name: "binding_move" }),
              ]),
            });
            const item = {
              type: "function_call",
              id: "fc_binding_move",
              call_id: "call_binding_move",
              name: "binding_move",
              arguments: "{}",
            };
            writeOpenAiResponsesSse(response, [
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { ...item, arguments: "" },
              },
              {
                type: "response.function_call_arguments.delta",
                item_id: item.id,
                output_index: 0,
                delta: item.arguments,
              },
              { type: "response.output_item.done", output_index: 0, item },
              {
                type: "response.completed",
                response: {
                  id: "response_binding_call",
                  status: "completed",
                  output: [item],
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
              },
            ]);
          },
        });
        await using resources = new AsyncDisposableStack();
        resources.defer(() => server.close());
        const modelConfig = createOpenAiResponsesModelConfig({
          baseUrl: server.baseUrl,
          providerId: "mock-openai",
          modelId: "binding-proof",
          reasoning: false,
          toolProfile: "coding",
        });
        Object.assign(cfg, {
          models: modelConfig.models,
          agents: {
            defaults: { ...modelConfig.agents?.defaults, workspace: state.workspaceDir },
            entries: { main: { workspace: state.workspaceDir } },
          },
          tools: { allow: ["binding_move"], codeMode: { enabled: false }, toolSearch: false },
          session: { ...cfg.session, store: storePath },
          plugins: {
            allow: [pluginId],
            slots: { memory: "none" },
            load: { paths: [path.join(rootDir, "index.cjs")] },
            entries: { [pluginId]: { enabled: true } },
          },
        });
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        const host = createHostIngressFixture("slack", cfg);
        resources.defer(() => host.retire());
        host.gateway.resolveGatewayContext = host.owner.resolveGatewayContext;
        const scheduler = new GatewayScheduler();
        resources.defer(() => scheduler.stop());
        const sdkHost = new LegacyPluginSdkResourceHost();
        sdkHost.bindScheduler(scheduler);
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
          {
            sessionId: "proof-session",
            lifecycleRevision: "proof-generation",
            updatedAt: Date.now(),
          },
        );
        const entered = createDeferredCore();
        const resume = createDeferredCore();
        let callbacks = 0;
        let writeAttempts = 0;
        let handlerFailure: unknown;
        const bridge = Symbol.for("openclaw.binding-tool-proof." + randomUUID());
        resources.defer(() => {
          Reflect.deleteProperty(globalThis, bridge);
        });
        Reflect.set(
          globalThis,
          bridge,
          async (ctx: OpenClawPluginToolContext<2>, runtimeState: PluginRuntime["state"]) => {
            try {
              callbacks++;
              expect(ctx.senderIsOwner).toBe(false);
              expect(ctx.requesterSenderId).toBe(participant.identity.senderId);
              expect(ctx.sessionKey).toBe(sessionKey);
              ctx.assertInvocationCurrent();
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
                writeAttempts++;
                await action.compareAndApply("moves", observed.comparison, {
                  operation: "update",
                  action: "set",
                  value: 1,
                });
                return {
                  content: [{ type: "text", text: "proof write committed" }],
                  details: { moved: true },
                };
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
            contracts: { tools: ["binding_move"] },
            configSchema: { type: "object", additionalProperties: false, properties: {} },
          }),
        );
        await fs.writeFile(
          path.join(rootDir, "index.cjs"),
          "module.exports = { id: " +
            JSON.stringify(pluginId) +
            ", register(api) {" +
            'api.registerChannel({ plugin: { id: "slack", meta: { id: "slack", label: "Synthetic Slack transport", selectionLabel: "Synthetic Slack transport", docsPath: "/channels/slack", blurb: "Fixed transport fixture" }, capabilities: { chatTypes: ["group"] }, config: { listAccountIds: () => ["team"], resolveAccount: () => ({}), resolveAllowFrom: () => ["*"] }, conversationBindings: { supportsCurrentConversationBinding: true }, bindings: { resolveCommandConversation: ({ originatingTo }) => ({ conversationId: originatingTo?.replace(/^channel:/, "") ?? "" }) } } });' +
            'api.registerTool({ contextVersion: 2, create(ctx) { return { name: "binding_move", label: "Binding move", description: "Synthetic participant effect", parameters: { type: "object", additionalProperties: false, properties: {} }, execute() { return globalThis[Symbol.for(' +
            JSON.stringify(Symbol.keyFor(bridge)) +
            ')](ctx, api.runtime.state); } }; } }, { name: "binding_move" }); } };',
        );
        const registry = loadOpenClawPlugins({
          config: cfg,
          workspaceDir: state.workspaceDir,
          cache: false,
          logger: { info() {}, warn() {}, error() {}, debug() {} },
        });
        resources.defer(async () => {
          await disposePluginRegistryInstances(registry);
        });
        setActivePluginRegistry(registry);
        expect(registry.diagnostics.filter((entry) => entry.pluginId === pluginId)).toEqual([]);
        await getSessionBindingService().bind({
          conversation,
          targetSessionKey: sessionKey,
          targetKind: "session",
          metadata: { pluginBindingOwner: "plugin", pluginId, pluginRoot: rootDir },
        });
        const message = ingressMessage("slack", sessionKey, participant.identity.senderId, {
          accountId: "team",
          messageId: randomUUID(),
          from: "slack:channel:proof-room",
          conversation: { kind: "group", id: "proof-room", nativeChannelId: "proof-room" },
          reply: { to: "channel:proof-room", nativeChannelId: "proof-room" },
          message: { rawBody: "Use binding_move to record one move." },
        });
        const admission = await host.ingress.resolveStable(
          ingressInput(message, {
            identity: { authentication: "verified" },
            groupPolicy: "open",
            groupAllowFrom: ["*"],
            contextBinding: {
              agentId: "main",
              sessionKey,
              nativeChannelId: "proof-room",
              messageId: message.messageId,
              inboundEventKind: "user_request",
            },
          }),
        );
        const ctx = host.buildContext({ ...message, channelIngress: admission });
        const requester = getRequesterProfile(ctx);
        expect(requester?.id).toBe(participant.profile.id);
        assert(requester?.operatorAuthority);
        expect(requester.operatorAuthority.scopes).toContain("operator.write");
        expect(requester.operatorAuthority.scopes).not.toContain("operator.admin");
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
          if (phase === "finished" && handlerFailure) {
            throw new Error("SDK tool failed before preparation", { cause: handlerFailure });
          }
          expect({ phase, callbacks, replies }).toMatchObject({ phase: "prepared", callbacks: 1 });
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
          expect(callbacks).toBe(1);
          expect(writeAttempts).toBe(1);
          expect(requester.isCurrent()).toBe(scenario === "allowed");
          expect(persisted).toBe(scenario === "allowed" ? 1 : 0);
          if (scenario === "allowed") {
            expect(handlerFailure).toBeUndefined();
            expect(modelCalls).toBe(2);
            expect(toolOutput).toContain("proof write committed");
          } else {
            expect(handlerFailure).toBeInstanceOf(CommandOwnerRevokedError);
            expect(handlerFailure).toMatchObject({
              message: "Channel operator authority changed; send a new request.",
            });
          }
          console.info(
            "AUTHORITY_CHAIN " +
              JSON.stringify({
                entry: "host-ingress/reply/embedded-agent/V2-tool",
                scenario,
                hostProfileBound: requester?.id === participant.profile.id,
                gatewayOwner:
                  requester?.operatorAuthority?.scopes.includes("operator.admin") ?? false,
                callbackEntries: callbacks,
                finalWriteAttempts: writeAttempts,
                refusal:
                  handlerFailure instanceof CommandOwnerRevokedError
                    ? "requester-authority-revoked"
                    : null,
                originalIdentityCurrent: requester?.isCurrent() ?? false,
                preparation: phase,
                persistedMoves: persisted,
                modelCalls,
                finalWrite: scenario === "allowed" ? "committed" : "rejected-before-persistence",
              }),
          );
        } finally {
          resume.resolve();
          await pending;
        }
      },
      "role",
      "slack",
    ),
);
