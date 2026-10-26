import path from "node:path";
import { assert, expect, it, vi } from "vitest";
import { projectAgentHarnessTranscriptMessageForDisplay } from "../../agents/harness/transcript-visibility.js";
import { makeZeroUsageSnapshot } from "../../agents/usage.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { initSessionState } from "../../auto-reply/reply/session.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntryReadOnly,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../config/sessions/session-accessor.sqlite-read.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../../infra/outbound/deliver-types.js";
import type { ChannelOutboundSessionRouteParams } from "../../plugin-sdk/core.js";
import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
} from "../../plugin-sdk/core.js";
import * as backgroundResults from "../../sessions/background-session-result.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import { loadCronStore, saveCronStore } from "../store.js";
import {
  withCompletionFixture,
  expectDeliveryWarning,
  installCompletionChannel,
  readConversationMessages,
} from "./current-session-completion.test-fixtures.js";
import * as deliveryPolicy from "./delivery-dispatch-policy.js";
import { dispatchCronDelivery } from "./delivery-dispatch.js";
import { messageToolOutcome } from "./delivery-dispatch.test-fixtures.js";
import { resolveDeliveryTarget } from "./delivery-target.js";

type CompletionFixture = Parameters<Parameters<typeof withCompletionFixture>[0]>[0];
type Conversation = Parameters<typeof readConversationMessages>[0];

function latest(scope: Conversation) {
  return loadSessionEntryReadOnly({ ...scope, readConsistency: "latest" });
}

function usePerPeerSessions(params: CompletionFixture["params"]) {
  params.cfgWithAgentDefaults.session = {
    ...params.cfgWithAgentDefaults.session,
    dmScope: "per-channel-peer",
  };
}

function resetConversation(
  scope: Conversation,
  sessionId = "replacement-session",
  lifecycleRevision = "replacement-generation",
  updatedAt = 3000,
) {
  return resetSessionEntryLifecycle({
    storePath: scope.storePath,
    target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
    buildNextEntry: () => ({ sessionId, lifecycleRevision, updatedAt }),
  });
}
async function prepareDelivery(fixture: CompletionFixture, delivery = fixture.params.job.delivery) {
  fixture.params.job.delivery = delivery;
  fixture.params.deliveryPlan = resolveCronDeliveryPlan(fixture.params.job);
  fixture.params.resolvedDelivery = await resolveDeliveryTarget(
    fixture.params.cfgWithAgentDefaults,
    "main",
    { ...fixture.params.job, ...fixture.params.deliveryPlan },
  );
}

function setReport(fixture: CompletionFixture, text: string | undefined) {
  fixture.params.deliveryPayloads = text ? [{ text }] : [];
  fixture.params.synthesizedText = text;
}

async function expectReport(destination: Conversation, text: string) {
  const messages = await readConversationMessages(destination);
  expect(messages).toHaveLength(1);
  expect(readTranscriptEventMessage(messages[0])?.content).toEqual([{ type: "text", text }]);
}

it("keeps the destination session for a reply to a delivered cron question", () =>
  withCompletionFixture(async (fixture) => {
    const { params } = fixture;
    const lastHumanAt = Date.now() - 185 * 60_000;
    const destination = { ...fixture.scope, sessionKey: "agent:main:telegram:direct:12345" };
    const generation = {
      sessionId: "recipient-session",
      lifecycleRevision: "recipient-generation",
    };
    await replaceSessionEntry(destination, {
      ...generation,
      updatedAt: lastHumanAt,
      sessionStartedAt: lastHumanAt,
      lastInteractionAt: lastHumanAt,
    });
    params.cfgWithAgentDefaults.session = {
      ...params.cfgWithAgentDefaults.session,
      dmScope: "per-channel-peer",
      reset: { mode: "idle", idleMinutes: 180 },
    };
    const sendText = vi.fn(async () => ({ channel: "telegram", messageId: "cron-question" }));
    installCompletionChannel("telegram", { deliveryMode: "direct", sendText });
    await prepareDelivery(fixture, { mode: "announce", channel: "telegram", to: "12345" });
    setReport(fixture, "Approve the scheduled transaction?");

    const deliveryStartedAt = Date.now();
    const delivered = await dispatchCronDelivery(params);
    expect(delivered, JSON.stringify(delivered)).toMatchObject({ delivered: true });
    const entry = latest(destination);
    expect(entry).toMatchObject(generation);
    expect(entry?.lastInteractionAt).toBeGreaterThanOrEqual(deliveryStartedAt);

    expect(await dispatchCronDelivery(params)).toMatchObject({ delivered: true });
    expect(sendText).toHaveBeenCalledOnce();
    expect(latest(destination)?.lastInteractionAt).toBe(entry?.lastInteractionAt);

    const reply = await initSessionState({
      cfg: params.cfgWithAgentDefaults,
      commandAuthorized: false,
      ctx: finalizeInboundContext({
        Body: "ok",
        ChatType: "direct",
        SessionKey: destination.sessionKey,
        Provider: "telegram",
        From: "telegram:12345",
      }),
    });
    expect(reply).toMatchObject({
      isNewSession: false,
      sessionId: generation.sessionId,
      sessionEntry: generation,
    });
    await expectReport(destination, "Approve the scheduled transaction?");
  }, "isolated"));

it("sends a native-only Discord embed without inventing conversation text", () =>
  withCompletionFixture(async (fixture) => {
    const { params } = fixture;
    const payload: ReplyPayload = {
      channelData: {
        discord: { embeds: [{ title: "Report ready", description: "Native report body" }] },
      },
    };
    const sendText = vi.fn();
    const sendPayload = vi.fn(async (request: { payload: ReplyPayload }) => {
      expect(request.payload.channelData).toEqual(payload.channelData);
      expect(request.payload.text ?? "").toBe("");
      return { channel: "discord", messageId: "native-report" };
    });
    installCompletionChannel("discord", { deliveryMode: "direct", sendText, sendPayload });
    await prepareDelivery(fixture, {
      mode: "announce",
      channel: "discord",
      to: "channel:12345",
    });
    assert(params.resolvedDelivery.ok);
    assert(params.resolvedDelivery.sessionRoute);
    const destinationSessionKey = params.resolvedDelivery.sessionRoute.sessionKey;
    params.deliveryPayloads = [payload];
    params.summary = undefined;
    params.outputText = undefined;
    params.synthesizedText = undefined;

    const result = await dispatchCronDelivery(params);
    expectDeliveryWarning(result, "native-only payload not added to conversation");
    expect(sendPayload).toHaveBeenCalledOnce();
    expect(sendText).not.toHaveBeenCalled();
    expect(await fixture.messages()).toEqual([]);
    expect(
      await readConversationMessages({
        ...fixture.scope,
        sessionKey: destinationSessionKey,
      }),
    ).toEqual([]);
  }, "isolated"));

it("inherits required sandbox policy from the exact execution source for a new destination", () =>
  withCompletionFixture(async (fixture) => {
    const { params } = fixture;
    const actor = { type: "human" as const, source: "profile" as const, id: "cron-creator" };
    const destination = {
      ...fixture.scope,
      sessionKey: "agent:main:telegram:direct:12345",
    };
    await replaceSessionEntry(
      { ...fixture.scope, sessionKey: params.runSessionKey },
      {
        sessionId: params.sessionId,
        lifecycleRevision: params.lifecycleRevision,
        updatedAt: 1,
        createdVia: "cron",
        createdActor: actor,
        sandbox: "required",
      },
    );
    const sendText = vi.fn(async () => ({
      channel: "telegram",
      messageId: "sandboxed-report",
    }));
    installCompletionChannel("telegram", { deliveryMode: "direct", sendText });
    usePerPeerSessions(params);
    await prepareDelivery(fixture, { mode: "announce", channel: "telegram", to: "12345" });
    setReport(fixture, "Sandboxed report");

    expect(await dispatchCronDelivery(params)).toMatchObject({ delivered: true });
    expect(sendText).toHaveBeenCalledOnce();
    expect(latest(destination)).toMatchObject({
      sandbox: "required",
      createdVia: "cron",
      createdActor: actor,
    });
    expect(await readConversationMessages(destination)).toHaveLength(1);
    expect(await fixture.messages()).toEqual([]);
  }, "isolated"));

it.each(["rejected", "uncertain"] as const)(
  "does not rebind remembered main coordinates when the recipient is %s",
  (outcome) =>
    withCompletionFixture(async (fixture) => {
      const clock = outcome === "uncertain" ? vi.spyOn(Date, "now") : undefined;
      const destination = { ...fixture.scope, sessionKey: "agent:main:main" };
      await replaceSessionEntry(destination, {
        sessionId: "remembered-session",
        updatedAt: 1,
        delivery: normalizeSessionDeliveryState({
          context: { channel: "telegram", to: "67890", accountId: "default", threadId: "12" },
        }),
      });
      const original = latest(destination);
      const sendText = vi.fn(async () => {
        if (clock) {
          clock.mockReturnValue(Date.now() + 31_000);
          const error = Object.assign(new Error("read ECONNRESET after send"), {
            code: "ECONNRESET",
          });
          throw new OutboundDeliveryError(error.message, {
            cause: error,
            stage: "platform_send",
            payloadOutcomes: [
              {
                index: 0,
                status: "failed",
                error,
                sentBeforeError: true,
                stage: "platform_send",
              },
            ],
          });
        }
        throw new PlatformMessageNotDispatchedError("chat not found", {
          cause: new Error("recipient not found"),
          retryable: false,
        });
      });
      installCompletionChannel("telegram", { deliveryMode: "direct", sendText });
      try {
        await prepareDelivery(fixture, { mode: "announce", channel: "telegram", to: "12345" });
        assert(fixture.params.resolvedDelivery.ok);
        expect(fixture.params.resolvedDelivery.sessionRoute?.sessionKey).toBe(
          destination.sessionKey,
        );
        setReport(fixture, "Undelivered report");

        expect(await dispatchCronDelivery(fixture.params)).toMatchObject(
          outcome === "uncertain"
            ? { delivered: undefined, deliveryState: { status: "unknown" } }
            : { delivered: false },
        );
        expect(sendText).toHaveBeenCalledOnce();
        expect(latest(destination)).toEqual(original);
        expect(await readConversationMessages(destination)).toEqual([]);
        expect(await fixture.messages()).toEqual([]);
      } finally {
        clock?.mockRestore();
      }
    }, "isolated"),
);

it.each(["persistent", "threaded", "stable", "tool-commit-failure", "cross-agent"] as const)(
  "routes %s output without duplicate conversation writes or sends",
  (mode) =>
    withCompletionFixture(async (fixture, state) => {
      const { params } = fixture;
      const destinationKey =
        mode === "threaded"
          ? "agent:main:telegram:direct:12345:thread:12345:42"
          : "agent:main:telegram:direct:12345";

      const commitFailure =
        mode === "tool-commit-failure"
          ? vi
              .spyOn(backgroundResults, "commitBackgroundResultToSession")
              .mockRejectedValue(new Error("completion commit rejected"))
          : undefined;
      const destination = {
        ...fixture.scope,
        sessionKey: destinationKey,
        sessionId: "recipient-session",
      };
      usePerPeerSessions(params);
      if (mode === "cross-agent") {
        params.cfgWithAgentDefaults.agents = {
          entries: {
            main: { workspace: state.workspaceDir },
            other: { workspace: state.path("other-workspace") },
          },
        };
        params.cfgWithAgentDefaults.bindings = [
          {
            agentId: "other",
            match: {
              channel: "telegram",
              accountId: "default",
              peer: { kind: "direct", id: "12345" },
            },
          },
        ];
      }
      params.agentSessionKey = "agent:main:telegram:direct:12345:thread:12345:99";
      await replaceSessionEntry(
        { ...fixture.scope, sessionKey: params.agentSessionKey },
        {
          sessionId: params.sessionId,
          lifecycleRevision: params.lifecycleRevision,
          updatedAt: 1,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "telegram", to: "12345", threadId: "99" },
          }),
        },
      );
      if (mode === "persistent") {
        await replaceSessionEntry(destination, {
          sessionId: destination.sessionId,
          updatedAt: 1,
        });
      }
      if (mode === "stable") {
        // v2026.9.9 stored sessionKey, but did not store sourceConversation.
        delete fixture.job.sourceConversation;
        const storePath = state.path("cron", "jobs.json");
        await saveCronStore(storePath, { version: 1, jobs: [fixture.job] });
        const [reloaded] = (await loadCronStore(storePath)).jobs;
        if (!reloaded) {
          throw new Error("Stored v2026.9.9 job was not loaded");
        }
        expect(reloaded).not.toHaveProperty("sourceConversation");
        params.job = reloaded;
      }
      if (mode === "persistent") {
        params.agentSessionKey = "Agent:Main:Telegram:Direct:12345";
        params.runSessionKey = params.agentSessionKey;
        params.sessionId = destination.sessionId;
        fixture.job.sessionTarget = `session:${params.agentSessionKey}`;
        await persistSessionTranscriptTurn(destination, {
          updateMode: "none",
          messages: [
            {
              message: projectAgentHarnessTranscriptMessageForDisplay({
                hidden: false,
                inputProvenance: { kind: "internal_system", sourceTool: "cron_execution" },
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "Final destination report" }],
                  api: "openai-completions",
                  provider: "test",
                  model: "test",
                  stopReason: "stop",
                  usage: makeZeroUsageSnapshot(),
                  timestamp: 1000,
                },
              }),
            },
          ],
        });
      }
      const sendText = vi.fn(async (request: { to: string; threadId?: string | number | null }) => {
        expect(request.to).toBe(mode === "threaded" ? "12345:topic:42" : "12345");
        expect(request.threadId).toBe(mode === "threaded" ? 42 : undefined);
        if (mode === "persistent") {
          expect(await readConversationMessages(destination)).toHaveLength(1);
        } else if (mode !== "cross-agent") {
          expect(latest(destination)).toBeUndefined();
        }
        expect(await fixture.messages()).toEqual([]);
        return { channel: "telegram", messageId: "notification-message" };
      });
      installCompletionChannel(
        "telegram",
        { deliveryMode: "direct", sendText },
        {
          resolveOutboundSessionRoute: (routeParams: ChannelOutboundSessionRouteParams) => {
            const chatId = routeParams.target.split(":")[0]!;
            const route = buildChannelOutboundSessionRoute({
              cfg: routeParams.cfg,
              agentId: routeParams.agentId,
              channel: "telegram",
              accountId: routeParams.accountId,
              peer: { kind: "direct", id: chatId },
              chatType: "direct",
              from: `telegram:${chatId}`,
              to: `telegram:${chatId}`,
              recipientSessionExact: true,
            });
            // Models Telegram's current-session thread recovery (extensions/telegram/src/channel.ts:459-466).
            const threaded = buildThreadAwareOutboundSessionRoute({
              route,
              threadId:
                routeParams.threadId == null ? undefined : `${chatId}:${routeParams.threadId}`,
              currentSessionKey: routeParams.currentSessionKey,
              precedence: ["threadId", "currentSession"],
            });
            const threadId = threaded.threadId?.toString().split(":").at(-1);
            return {
              ...threaded,
              threadId: threadId === undefined ? undefined : Number(threadId),
              to:
                threadId === undefined
                  ? `telegram:${chatId}`
                  : `telegram:${chatId}:topic:${threadId}`,
            };
          },
        },
      );
      try {
        await prepareDelivery(fixture, {
          mode: "announce",
          channel: "telegram",
          to: "12345",
          ...(mode === "threaded" ? { threadId: 42 } : {}),
          ...(mode === "cross-agent" ? { accountId: "default" } : {}),
        });
        setReport(fixture, "Final destination report");
        if (mode === "tool-commit-failure") {
          params.sourceDeliveryOutcome = messageToolOutcome([
            {
              tool: "message",
              provider: "telegram",
              to: "12345",
              text: "Final destination report",
            },
          ]);
        }
        const expected = { delivered: true };
        const result = await dispatchCronDelivery(params);
        expect(result).toMatchObject(expected);
        expect(await dispatchCronDelivery(params)).toMatchObject(expected);
        expect(sendText).toHaveBeenCalledTimes(mode === "tool-commit-failure" ? 0 : 1);
        if (commitFailure) {
          expectDeliveryWarning(
            result,
            "result was delivered but was not added to the conversation: completion commit rejected",
          );
        }
        if (mode === "cross-agent") {
          expectDeliveryWarning(
            result,
            "Conversation context skipped: the destination belongs to a different agent.",
          );
          expect(fixture.updates()).toBe(0);
          for (const agentId of ["main", "other"]) {
            expect(
              loadSessionEntryReadOnly({
                agentId,
                sessionKey: `agent:${agentId}:telegram:direct:12345`,
                storePath: path.join(
                  state.stateDir,
                  "agents",
                  agentId,
                  "sessions",
                  "sessions.json",
                ),
                readConsistency: "latest",
              }),
            ).toBeUndefined();
          }
        } else {
          const messages = await readConversationMessages(destination);
          if (commitFailure) {
            expect(messages).toEqual([]);
          } else {
            const transcriptMessages = messages.map(readTranscriptEventMessage);
            // Keep scheduled execution in audit history, with one settled visible result.
            expect(transcriptMessages).toHaveLength(mode === "persistent" ? 2 : 1);
            if (mode === "persistent") {
              expect(transcriptMessages[0]).toMatchObject({
                display: false,
                content: [{ type: "text", text: "Final destination report" }],
              });
            }
            const visibleMessages = transcriptMessages.filter(
              (message) => message && Reflect.get(message, "display") !== false,
            );
            expect(visibleMessages).toHaveLength(1);
            expect(visibleMessages[0]?.content).toEqual([
              { type: "text", text: "Final destination report" },
            ]);
          }
        }
        expect(await fixture.messages()).toEqual([]);
      } finally {
        commitFailure?.mockRestore();
      }
    }, "isolated"),
);

it.each(["no-route", "silent"] as const)(
  "keeps the %s result out of unrelated conversations and channel sends",
  (mode) =>
    withCompletionFixture(async (fixture) => {
      const { params } = fixture;
      const sendText = vi.fn(async () => ({ channel: "telegram", messageId: "unexpected" }));
      installCompletionChannel("telegram", { deliveryMode: "direct", sendText });
      usePerPeerSessions(params);
      params.deliveryRequested = true;
      await prepareDelivery(
        fixture,
        mode === "no-route"
          ? { mode: "announce", channel: "last" }
          : { mode: "announce", channel: "telegram", to: "12345" },
      );
      setReport(fixture, mode === "silent" ? undefined : "Final creator report");
      if (mode === "silent") {
        params.skipDelivery = "silent";
      }
      const result = await dispatchCronDelivery(params);
      if (mode === "no-route") {
        expect(result.delivered).toBe(true);
        expect(await dispatchCronDelivery(params)).toMatchObject({ delivered: true });
        const messages = await fixture.messages();
        expect(messages).toHaveLength(1);
        expect(readTranscriptEventMessage(messages[0])?.content).toEqual([
          { type: "text", text: "Final creator report" },
        ]);
      } else {
        expect(await fixture.messages()).toEqual([]);
        expect(fixture.updates()).toBe(0);
        expect(result).toMatchObject({
          disposition: { kind: "suppressed" },
          deliverySuppressionReason: "silent",
        });
      }
      expect(
        latest({ ...fixture.scope, sessionKey: "agent:main:telegram:direct:12345" }),
      ).toBeUndefined();
      expect(sendText).not.toHaveBeenCalled();
    }, "isolated"),
);

it("delivers into the current destination after resets before send and between runs", () =>
  withCompletionFixture(async (fixture) => {
    const { params } = fixture;
    const destination = {
      ...fixture.scope,
      sessionKey: "agent:main:telegram:direct:123",
    };
    await replaceSessionEntry(destination, {
      sessionId: "recipient-session",
      lifecycleRevision: "recipient-generation",
      updatedAt: 1,
    });
    usePerPeerSessions(params);
    const sendText = vi.fn(async () => ({ channel: "telegram", messageId: "current-message" }));
    installCompletionChannel("telegram", { deliveryMode: "direct", sendText });
    const tts = vi
      .spyOn(deliveryPolicy, "maybeApplyTtsToCronPayloads")
      .mockImplementationOnce(async ({ payloads }) => {
        expect(await readConversationMessages(destination)).toHaveLength(0);
        await resetConversation(destination);
        return payloads;
      });
    try {
      await prepareDelivery(fixture, { mode: "announce", channel: "telegram", to: "123" });
      setReport(fixture, "Report after destination reset");
      const result = await dispatchCronDelivery(params);
      expect(sendText).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ delivered: true, deliveryError: undefined });
      expect(latest(destination)).toMatchObject({
        sessionId: "replacement-session",
        lifecycleRevision: "replacement-generation",
      });
      await expectReport(destination, "Report after destination reset");

      await resetConversation(
        destination,
        "next-recipient-session",
        "next-recipient-generation",
        4000,
      );
      params.runStartedAt += 1000;
      setReport(fixture, "Next scheduled report");
      expect(await dispatchCronDelivery(params)).toMatchObject({
        delivered: true,
        deliveryError: undefined,
      });
      expect(sendText).toHaveBeenCalledTimes(2);
      expect(latest(destination)).toMatchObject({
        sessionId: "next-recipient-session",
        lifecycleRevision: "next-recipient-generation",
      });
      await expectReport(destination, "Next scheduled report");
      expect(await fixture.messages()).toEqual([]);
    } finally {
      tts.mockRestore();
    }
  }, "isolated"));

it("rejects implicit current delivery when the creator resets after route resolution", () =>
  withCompletionFixture(
    async (fixture) => {
      const { params } = fixture;
      const sendText = vi.fn(async () => ({ channel: "telegram", messageId: "stale-report" }));
      installCompletionChannel("telegram", { deliveryMode: "direct", sendText });
      usePerPeerSessions(params);
      await replaceSessionEntry(fixture.scope, {
        ...params.sourceSessionGeneration,
        sessionId: fixture.scope.sessionId,
        updatedAt: 1,
        delivery: normalizeSessionDeliveryState({
          context: { channel: "telegram", to: "12345", accountId: "default" },
        }),
      });
      params.resolvedDelivery = await resolveDeliveryTarget(params.cfgWithAgentDefaults, "main", {
        ...fixture.job,
        ...params.deliveryPlan,
      });
      assert(params.resolvedDelivery.ok);
      expect(params.resolvedDelivery.to).toBe("12345");
      await resetConversation(fixture.scope);
      setReport(fixture, "Stale report");

      const result = await dispatchCronDelivery(params);
      expect(result).toMatchObject({ delivered: false });
      expect(result.deliveryError).toBeDefined();
      expect(sendText).not.toHaveBeenCalled();
      expect(await readConversationMessages(fixture.scope)).toEqual([]);
    },
    "current",
    "agent:main:telegram:direct:12345",
  ));

it.each(["deleted", "reset"] as const)(
  "records a delivery failure when the creating conversation is %s",
  (change) =>
    withCompletionFixture(async (fixture) => {
      setReport(fixture, "tick");
      if (change === "deleted") {
        await deleteSessionEntryLifecycle({
          archiveTranscript: false,
          storePath: fixture.scope.storePath,
          target: {
            canonicalKey: fixture.scope.sessionKey,
            storeKeys: [fixture.scope.sessionKey],
          },
        });
      } else {
        await resetConversation(fixture.scope);
      }

      const delivery = await dispatchCronDelivery(fixture.params);
      expect(delivery).toMatchObject({
        delivered: false,
        deliveryAttempted: true,
        deliveryError: expect.stringContaining("session rebound"),
        disposition: { kind: "error", errorKind: "delivery-target" },
      });
      expect(await fixture.messages()).toEqual([]);
      expect(fixture.updates()).toBe(0);
    }, "isolated"),
);
