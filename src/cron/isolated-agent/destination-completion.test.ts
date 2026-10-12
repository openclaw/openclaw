import path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";
import { makeZeroUsageSnapshot } from "../../agents/usage.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntryReadOnly,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "../../config/sessions/session-accessor.js";
import * as sessionTranscripts from "../../config/sessions/session-accessor.js";
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
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import { loadCronStore, saveCronStore } from "../store.js";
import {
  createCompletionFixture,
  readConversationMessages,
} from "./current-session-completion.test-fixtures.js";
import * as deliveryPolicy from "./delivery-dispatch-policy.js";
import { dispatchCronDelivery } from "./delivery-dispatch.js";
import { messageToolOutcome } from "./delivery-dispatch.test-fixtures.js";
import { resolveDeliveryTarget } from "./delivery-target.js";

describe("destination-owned completion", () => {
  it("sends a native-only Discord embed without inventing conversation text", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const fixture = await createCompletionFixture(state, "isolated");
      const registry = captureActivePluginRegistrySnapshot();
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
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "discord",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({ id: "discord" }),
              outbound: { deliveryMode: "direct", sendText, sendPayload },
            },
          },
        ]),
      );
      try {
        fixture.job.delivery = { mode: "announce", channel: "discord", to: "channel:12345" };
        fixture.params.deliveryPlan = resolveCronDeliveryPlan(fixture.job);
        fixture.params.resolvedDelivery = await resolveDeliveryTarget(
          fixture.params.cfgWithAgentDefaults,
          "main",
          { ...fixture.job, ...fixture.params.deliveryPlan },
        );
        assert(fixture.params.resolvedDelivery.ok);
        assert(fixture.params.resolvedDelivery.sessionRoute);
        const destinationSessionKey = fixture.params.resolvedDelivery.sessionRoute.sessionKey;
        fixture.params.deliveryPayloads = [payload];
        fixture.params.summary = undefined;
        fixture.params.outputText = undefined;
        fixture.params.synthesizedText = undefined;

        const result = await dispatchCronDelivery(fixture.params);
        expect(result).toMatchObject({
          delivered: true,
          deliveryError: undefined,
          diagnostics: {
            entries: expect.arrayContaining([
              expect.objectContaining({
                source: "delivery",
                severity: "warn",
                message: "native-only payload not added to conversation",
              }),
            ]),
          },
        });
        expect(sendPayload).toHaveBeenCalledOnce();
        expect(sendText).not.toHaveBeenCalled();
        expect(await fixture.messages()).toEqual([]);
        expect(
          loadSessionEntryReadOnly({
            ...fixture.scope,
            sessionKey: destinationSessionKey,
            readConsistency: "latest",
          }),
        ).toBeUndefined();
      } finally {
        restoreActivePluginRegistrySnapshot(registry);
        await fixture.dispose();
      }
    });
  });

  it("inherits required sandbox policy from the exact execution source for a new destination", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const fixture = await createCompletionFixture(state, "isolated");
      const registry = captureActivePluginRegistrySnapshot();
      const actor = { type: "human" as const, source: "profile" as const, id: "cron-creator" };
      const destination = {
        ...fixture.scope,
        sessionKey: "agent:main:telegram:direct:12345",
      };
      await replaceSessionEntry(
        { ...fixture.scope, sessionKey: fixture.params.runSessionKey },
        {
          sessionId: fixture.params.sessionId,
          lifecycleRevision: fixture.params.lifecycleRevision,
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
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({ id: "telegram" }),
              outbound: { deliveryMode: "direct", sendText },
            },
          },
        ]),
      );
      try {
        fixture.params.cfgWithAgentDefaults.session = {
          ...fixture.params.cfgWithAgentDefaults.session,
          dmScope: "per-channel-peer",
        };
        fixture.job.delivery = { mode: "announce", channel: "telegram", to: "12345" };
        fixture.params.deliveryPlan = resolveCronDeliveryPlan(fixture.job);
        fixture.params.resolvedDelivery = await resolveDeliveryTarget(
          fixture.params.cfgWithAgentDefaults,
          "main",
          { ...fixture.job, ...fixture.params.deliveryPlan },
        );
        fixture.params.deliveryPayloads = [{ text: "Sandboxed report" }];
        fixture.params.synthesizedText = "Sandboxed report";

        expect(await dispatchCronDelivery(fixture.params)).toMatchObject({ delivered: true });
        expect(sendText).toHaveBeenCalledOnce();
        expect(
          loadSessionEntryReadOnly({ ...destination, readConsistency: "latest" }),
        ).toMatchObject({
          sandbox: "required",
          createdVia: "cron",
          createdActor: actor,
        });
        expect(await readConversationMessages(destination)).toHaveLength(1);
        expect(await fixture.messages()).toEqual([]);
      } finally {
        restoreActivePluginRegistrySnapshot(registry);
        await fixture.dispose();
      }
    });
  });

  it.each(["rejected", "uncertain"] as const)(
    "does not rebind remembered main coordinates when the recipient is %s",
    async (outcome) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const fixture = await createCompletionFixture(state, "isolated");
        const registry = captureActivePluginRegistrySnapshot();
        const clock = outcome === "uncertain" ? vi.spyOn(Date, "now") : undefined;
        const destination = { ...fixture.scope, sessionKey: "agent:main:main" };
        await replaceSessionEntry(destination, {
          sessionId: "remembered-session",
          updatedAt: 1,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "telegram", to: "67890", accountId: "default", threadId: "12" },
          }),
        });
        const original = loadSessionEntryReadOnly({
          ...destination,
          readConsistency: "latest",
        });
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
        setActivePluginRegistry(
          createTestRegistry([
            {
              pluginId: "telegram",
              source: "test",
              plugin: {
                ...createChannelTestPluginBase({ id: "telegram" }),
                outbound: { deliveryMode: "direct", sendText },
              },
            },
          ]),
        );
        try {
          fixture.job.delivery = { mode: "announce", channel: "telegram", to: "12345" };
          fixture.params.deliveryPlan = resolveCronDeliveryPlan(fixture.job);
          fixture.params.resolvedDelivery = await resolveDeliveryTarget(
            fixture.params.cfgWithAgentDefaults,
            "main",
            { ...fixture.job, ...fixture.params.deliveryPlan },
          );
          assert(fixture.params.resolvedDelivery.ok);
          expect(fixture.params.resolvedDelivery.sessionRoute?.sessionKey).toBe(
            destination.sessionKey,
          );
          fixture.params.deliveryPayloads = [{ text: "Undelivered report" }];
          fixture.params.synthesizedText = "Undelivered report";

          expect(await dispatchCronDelivery(fixture.params)).toMatchObject(
            outcome === "uncertain"
              ? { delivered: undefined, deliveryState: { status: "unknown" } }
              : { delivered: false },
          );
          expect(sendText).toHaveBeenCalledOnce();
          expect(loadSessionEntryReadOnly({ ...destination, readConsistency: "latest" })).toEqual(
            original,
          );
          expect(await readConversationMessages(destination)).toEqual([]);
          expect(await fixture.messages()).toEqual([]);
        } finally {
          clock?.mockRestore();
          restoreActivePluginRegistrySnapshot(registry);
          await fixture.dispose();
        }
      });
    },
  );

  it.each([
    "existing",
    "creatorless",
    "persistent",
    "same",
    "threaded",
    "stable",
    "uncertain",
    "rejected",
    "commit-failure",
    "tool-delivered",
    "cross-agent",
  ] as const)("routes %s output without duplicate conversation writes or sends", async (mode) => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const destinationKey =
        mode === "threaded"
          ? "agent:main:telegram:direct:12345:thread:12345:42"
          : "agent:main:telegram:direct:12345";
      const fixture = await createCompletionFixture(
        state,
        "isolated",
        mode === "same" ? destinationKey : undefined,
      );
      const registry = captureActivePluginRegistrySnapshot();
      const clock = mode === "uncertain" ? vi.spyOn(Date, "now") : undefined;
      const commitFailure =
        mode === "commit-failure"
          ? vi
              .spyOn(sessionTranscripts, "persistSessionTranscriptTurn")
              .mockRejectedValue(new Error("completion commit rejected"))
          : undefined;
      const destination = {
        ...fixture.scope,
        sessionKey: destinationKey,
        sessionId: mode === "same" ? fixture.scope.sessionId : "recipient-session",
      };
      fixture.params.cfgWithAgentDefaults.session = {
        ...fixture.params.cfgWithAgentDefaults.session,
        dmScope: "per-channel-peer",
      };
      if (mode === "cross-agent") {
        fixture.params.cfgWithAgentDefaults.agents = {
          entries: {
            main: { workspace: state.workspaceDir },
            other: { workspace: state.path("other-workspace") },
          },
        };
        fixture.params.cfgWithAgentDefaults.bindings = [
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
      fixture.params.agentSessionKey = "agent:main:telegram:direct:12345:thread:12345:99";
      await replaceSessionEntry(
        { ...fixture.scope, sessionKey: fixture.params.agentSessionKey },
        {
          sessionId: fixture.params.sessionId,
          lifecycleRevision: fixture.params.lifecycleRevision,
          updatedAt: 1,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "telegram", to: "12345", threadId: "99" },
          }),
        },
      );
      if (mode === "existing" || mode === "persistent") {
        await replaceSessionEntry(destination, {
          sessionId: destination.sessionId,
          updatedAt: 1,
        });
      }
      if (mode === "creatorless") {
        delete fixture.params.sourceSessionKey;
        delete fixture.params.sourceSessionGeneration;
        delete fixture.job.sourceConversation;
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
        fixture.params.job = reloaded;
      }
      if (mode === "persistent" || mode === "tool-delivered") {
        if (mode === "persistent") {
          fixture.params.agentSessionKey = "Agent:Main:Telegram:Direct:12345";
          fixture.params.runSessionKey = fixture.params.agentSessionKey;
          fixture.params.sessionId = destination.sessionId;
          fixture.job.sessionTarget = `session:${fixture.params.agentSessionKey}`;
        } else {
          await replaceSessionEntry(destination, {
            sessionId: destination.sessionId,
            updatedAt: 1,
          });
        }
        await persistSessionTranscriptTurn(destination, {
          updateMode: "none",
          messages: [
            {
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
            },
          ],
        });
      }
      const sendText = vi.fn(async (request: { to: string; threadId?: string | number }) => {
        expect(request.to).toBe(mode === "threaded" ? "12345:topic:42" : "12345");
        expect(request.threadId).toBe(mode === "threaded" ? 42 : undefined);
        if (mode === "existing" || mode === "persistent" || mode === "same") {
          expect(await readConversationMessages(destination)).toHaveLength(
            mode === "persistent" ? 1 : 0,
          );
        } else if (mode !== "cross-agent") {
          expect(
            loadSessionEntryReadOnly({ ...destination, readConsistency: "latest" }),
          ).toBeUndefined();
        }
        if (mode !== "same") {
          expect(await fixture.messages()).toEqual([]);
        }
        if (mode === "rejected") {
          throw new PlatformMessageNotDispatchedError("chat not found", {
            cause: new Error("recipient not found"),
            retryable: false,
          });
        }
        if (clock) {
          clock.mockReturnValue(Date.now() + 31_000);
          const error = Object.assign(new Error("read ECONNRESET after send"), {
            code: "ECONNRESET",
          });
          throw new OutboundDeliveryError(error.message, {
            cause: error,
            stage: "platform_send",
            payloadOutcomes: [
              { index: 0, status: "failed", error, sentBeforeError: true, stage: "platform_send" },
            ],
          });
        }
        return { channel: "telegram", messageId: "notification-message" };
      });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({ id: "telegram" }),
              messaging: {
                resolveOutboundSessionRoute: (params: ChannelOutboundSessionRouteParams) => {
                  const chatId = params.target.split(":")[0]!;
                  const route = buildChannelOutboundSessionRoute({
                    cfg: params.cfg,
                    agentId: params.agentId,
                    channel: "telegram",
                    accountId: params.accountId,
                    peer: { kind: "direct", id: chatId },
                    chatType: "direct",
                    from: `telegram:${chatId}`,
                    to: `telegram:${chatId}`,
                    recipientSessionExact: true,
                  });
                  // Models Telegram's current-session thread recovery (extensions/telegram/src/channel.ts:459-466).
                  const threaded = buildThreadAwareOutboundSessionRoute({
                    route,
                    threadId: params.threadId == null ? undefined : `${chatId}:${params.threadId}`,
                    currentSessionKey: params.currentSessionKey,
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
              outbound: { deliveryMode: "direct", sendText },
            },
          },
        ]),
      );
      try {
        fixture.params.job.delivery = {
          mode: "announce",
          channel: "telegram",
          to: "12345",
          ...(mode === "threaded" ? { threadId: 42 } : {}),
          ...(mode === "cross-agent" ? { accountId: "default" } : {}),
        };
        fixture.params.deliveryPlan = resolveCronDeliveryPlan(fixture.params.job);
        fixture.params.resolvedDelivery = await resolveDeliveryTarget(
          fixture.params.cfgWithAgentDefaults,
          "main",
          { ...fixture.params.job, ...fixture.params.deliveryPlan },
        );
        fixture.params.deliveryPayloads = [{ text: "Final destination report" }];
        fixture.params.synthesizedText = "Final destination report";
        if (mode === "tool-delivered") {
          fixture.params.sourceDeliveryOutcome = messageToolOutcome([
            {
              tool: "message",
              provider: "telegram",
              to: "12345",
              text: "Final destination report",
            },
          ]);
        }
        const expected =
          mode === "uncertain"
            ? { deliveryState: { status: "unknown" }, delivered: undefined }
            : { delivered: mode !== "rejected" };
        const result = await dispatchCronDelivery(fixture.params);
        expect(result).toMatchObject(expected);
        if (mode !== "rejected") {
          expect(await dispatchCronDelivery(fixture.params)).toMatchObject(expected);
        }
        expect(sendText).toHaveBeenCalledTimes(mode === "tool-delivered" ? 0 : 1);
        if (commitFailure) {
          expect(result.deliveryError).toBeUndefined();
        }
        if (mode === "uncertain" || commitFailure) {
          expect(result).toMatchObject({
            diagnostics: {
              entries: expect.arrayContaining([
                expect.objectContaining({
                  source: "delivery",
                  severity: "warn",
                  message:
                    mode === "uncertain"
                      ? "result may have been delivered but was not added to the conversation"
                      : "result was delivered but was not added to the conversation: completion commit rejected",
                }),
              ]),
            },
          });
        }
        if (mode === "cross-agent") {
          expect(result).toMatchObject({
            delivered: true,
            deliveryError: undefined,
            diagnostics: {
              entries: expect.arrayContaining([
                expect.objectContaining({
                  source: "delivery",
                  severity: "warn",
                  message:
                    "Conversation context skipped: the destination belongs to a different agent.",
                }),
              ]),
            },
          });
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
        } else if (mode === "uncertain" || mode === "rejected") {
          expect(
            loadSessionEntryReadOnly({ ...destination, readConsistency: "latest" }),
          ).toBeUndefined();
        } else {
          const messages = await readConversationMessages(destination);
          if (commitFailure) {
            expect(messages).toEqual([]);
          } else {
            expect(messages).toHaveLength(1);
            expect(readTranscriptEventMessage(messages[0])?.content).toEqual([
              { type: "text", text: "Final destination report" },
            ]);
          }
        }
        if (mode !== "same") {
          expect(await fixture.messages()).toEqual([]);
        }
      } finally {
        restoreActivePluginRegistrySnapshot(registry);
        clock?.mockRestore();
        commitFailure?.mockRestore();
        await fixture.dispose();
      }
    });
  });

  it.each(["no-route", "silent", "none", "webhook"] as const)(
    "keeps the %s result out of unrelated conversations and channel sends",
    async (mode) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const fixture = await createCompletionFixture(state, "isolated");
        const registry = captureActivePluginRegistrySnapshot();
        const sendText = vi.fn(async () => ({ channel: "telegram", messageId: "unexpected" }));
        setActivePluginRegistry(
          createTestRegistry([
            {
              pluginId: "telegram",
              source: "test",
              plugin: {
                ...createChannelTestPluginBase({ id: "telegram" }),
                outbound: { deliveryMode: "direct", sendText },
              },
            },
          ]),
        );
        try {
          fixture.params.cfgWithAgentDefaults.session = {
            ...fixture.params.cfgWithAgentDefaults.session,
            dmScope: "per-channel-peer",
          };
          fixture.job.delivery =
            mode === "no-route"
              ? { mode: "announce", channel: "last" }
              : mode === "webhook"
                ? { mode: "webhook", to: "https://example.invalid/hook" }
                : mode === "none"
                  ? { mode: "none" }
                  : { mode: "announce", channel: "telegram", to: "12345" };
          fixture.params.deliveryPlan = resolveCronDeliveryPlan(fixture.job);
          fixture.params.deliveryRequested = mode !== "none" && mode !== "webhook";
          if (fixture.params.deliveryRequested) {
            fixture.params.resolvedDelivery = await resolveDeliveryTarget(
              fixture.params.cfgWithAgentDefaults,
              "main",
              { ...fixture.job, ...fixture.params.deliveryPlan },
            );
          }
          const text = mode === "silent" ? "NO_REPLY" : "Final creator report";
          fixture.params.deliveryPayloads = [{ text }];
          fixture.params.synthesizedText = text;
          const result = await dispatchCronDelivery(fixture.params);
          if (mode === "no-route") {
            expect(result.delivered).toBe(true);
            expect(await dispatchCronDelivery(fixture.params)).toMatchObject({ delivered: true });
            const messages = await fixture.messages();
            expect(messages).toHaveLength(1);
            expect(readTranscriptEventMessage(messages[0])?.content).toEqual([
              { type: "text", text: "Final creator report" },
            ]);
          } else {
            expect(await fixture.messages()).toEqual([]);
            expect(fixture.updates()).toBe(0);
            if (mode === "silent") {
              expect(result).toMatchObject({
                disposition: { kind: "suppressed" },
                deliverySuppressionReason: "silent",
              });
            }
          }
          expect(
            loadSessionEntryReadOnly({
              ...fixture.scope,
              sessionKey: "agent:main:telegram:direct:12345",
              readConsistency: "latest",
            }),
          ).toBeUndefined();
          expect(sendText).not.toHaveBeenCalled();
        } finally {
          restoreActivePluginRegistrySnapshot(registry);
          await fixture.dispose();
        }
      });
    },
  );

  it("delivers into the current destination after resets before send and between runs", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const fixture = await createCompletionFixture(state, "isolated");
      const registry = captureActivePluginRegistrySnapshot();
      const destination = {
        ...fixture.scope,
        sessionKey: "agent:main:telegram:direct:123",
      };
      await replaceSessionEntry(destination, {
        sessionId: "recipient-session",
        lifecycleRevision: "recipient-generation",
        updatedAt: 1,
      });
      fixture.params.cfgWithAgentDefaults.session = {
        ...fixture.params.cfgWithAgentDefaults.session,
        dmScope: "per-channel-peer",
      };
      const sendText = vi.fn(async () => ({ channel: "telegram", messageId: "current-message" }));
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({ id: "telegram" }),
              outbound: { deliveryMode: "direct", sendText },
            },
          },
        ]),
      );
      const tts = vi
        .spyOn(deliveryPolicy, "maybeApplyTtsToCronPayloads")
        .mockImplementationOnce(async ({ payloads }) => {
          expect(await readConversationMessages(destination)).toHaveLength(0);
          await resetSessionEntryLifecycle({
            storePath: fixture.scope.storePath,
            target: {
              canonicalKey: destination.sessionKey,
              storeKeys: [destination.sessionKey],
            },
            buildNextEntry: () => ({
              sessionId: "replacement-session",
              lifecycleRevision: "replacement-generation",
              updatedAt: 3000,
            }),
          });
          return payloads;
        });
      try {
        fixture.params.job.delivery = { mode: "announce", channel: "telegram", to: "123" };
        fixture.params.deliveryPlan = resolveCronDeliveryPlan(fixture.params.job);
        fixture.params.resolvedDelivery = await resolveDeliveryTarget(
          fixture.params.cfgWithAgentDefaults,
          "main",
          { ...fixture.job, ...fixture.params.deliveryPlan },
        );
        fixture.params.deliveryPayloads = [{ text: "Report after destination reset" }];
        fixture.params.synthesizedText = "Report after destination reset";
        const result = await dispatchCronDelivery(fixture.params);
        expect(sendText).toHaveBeenCalledOnce();
        expect(result).toMatchObject({ delivered: true, deliveryError: undefined });
        expect(
          loadSessionEntryReadOnly({ ...destination, readConsistency: "latest" }),
        ).toMatchObject({
          sessionId: "replacement-session",
          lifecycleRevision: "replacement-generation",
        });
        const messages = await readConversationMessages(destination);
        expect(messages).toHaveLength(1);
        expect(readTranscriptEventMessage(messages[0])?.content).toEqual([
          { type: "text", text: "Report after destination reset" },
        ]);

        await resetSessionEntryLifecycle({
          storePath: fixture.scope.storePath,
          target: {
            canonicalKey: destination.sessionKey,
            storeKeys: [destination.sessionKey],
          },
          buildNextEntry: () => ({
            sessionId: "next-recipient-session",
            lifecycleRevision: "next-recipient-generation",
            updatedAt: 4000,
          }),
        });
        fixture.params.runStartedAt += 1000;
        fixture.params.deliveryPayloads = [{ text: "Next scheduled report" }];
        fixture.params.synthesizedText = "Next scheduled report";
        expect(await dispatchCronDelivery(fixture.params)).toMatchObject({
          delivered: true,
          deliveryError: undefined,
        });
        expect(sendText).toHaveBeenCalledTimes(2);
        expect(
          loadSessionEntryReadOnly({ ...destination, readConsistency: "latest" }),
        ).toMatchObject({
          sessionId: "next-recipient-session",
          lifecycleRevision: "next-recipient-generation",
        });
        const nextMessages = await readConversationMessages(destination);
        expect(nextMessages).toHaveLength(1);
        expect(readTranscriptEventMessage(nextMessages[0])?.content).toEqual([
          { type: "text", text: "Next scheduled report" },
        ]);
        expect(await fixture.messages()).toEqual([]);
      } finally {
        tts.mockRestore();
        restoreActivePluginRegistrySnapshot(registry);
        await fixture.dispose();
      }
    });
  });

  it.each(["isolated", "current"] as const)(
    "rejects implicit %s delivery when the creator resets after route resolution",
    async (sessionTarget) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const fixture = await createCompletionFixture(
          state,
          sessionTarget,
          "agent:main:telegram:direct:12345",
        );
        const registry = captureActivePluginRegistrySnapshot();
        const sendText = vi.fn(async () => ({ channel: "telegram", messageId: "stale-report" }));
        setActivePluginRegistry(
          createTestRegistry([
            {
              pluginId: "telegram",
              source: "test",
              plugin: {
                ...createChannelTestPluginBase({ id: "telegram" }),
                outbound: { deliveryMode: "direct", sendText },
              },
            },
          ]),
        );
        try {
          fixture.params.cfgWithAgentDefaults.session = {
            ...fixture.params.cfgWithAgentDefaults.session,
            dmScope: "per-channel-peer",
          };
          await replaceSessionEntry(fixture.scope, {
            ...fixture.params.sourceSessionGeneration,
            sessionId: fixture.scope.sessionId,
            updatedAt: 1,
            delivery: normalizeSessionDeliveryState({
              context: { channel: "telegram", to: "12345", accountId: "default" },
            }),
          });
          fixture.params.resolvedDelivery = await resolveDeliveryTarget(
            fixture.params.cfgWithAgentDefaults,
            "main",
            { ...fixture.job, ...fixture.params.deliveryPlan },
          );
          assert(fixture.params.resolvedDelivery.ok);
          expect(fixture.params.resolvedDelivery.to).toBe("12345");
          await resetSessionEntryLifecycle({
            storePath: fixture.scope.storePath,
            target: {
              canonicalKey: fixture.scope.sessionKey,
              storeKeys: [fixture.scope.sessionKey],
            },
            buildNextEntry: () => ({
              sessionId: "replacement-session",
              lifecycleRevision: "replacement-generation",
              updatedAt: 3000,
            }),
          });
          fixture.params.deliveryPayloads = [{ text: "Stale report" }];
          fixture.params.synthesizedText = "Stale report";

          const result = await dispatchCronDelivery(fixture.params);
          expect(result).toMatchObject({ delivered: false });
          expect(result.deliveryError).toBeDefined();
          expect(sendText).not.toHaveBeenCalled();
          expect(await readConversationMessages(fixture.scope)).toEqual([]);
        } finally {
          restoreActivePluginRegistrySnapshot(registry);
          await fixture.dispose();
        }
      });
    },
  );

  it.each(["deleted", "reset"] as const)(
    "records a delivery failure when the creating conversation is %s",
    async (change) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const fixture = await createCompletionFixture(state, "isolated");
        try {
          fixture.params.deliveryPayloads = [{ text: "tick" }];
          fixture.params.synthesizedText = "tick";
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
            await resetSessionEntryLifecycle({
              storePath: fixture.scope.storePath,
              target: {
                canonicalKey: fixture.scope.sessionKey,
                storeKeys: [fixture.scope.sessionKey],
              },
              buildNextEntry: () => ({
                sessionId: "replacement-session",
                lifecycleRevision: "replacement-generation",
                updatedAt: 3000,
              }),
            });
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
        } finally {
          await fixture.dispose();
        }
      });
    },
  );

  it.each(["explicit", "remembered"] as const)(
    "does not write a result when the %s external route is unavailable",
    async (route) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const fixture = await createCompletionFixture(state, "isolated");
        try {
          fixture.params.deliveryPayloads = [{ text: "tick" }];
          fixture.params.synthesizedText = "tick";
          if (route === "explicit") {
            fixture.params.job.delivery = { mode: "announce", channel: "missing-channel" };
            fixture.params.deliveryPlan = resolveCronDeliveryPlan(fixture.params.job);
          } else {
            fixture.params.resolvedDelivery = {
              ok: false,
              channel: "telegram",
              mode: "implicit",
              error: new Error("Remembered channel unavailable"),
            };
          }
          await expect(dispatchCronDelivery(fixture.params)).resolves.toMatchObject({
            delivered: false,
            deliveryError:
              route === "explicit" ? "No external channel" : "Remembered channel unavailable",
            disposition: { kind: "error", errorKind: "delivery-target" },
          });
          expect(await fixture.messages()).toEqual([]);
          expect(fixture.updates()).toBe(0);
        } finally {
          await fixture.dispose();
        }
      });
    },
  );
});
