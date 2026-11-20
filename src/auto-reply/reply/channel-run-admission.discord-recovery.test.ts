import { assert, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { buildChannelInboundEventContext } from "../../channels/inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../../channels/inbound-event/host-context-builder.js";
import {
  copyChildSessionPublication,
  readChildSessionPublication,
} from "../../channels/message-access/child-session-publication.js";
import type { ResolvedChannelMessageIngress } from "../../channels/message-access/runtime-types.js";
import { createHostChannelIngressRuntime } from "../../channels/message-access/runtime.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import * as mailbox from "../../sessions/session-controller.mailbox.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { setupExecutionSuite } from "./agent-runner-execution-suite.test-support.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

const { state, terminalEvents } = await setupExecutionSuite();
// Load after the execution fixture registers its provider and lifecycle module mocks.
const { executeAgentTurn } = await import("./agent-runner-execution.js");
const discord = await loadBundledPluginFacade<{
  loadDiscordQueuedAdmissionFixture: () => Promise<{
    prepareDiscordQueuedAdmission: (params: {
      runtime: PluginRuntime;
      cfg: OpenClawConfig;
      sessionKey: string;
      messageId: string;
    }) => Promise<ResolvedChannelMessageIngress>;
  }>;
}>({ pluginId: "discord", artifactBasename: "test-api.js" });

it("rechecks queued Discord access before model requests without granting public children", async () => {
  const { prepareDiscordQueuedAdmission } = await discord.loadDiscordQueuedAdmissionFixture();
  await withOpenClawTestState({ label: "discord-queued-admission" }, async () => {
    for (const revoke of [false, true]) {
      const sessionKey = `agent:main:discord:channel:queued-${revoke}`;
      const messageId = revoke ? "500000000000000005" : "400000000000000004";
      const cfg: OpenClawConfig = {
        channels: {
          discord: {
            groupPolicy: "allowlist",
            guilds: {
              "100000000000000001": {
                channels: {
                  "200000000000000002": {
                    users: ["300000000000000003"],
                    requireMention: false,
                  },
                },
              },
            },
          },
        },
      };
      let currentConfig = cfg;
      setRuntimeConfigSnapshot(cfg);
      const gateway = { getRuntimeConfig: () => currentConfig } as GatewayRequestContext;
      const owner = {
        channelId: "discord",
        isLive: () => true,
        resolveGatewayContext: () => gateway,
      };
      const ingress = createHostChannelIngressRuntime(owner);
      const runtime = { channel: { inbound: { ingress } } } as unknown as PluginRuntime;
      const channelIngress = await prepareDiscordQueuedAdmission({
        runtime,
        cfg,
        sessionKey,
        messageId,
      });
      const context = await createHostChannelInboundEventContextBuilder(
        buildChannelInboundEventContext,
        owner,
      )({
        channel: "discord",
        accountId: "default",
        messageId,
        channelIngress,
        from: "discord:channel:200000000000000002",
        sender: { id: "300000000000000003" },
        conversation: { kind: "channel", id: "200000000000000002" },
        route: { agentId: "main", routeSessionKey: sessionKey },
        reply: { to: "channel:200000000000000002", nativeChannelId: "200000000000000002" },
        message: { body: "queued request", rawBody: "queued request" },
      });
      const followup = createFollowupRun({ config: cfg, sessionKey });
      copyChildSessionPublication(context, followup.run);
      const model = vi.fn();
      const deliver = vi.fn(async () => {});
      const deliverPrepared = vi.fn(async () => {});
      const dispatcher = createReplyDispatcher({ deliver, deliverPrepared });
      state.runEmbeddedAgentMock.mockImplementation(async (params) => {
        const admitted = await params.preparedRunAdmission.admit("embedded");
        expect(readChildSessionPublication(admitted.operationalRunInstance)).toBeUndefined();
        model();
        return { payloads: [{ text: "Authorized reply" }], meta: { durationMs: 0 } };
      });
      const predecessor = createReplyOperation({
        sessionKey,
        sessionId: followup.run.sessionId,
        resetTriggered: false,
      });
      const waiting = createDeferred();
      const submit = mailbox.submitSessionControllerTask;
      const submission = vi
        .spyOn(mailbox, "submitSessionControllerTask")
        .mockImplementation((...args) => {
          const pending = submit(...args);
          waiting.resolve();
          return pending;
        });
      const pending = withSessionTurn(
        { sessionKey, sessionId: followup.run.sessionId },
        async (replyOperation) =>
          executeAgentTurn({
            ...createMinimalRunAgentTurnParams({
              followupRun: followup,
              sessionCtx: context,
              replyOperation,
              opts: {
                onBlockReply: async (payload) => {
                  dispatcher.sendBlockReply(payload);
                },
                onPreparedBlockReply: async (plan) => {
                  dispatcher.sendPreparedReply("block", plan);
                },
                onToolResult: async (payload) => {
                  dispatcher.sendToolResult(payload);
                },
              },
            }),
            sessionKey,
          }),
      );
      try {
        await waiting.promise;
        expect(model).not.toHaveBeenCalled();
        if (revoke) {
          currentConfig = structuredClone(cfg);
          const channel =
            currentConfig.channels?.discord?.guilds?.["100000000000000001"]?.channels?.[
              "200000000000000002"
            ];
          assert(channel);
          channel.users = ["600000000000000006"];
          setRuntimeConfigSnapshot(currentConfig);
        }
        predecessor.complete();
        const result = await pending;
        if (result.outcome.kind === "rejected") {
          dispatcher.sendFinalReply(result.outcome.payload);
        } else if (result.outcome.kind === "settled") {
          for (const payload of result.outcome.result.payloads ?? []) {
            dispatcher.sendFinalReply(payload);
          }
        }
        await dispatcher.waitForIdle();
        expect(model).toHaveBeenCalledTimes(revoke ? 0 : 1);
        expect(deliver).toHaveBeenCalledTimes(revoke ? 0 : 1);
        expect(deliverPrepared).not.toHaveBeenCalled();
        if (revoke) {
          expect(result.outcome).toMatchObject({
            kind: "rejected",
            payload: { text: SILENT_REPLY_TOKEN },
          });
          expect(terminalEvents(result.runId)).toEqual([
            expect.objectContaining({
              data: expect.objectContaining({
                phase: "error",
                errorNotice:
                  "This request was not started because the requester no longer has access to this channel.",
              }),
            }),
          ]);
        } else {
          expect(result.outcome).toMatchObject({ kind: "settled", status: "ok" });
        }
      } finally {
        predecessor.complete();
        await Promise.allSettled([pending]);
        submission.mockRestore();
      }
    }
  });
});
