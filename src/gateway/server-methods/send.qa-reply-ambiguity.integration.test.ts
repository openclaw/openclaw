import { createServer, request, type ClientRequest, type IncomingMessage } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { resolveMessageActionAgentRuntimeIdentity } from "../../agents/tools/gateway.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { createReplyRestartRecoveryClaimController } from "../../auto-reply/reply/restart-recovery-claim.js";
import { createReplyRecoveryActorFixture } from "../../auto-reply/reply/restart-recovery-claim.test-support.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { QaBusStateSnapshot } from "../../plugin-sdk/qa-channel-protocol.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../message-action-turn-capability.js";
import { sendHandlers } from "./send.js";
import { createAgentRuntimeGatewayClientForTests } from "./send.test-helpers.js";
import { makeContext } from "./send.test-support.js";
import type { RespondFn } from "./types.js";

afterEach(() => resetPluginRuntimeStateForTest());

type QaBusState = { getSnapshot: () => QaBusStateSnapshot };

it("keeps an accepted QA reply pending after a lost HTTP response and refuses a distinct same-source call", async (test) => {
  await withOpenClawTestState({ prefix: "gateway-qa-reply-ambiguity-" }, async (state) => {
    const { qaChannelPlugin } = await loadBundledPluginFacade<{ qaChannelPlugin: ChannelPlugin }>({
      pluginId: "qa-channel",
      artifactBasename: "api.js",
    });
    const { createQaBusState, startQaBusServer } = await loadBundledPluginFacade<{
      createQaBusState: () => QaBusState;
      startQaBusServer: (params: { state: QaBusState }) => Promise<{
        baseUrl: string;
        stop: () => Promise<void>;
      }>;
    }>({ pluginId: "qa-lab", artifactBasename: "api.js" });
    const busState = createQaBusState();
    const bus = await startQaBusServer({ state: busState });
    const accepted = createDeferred();
    const releaseResponse = createDeferred();
    const upstreamRequests: ClientRequest[] = [];
    const exchanges: Promise<void>[] = [];
    const exchangeErrors: unknown[] = [];
    const calls: Promise<Parameters<RespondFn>>[] = [];
    let requestCount = 0;
    const text = "One accepted source reply";
    const proxy = createServer((incoming, downstream) => {
      requestCount++;
      const exchange = (async () => {
        expect(incoming.method).toBe("POST");
        expect(incoming.url).toBe("/v1/outbound/message");
        const target = new URL(incoming.url!, bus.baseUrl);
        const response = await new Promise<IncomingMessage>((resolve, reject) => {
          const upstream = request(
            target,
            { method: incoming.method, headers: { ...incoming.headers, host: target.host } },
            resolve,
          );
          upstreamRequests.push(upstream);
          upstream.once("error", reject);
          incoming.once("error", (error) => upstream.destroy(error));
          incoming.pipe(upstream);
        });
        const chunks: Buffer[] = [];
        for await (const chunk of response) {
          chunks.push(Buffer.from(chunk));
        }
        expect(response.statusCode).toBe(200);
        expect(response.complete).toBe(true);
        const messages = busState.getSnapshot().messages;
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ direction: "outbound", text });
        expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toMatchObject({
          message: { id: messages[0]!.id, text },
        });
        // The bus committed a business message, but the caller receives no HTTP response.
        accepted.resolve();
        await releaseResponse.promise;
        downstream.destroy();
      })().catch((error: unknown) => {
        exchangeErrors.push(error);
        accepted.reject(error);
        downstream.destroy();
      });
      exchanges.push(exchange);
    });
    let capability: string | undefined;
    let authority: ReturnType<typeof claimAgentRunDelegatedAuthority> | undefined;
    let actor: ReturnType<typeof createReplyRecoveryActorFixture> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        proxy.once("error", reject);
        proxy.listen(0, "127.0.0.1", () => {
          proxy.off("error", reject);
          resolve();
        });
      });
      const address = proxy.address();
      if (!address || typeof address === "string") {
        throw new Error("QA response proxy did not bind a TCP port");
      }
      const identity = {
        agentId: "main",
        runId: "qa-reply-run",
        sessionId: "qa-reply-session",
        sessionKey: "agent:main:qa-channel:direct:alice",
      };
      const sourceTurnId = "qa-source-turn";
      const scope = {
        ...identity,
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      };
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: state.workspaceDir } },
        session: { store: scope.storePath },
        channels: {
          "qa-channel": { enabled: true, baseUrl: `http://127.0.0.1:${address.port}` },
        },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg, cfg);
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "qa-channel", source: "test", plugin: qaChannelPlugin }]),
      );
      let entry: InternalSessionEntry = { sessionId: identity.sessionId, updatedAt: 1 };
      await replaceSessionEntry(scope, entry);
      const operation = createReplyOperation({ ...identity, resetTriggered: false });
      const admittedActor = createReplyRecoveryActorFixture({
        ...scope,
        operation,
        getSessionId: () => identity.sessionId,
      });
      actor = admittedActor;
      const recorder = createUserTurnTranscriptRecorder({
        message: {
          role: "user",
          content: "Send one reply to this conversation.",
          idempotencyKey: sourceTurnId,
          timestamp: 1,
        },
        target: { ...scope, sessionEntry: entry },
        updateMode: "none",
      });
      const claim = createReplyRestartRecoveryClaimController({
        ...scope,
        sourceTurnId,
        admissionRunId: identity.runId,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        getEntry: () => entry,
        getSessionId: () => identity.sessionId,
        setEntry: (next) => {
          entry = next;
        },
        acquireSessionActor: () => admittedActor.acquireSessionActor(),
        isRestartAbort: () => false,
        resolveDeliveryContext: () => ({ channel: "qa-channel", to: "dm:alice" }),
        sourceReplyDeliveryMode: "message_tool_only",
      });
      expect(await claim.admitUserTurn(recorder)).toBe("admitted");
      expect(recorder.hasPersisted()).toBe(true);
      expect(loadSessionEntry(scope)).toMatchObject({
        restartRecoveryDeliveryRunId: identity.runId,
        restartRecoveryDeliverySourceRunId: sourceTurnId,
      });
      const operationalRunInstance = createOperationalRunInstanceRef(identity.runId);
      authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      const admittedAuthority = authority;
      capability = mintMessageActionTurnCapability({
        ...identity,
        requesterAccountId: "default",
        toolContext: {
          currentChannelProvider: "qa-channel",
          currentChannelId: "alice",
          currentMessagingTarget: "dm:alice",
          currentChatType: "direct",
          currentSourceTurnId: sourceTurnId,
        },
      });
      const context = makeContext(() => cfg);
      context.validateAgentRuntimeApprovalAuthority =
        createAgentRuntimeApprovalAuthorityValidator();
      const handler = expectDefined(
        sendHandlers["message.action"],
        "Gateway message.action handler",
      );
      const invoke = (toolCallId: string, idempotencyKey: string) => {
        const running = withGatewayToolCallerIdentity(
          {
            agentId: identity.agentId,
            sessionKey: identity.sessionKey,
            operationalRunInstance,
            receiptAuthority: () => validateAgentRunDelegatedAuthority(admittedAuthority),
          },
          async () => {
            const runtimeIdentity = expectDefined(
              await resolveMessageActionAgentRuntimeIdentity({
                opts: {},
                target: "local",
                runId: identity.runId,
                sessionId: identity.sessionId,
                turnCapability: capability,
                sourceReplyFinal: true,
                sourceReplyToolCallId: toolCallId,
              }),
              "admitted message-action runtime identity",
            );
            expect(runtimeIdentity.messageActionContext).toMatchObject({
              sessionId: identity.sessionId,
              sourceReplyFinal: true,
              sourceReplyToolCallId: toolCallId,
              toolContext: { currentSourceTurnId: sourceTurnId },
            });
            const respond = vi.fn<RespondFn>();
            await handler({
              req: { type: "req", id: toolCallId, method: "message.action" },
              params: {
                channel: "qa-channel",
                action: "send",
                params: { to: "dm:alice", message: text },
                sessionKey: identity.sessionKey,
                sessionId: identity.sessionId,
                idempotencyKey,
              },
              context,
              client: createAgentRuntimeGatewayClientForTests(runtimeIdentity),
              isWebchatConnect: () => false,
              respond,
            });
            expect(respond).toHaveBeenCalledOnce();
            return expectDefined(respond.mock.calls[0], "Gateway message.action response");
          },
        );
        calls.push(running);
        return running;
      };
      const first = invoke("qa-call-first", "qa-request-first");
      await withinTest(
        awaitGateBeforeSettlement(
          accepted.promise,
          first,
          "Gateway action settled before QA acceptance",
        ),
        test.signal,
      );
      const pending = {
        restartRecoveryDeliveryRunId: identity.runId,
        restartRecoveryDeliverySourceRunId: sourceTurnId,
        restartRecoveryDeliveryReceiptState: "terminal-pending",
        restartRecoveryDeliveryToolCallId: "qa-call-first",
      };
      expect(loadSessionEntry(scope)).toMatchObject(pending);
      releaseResponse.resolve();
      const failed = await withinTest(first, test.signal);
      expect(exchangeErrors).toEqual([]);
      expect(failed[0]).toBe(false);
      expect(failed[2]).toMatchObject({ code: "UNAVAILABLE" });
      expect(loadSessionEntry(scope)).toMatchObject(pending);

      // New request and tool-call identities exclude the Gateway request-cache replay path.
      const second = await withinTest(invoke("qa-call-second", "qa-request-second"), test.signal);
      expect(second.slice(0, 3)).toMatchObject([
        true,
        { status: "delivery_ambiguous", delivered: false },
        undefined,
      ]);
      expect(loadSessionEntry(scope)).toMatchObject(pending);
      expect(requestCount).toBe(1);
      expect(upstreamRequests).toHaveLength(1);
      expect(busState.getSnapshot().messages).toHaveLength(1);
      expect(operation.sourceReplyDelivered).toBe(false);
      expect(exchangeErrors).toEqual([]);
    } finally {
      releaseResponse.resolve();
      for (const upstream of upstreamRequests) {
        upstream.destroy();
      }
      const proxyClosed = proxy.listening
        ? new Promise<void>((resolve, reject) => {
            proxy.close((error) => (error ? reject(error) : resolve()));
          })
        : Promise.resolve();
      proxy.closeAllConnections();
      try {
        const settled = await Promise.allSettled([...calls, proxyClosed]);
        await Promise.all(exchanges);
        // Report cleanup failure without replacing the determining assertion or request error.
        expect.soft(settled.at(-1)).toMatchObject({ status: "fulfilled" });
      } finally {
        try {
          await bus.stop();
        } finally {
          if (capability) {
            revokeMessageActionTurnCapability(capability);
          }
          if (authority) {
            releaseAgentRunDelegatedAuthority(authority);
          }
          await actor?.[Symbol.asyncDispose]();
        }
      }
    }
  });
});
