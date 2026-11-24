import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import {
  copyChildSessionPublication,
  readChildSessionPublication,
} from "../../channels/message-access/child-session-publication.js";
import { createHostIngressFixture } from "../../channels/message-access/host-ingress.test-support.js";
import type { ResolvedChannelMessageIngress } from "../../channels/message-access/runtime-types.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { persistGatewaySessionLifecycleEvent } from "../../gateway/session-lifecycle-state.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { ReplyPayload } from "../types.js";
import { setupExecutionSuite } from "./agent-runner-execution-suite.test-support.js";
import { createFollowupRun } from "./agent-runner-execution.test-support.js";
import { enqueueFollowupRun } from "./queue.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import { createTypingController } from "./typing.js";

const { state, terminalEvents } = await setupExecutionSuite();
// Load these modules after fixture mocks are installed; static imports execute too early.
const { createFollowupRunner } = await import("./followup-runner.js");
const { defaultRuntime } = await import("../../runtime.js");
const maintenance = await import("./agent-runner-memory.js");
const discord = await loadBundledPluginFacade<{
  loadDiscordQueuedAdmissionFixture: () => Promise<{
    prepareDiscordQueuedAdmission: (params: {
      runtime: PluginRuntime;
      cfg: OpenClawConfig;
      sessionKey: string;
      messageId: string;
      thread?: boolean;
      policyUnavailable?: boolean;
    }) => Promise<{
      ingress: ResolvedChannelMessageIngress;
      inboundEventKind: InboundEventKind;
      counts: () => { policyReads: number; restCalls: number };
    }>;
  }>;
}>({ pluginId: "discord", artifactBasename: "test-api.js" });

it("records revoked Discord followups once without model or channel effects", async () => {
  const compact = vi.spyOn(maintenance, "runSessionCompactionIfNeeded");
  const flush = vi.spyOn(maintenance, "runMemoryFlushIfNeeded");
  onTestFinished(() => {
    compact.mockRestore();
    flush.mockRestore();
  });
  const { prepareDiscordQueuedAdmission } = await discord.loadDiscordQueuedAdmissionFixture();
  await withOpenClawTestState({ label: "discord-queued-admission" }, async (testState) => {
    for (const scenario of [
      "immediate",
      "queued-allowed",
      "queued-revoked",
      "room-allowed",
      "room-revoked",
      "queued-unavailable",
    ]) {
      const queued = scenario !== "immediate";
      const revoke = scenario.endsWith("revoked");
      const roomEvent = scenario.startsWith("room-");
      const unavailable = scenario.endsWith("unavailable");
      const failed = revoke || unavailable;
      const sessionKey = `agent:main:discord:channel:${scenario}`;
      const sessionId = `discord-${scenario}`;
      const messageId = failed ? "500000000000000005" : "400000000000000004";
      const storePath = testState.statePath("agents", "main", "sessions", "sessions.json");
      const scope = { agentId: "main", sessionKey, storePath };
      const cfg: OpenClawConfig = {
        session: { store: storePath },
        messages: {
          groupChat: { unmentionedInbound: roomEvent ? "room_event" : "user_request" },
        },
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
      await upsertSessionEntryCore(scope, { sessionId, updatedAt: Date.now() });
      const entry = loadSessionEntry({ ...scope, readConsistency: "latest" });
      assert(entry);
      const host = createHostIngressFixture("discord", cfg, {
        getRuntimeConfig: () => currentConfig,
      });
      const runtime = { channel: { inbound: host } } as unknown as PluginRuntime;
      const {
        ingress: channelIngress,
        inboundEventKind,
        counts,
      } = await prepareDiscordQueuedAdmission({
        runtime,
        cfg,
        sessionKey,
        messageId,
        thread: !queued,
        policyUnavailable: unavailable,
      });
      expect(inboundEventKind).toBe(roomEvent ? "room_event" : "user_request");
      const context = host.buildContext({
        channel: "discord",
        accountId: "default",
        messageId,
        channelIngress,
        from: "discord:channel:200000000000000002",
        sender: { id: "300000000000000003" },
        conversation: { kind: "channel", id: "200000000000000002" },
        route: { agentId: "main", routeSessionKey: sessionKey },
        reply: { to: "channel:200000000000000002", nativeChannelId: "200000000000000002" },
        message: { body: "queued request", rawBody: "queued request", inboundEventKind },
      });
      const followup = createFollowupRun({
        config: cfg,
        sessionKey,
        sessionId,
        messageProvider: "discord",
        chatType: "channel",
        senderId: "300000000000000003",
        agentAccountId: "default",
      });
      followup.prompt = "queued request";
      followup.messageId = messageId;
      followup.originatingChannel = "discord";
      followup.originatingChatType = "channel";
      followup.currentInboundEventKind = inboundEventKind;
      followup.userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
        input: { text: "queued request", idempotencyKey: messageId },
        target: { ...scope, sessionId, sessionEntry: entry },
        updateMode: "none",
      });
      copyChildSessionPublication(context, followup.run);
      const beforeAdmission = counts();
      const providerRequests = vi.fn();
      const deliver = vi.fn(async (_payload: ReplyPayload) => {});
      const deliverPrepared = vi.fn(async () => {});
      const dispatcher = createReplyDispatcher({ deliver, deliverPrepared });
      state.runEmbeddedAgentMock.mockImplementation(async (params) => {
        const admitted = await params.preparedRunAdmission.admit("embedded");
        expect(readChildSessionPublication(admitted.operationalRunInstance)).toBeUndefined();
        providerRequests();
        return { payloads: [{ text: "Authorized reply" }], meta: { durationMs: 0 } };
      });
      vi.mocked(defaultRuntime.log).mockClear();
      compact.mockClear();
      flush.mockClear();
      const writes: Promise<void>[] = [];
      const writeErrors: unknown[] = [];
      const stop = onAgentEvent((event) => {
        if (
          event.sessionKey === sessionKey &&
          event.stream === "lifecycle" &&
          (event.data.phase === "end" || event.data.phase === "error")
        ) {
          writes.push(
            persistGatewaySessionLifecycleEvent({ ...scope, event }).catch((error: unknown) => {
              writeErrors.push(error);
            }),
          );
        }
      });
      onTestFinished(stop);
      const admitted = queued
        ? await admitReplyTurn({ ...scope, sessionId, kind: "visible", resetTriggered: false })
        : undefined;
      if (admitted) {
        assert(admitted.status === "owned");
      }
      const predecessor = admitted?.status === "owned" ? admitted.operation : undefined;
      const typing = createTypingController({});
      const runner = createFollowupRunner({
        typing,
        typingMode: "never",
        defaultModel: "anthropic/claude",
        sessionKey,
        storePath,
        sessionEntry: entry,
        sessionStore: { [sessionKey]: entry },
        opts: {
          onBlockReply: async (payload) => {
            dispatcher.sendBlockReply(payload);
            await dispatcher.waitForIdle();
          },
          onPreparedBlockReply: async (plan) => {
            dispatcher.sendPreparedReply("block", plan);
            await dispatcher.waitForIdle();
          },
          onToolResult: async (payload) => {
            dispatcher.sendToolResult(payload);
            await dispatcher.waitForIdle();
          },
        },
      });
      const completed = createDeferred();
      try {
        expect(
          enqueueFollowupRun(
            sessionKey,
            followup,
            { mode: "followup", debounceMs: 0 },
            "none",
            async (run) => {
              try {
                await runner(run);
                completed.resolve();
              } catch (error) {
                completed.reject(error);
              }
            },
            true,
            { storePath },
          ),
        ).toBe(true);
        if (queued) {
          expect(providerRequests).not.toHaveBeenCalled();
        }
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
        predecessor?.complete();
        await completed.promise;
        await followup.controllerInput?.settlement.promise;
        await dispatcher.waitForIdle();
        await Promise.all(writes);
        expect(writeErrors).toEqual([]);
        expect(providerRequests).toHaveBeenCalledTimes(failed ? 0 : 1);
        // The runtime fake covers replies and memory flush; refused input skips maintenance.
        expect(compact).toHaveBeenCalledTimes(failed ? 0 : 1);
        if (failed) {
          expect(flush).not.toHaveBeenCalled();
          expect(state.runCliAgentMock).not.toHaveBeenCalled();
        }
        expect(deliver).toHaveBeenCalledTimes(revoke || roomEvent ? 0 : 1);
        expect(deliverPrepared).not.toHaveBeenCalled();
        if (!queued) {
          expect(beforeAdmission.restCalls).toBeGreaterThan(0);
          expect(counts()).toEqual({
            policyReads: beforeAdmission.policyReads + 1,
            restCalls: beforeAdmission.restCalls,
          });
        }
        const terminals = terminalEvents().filter((event) => event.sessionKey === sessionKey);
        const notices = (await loadTranscriptEvents({ ...scope, sessionId })).filter(
          (event) => isRecord(event) && event.customType === "run-failed-before-reply",
        );
        expect(notices).toHaveLength(failed ? 1 : 0);
        if (failed) {
          expect(terminals).toHaveLength(1);
          const terminal = terminals[0];
          assert(terminal);
          expect(terminal.data).toMatchObject({ phase: "error", errorNotice: expect.any(String) });
          const notice = terminal.data.errorNotice;
          expect(notices[0]).toMatchObject({
            display: true,
            content: notice,
            details: { runId: terminal.runId },
          });
          if (unavailable) {
            expect(deliver.mock.calls.map(([payload]) => payload.text)).toEqual([notice]);
          }
        }
        expect(
          vi
            .mocked(defaultRuntime.log)
            .mock.calls.filter(
              ([line]) =>
                line === "Channel request dropped: source authorization is no longer current.",
            ),
        ).toHaveLength(revoke ? 1 : 0);
      } finally {
        predecessor?.complete();
        stop();
        await Promise.all(writes);
        typing.cleanup();
      }
    }
  });
});
