import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { agentCommandFromGatewayIngress } from "../agents/agent-command.js";
import { prepareAgentRunTerminalReply } from "../agents/agent-run-terminal-reply.js";
import { bindRequesterOwnerIdentity } from "../agents/cron-creator-authority-context.js";
import * as embedded from "../agents/embedded-agent.js";
import { createOpenClawTools } from "../agents/openclaw-tools.js";
import { listSessionFollowupCompletions } from "../agents/subagents/completion/session-followup-completion.js";
import type { FollowupCompletionOwner } from "../agents/subagents/completion/session-followup-completion.types.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { withFullRuntimeReplyConfig } from "../auto-reply/reply/get-reply-fast-path.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { buildChannelInboundEventContext } from "../channels/inbound-event/context.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/config.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { installAuthorityProofGateway } from "./server.agent-runtime-authority-proof.test-support.js";
import {
  agentCommandMock,
  prepareGatewayReplyRuntimeForTest,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import { getTestPluginRegistry } from "./test-helpers.plugin-registry.js";

// Lazy reply modules retain this inference seam across cases.
const inference = vi.spyOn(embedded, "runEmbeddedAgent");
beforeEach(() => {
  inference.mockReset();
});
afterAll(() => {
  inference.mockRestore();
});
const getContext = installAuthorityProofGateway();

it.for(["peer", "reset"] as const)(
  "keeps original result custody after another owner message: %s",
  async (flow, { signal }) => {
    const topic = flow === "reset" ? "24" : "23";
    const parent = `agent:main:telegram:group:-1001234567890:topic:${topic}`;
    const peer = `agent:peer:channel-followup-${flow}`;
    const parentId = `channel-followup-parent-${flow}`;
    const firstMessage = "Ask the peer to finish this work.";
    const nextMessage = "I am still here; continue the other work too.";
    const finalMessage = "The original peer work is complete.";
    testState.agentsConfig = { entries: { main: {}, peer: {} } };
    testState.sessionStorePath = path.join(
      expectDefined(process.env.OPENCLAW_STATE_DIR, "isolated test state"),
      `channel-followup-${flow}-sessions.json`,
    );
    await writeSessionStore({
      entries: {
        [parent]: { sessionId: parentId, updatedAt: Date.now() },
        [peer]: {
          sessionId: "channel-followup-peer",
          updatedAt: Date.now(),
        },
      },
    });
    await prepareGatewayReplyRuntimeForTest();
    const config = {
      ...getRuntimeConfig(),
      commands: { ownerAllowFrom: ["telegram:123456"] },
      tools: { sessions: { visibility: "all" as const }, agentToAgent: { enabled: true } },
    };
    setRuntimeConfigSnapshot(config);
    agentCommandMock.mockImplementation((...args) =>
      agentCommandFromGatewayIngress(
        ...(args as Parameters<typeof agentCommandFromGatewayIngress>),
      ),
    );
    const finishPeer = createDeferred();
    const peerStarted = createDeferred();
    const completionClosed = createDeferred();
    const deliveries: Array<{ text: string; to: string; threadId?: string | number | null }> = [];
    const plugin = expectDefined(
      getTestPluginRegistry().channels.find((entry) => entry.pluginId === "telegram"),
      "Telegram transport fixture",
    ).plugin;
    const sendText = vi
      .spyOn(expectDefined(plugin.outbound, "outbound transport"), "sendText")
      .mockImplementation(async ({ text, to, threadId }) => {
        deliveries.push({ text, to, threadId });
        return { channel: "telegram", messageId: `receipt-${deliveries.length}` };
      });
    let completion: FollowupCompletionOwner | undefined;
    let returns = 0;
    let nextTurns = 0;
    inference.mockImplementation(async (params) => {
      const admission = expectDefined(params.preparedRunAdmission, "real run admission");
      const admitted = await admission.admit("embedded");
      const caller = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: admitted,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        turnSourceChannel: params.messageChannel,
        turnSourceTo: params.messageTo,
        turnSourceAccountId: params.requesterOrigin?.accountId ?? undefined,
        turnSourceThreadId: params.messageThreadId,
      });
      return withGatewayToolCallerIdentity(caller, async () => {
        let text: string;
        if (params.sessionKey === peer) {
          peerStarted.resolve();
          await finishPeer.promise;
          text = "PEER_RESULT";
        } else if (params.prompt.includes(firstMessage)) {
          const tool = expectDefined(
            createOpenClawTools({
              runId: params.runId,
              agentSessionKey: parent,
              sessionId: params.sessionId,
              config,
              requesterReplyExpectation: "required",
              agentChannel: "telegram",
              agentAccountId: "default",
              agentTo: "-1001234567890",
              agentThreadId: topic,
            }).find((entry) => entry.name === "sessions_send"),
            "real sessions_send",
          );
          const result = await tool.execute("delegate-peer", {
            sessionKey: peer,
            message: "Finish the delegated work",
            timeoutSeconds: 0,
          });
          expect(result.details).toMatchObject({ status: "accepted" });
          // This proof starts with an executing peer, beyond its separate preflight lifetime.
          await withinTest(peerStarted.promise, signal);
          text = "The peer is working.";
        } else if (params.prompt.includes(nextMessage)) {
          nextTurns++;
          text = "Your new message was received.";
        } else {
          expect(params.sessionKey).toBe(parent);
          expect(params.prompt).toContain("PEER_RESULT");
          // The old completion keeps its source restrictions, without the new owner's automation scope.
          expect(params.cronCreatorAuthorityCapability?.managementEntitlement).toBeUndefined();
          expect(
            bindRequesterOwnerIdentity({
              runId: params.runId,
              sessionKey: parent,
              sessionId: params.sessionId,
              agentId: "main",
            }),
          ).toBeUndefined();
          completion?.request.custody.assertCurrent();
          const duplicate = vi.fn(async () => {});
          await expect(
            completion?.request.requesterAuthority?.run("duplicate-return", duplicate),
          ).rejects.toThrow("Requester followup authority is no longer current");
          expect(duplicate).not.toHaveBeenCalled();
          returns++;
          text = finalMessage;
        }
        const { terminalReply } = prepareAgentRunTerminalReply({ rawText: text });
        return { payloads: [{ text }], meta: { durationMs: 1, terminalReply } };
      });
    });
    const incoming = (body: string, messageId: string) =>
      withPluginRuntimeGatewayContextResolver(
        () => getContext(),
        () =>
          getReplyFromConfig(
            buildChannelInboundEventContext({
              channel: "telegram",
              accountId: "default",
              messageId: `${flow}-${messageId}`,
              from: "telegram:-1001234567890",
              sender: { id: "123456" },
              conversation: { kind: "group", id: "-1001234567890", threadId: topic },
              route: {
                agentId: "main",
                accountId: "default",
                routeSessionKey: parent,
                mainSessionKey: "agent:main:main",
              },
              reply: { to: "-1001234567890", messageThreadId: topic },
              message: { rawBody: body },
              access: { commands: { authorized: true } },
            }),
            undefined,
            withFullRuntimeReplyConfig(config),
          ),
      );
    const unblock = () => finishPeer.resolve();
    signal.addEventListener("abort", unblock, { once: true });
    try {
      await withinTest(incoming(firstMessage, "first"), signal);
      const pending = listSessionFollowupCompletions({ requesterSessionKey: parent });
      expect(pending).toHaveLength(1);
      completion = expectDefined(pending[0], "accepted original completion");
      expect(completion.request.requesterAuthority).toBeDefined();
      completion.signal.addEventListener("abort", () => completionClosed.resolve(), { once: true });
      completion?.assertCurrent();
      await withinTest(incoming(nextMessage, "next"), signal);
      expect(nextTurns).toBe(1);
      completion?.assertCurrent();
      if (flow === "reset") {
        await dispatchGatewayMethodInProcess(
          "sessions.reset",
          { key: parent },
          {
            forceSyntheticClient: true,
            syntheticScopes: ["operator.admin"],
            resolveGatewayContext: () => getContext(),
          },
        );
      }
      finishPeer.resolve();
      await withinTest(completionClosed.promise, signal);
      await waitForGatewayActiveWork(10_000);
      if (flow === "reset") {
        expect(returns).toBe(0);
        expect(deliveries).toEqual([]);
      } else {
        expect(completion?.progress.phase, String(completion?.signal.reason)).toBe("processing");
        expect(returns).toBe(1);
        expect(deliveries).toEqual([{ text: finalMessage, to: "-1001234567890", threadId: topic }]);
      }
    } finally {
      unblock();
      completion?.close();
      await waitForGatewayActiveWork(10_000);
      signal.removeEventListener("abort", unblock);
      sendText.mockRestore();
    }
  },
);
