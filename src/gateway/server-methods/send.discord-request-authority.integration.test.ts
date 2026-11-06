import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { onTrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getDeliveryQueueEntryStatus } from "../../infra/delivery-queue-sqlite.test-support.js";
import { isDeliveryRecoveryRetryEligible } from "../../infra/delivery-recovery.shared.js";
import { prepareDeferredDeliveryAdmission } from "../../infra/outbound/deferred-delivery-admission.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../../infra/outbound/delivery-queue-media-staging.js";
import { recoverPendingDeliveries } from "../../infra/outbound/delivery-queue-recovery.js";
import { loadUnfinishedDelivery } from "../../infra/outbound/delivery-queue-storage.js";
import { hasActiveDeliveryOwner } from "../../infra/outbound/delivery-queue-types.js";
import {
  createRecoveryLog,
  loadPendingDeliveries,
} from "../../infra/outbound/delivery-queue.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createDeferredJsonResponse, createDiscordHttpFixture } from "./send.test-helpers.js";
import type { GatewayRequestContext, GatewayRequestHandler, RespondFn } from "./types.js";

const channelId = "100000000000000002";
const guildId = "100000000000000001";
const message = { id: "100000000000000003", channel_id: channelId };
let discordPlugin: ChannelPlugin;
let sendHandler: GatewayRequestHandler;

beforeAll(async () => {
  const { sendHandlers } = await import("./send.js");
  sendHandler = expectDefined(sendHandlers.send, "registered Gateway send handler");
  ({ discordPlugin } = await loadBundledPluginFacade<{ discordPlugin: ChannelPlugin }>({
    pluginId: "discord",
    artifactBasename: "api.js",
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetPluginRuntimeStateForTest();
});

async function createFixture(state: OpenClawTestState) {
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace: state.workspaceDir } },
    channels: {
      discord: {
        enabled: true,
        token: "synthetic-provider-fixture",
        groupPolicy: "allowlist",
        guilds: { [guildId]: { channels: { [channelId]: { enabled: true } } } },
      },
    },
  };
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg, cfg);
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "discord", source: "test", plugin: discordPlugin }]),
  );
  const post = vi.fn<(init?: RequestInit) => Promise<Response>>(async () => Response.json(message));
  const { httpRequests, unexpectedRequests } = createDiscordHttpFixture({
    channelId,
    guildId,
    handle: async ({ method, path, init }) =>
      method === "POST" && path === `/api/v10/channels/${channelId}/messages`
        ? post(init)
        : undefined,
  });
  const caller = new AbortController();
  const respond = vi.fn<RespondFn>();
  const context = {
    getRuntimeConfig: () => cfg,
    dedupe: new Map(),
  } as GatewayRequestContext;
  return {
    cfg,
    post,
    httpRequests,
    unexpectedRequests,
    caller,
    respond,
    send: async () =>
      await sendHandler({
        req: { type: "req", id: "discord-caller", method: "send" },
        params: {
          channel: "discord",
          to: `channel:${channelId}`,
          message: "caller lifetime probe",
          sessionKey: `agent:main:discord:channel:${channelId}`,
          idempotencyKey: "discord-caller-lifetime",
        },
        context,
        client: null,
        isWebchatConnect: () => false,
        respond,
        sessionMutationCommitGuard: () => caller.signal.throwIfAborted(),
      }),
  };
}

describe("Gateway send through Discord's default request scheduler", () => {
  it.each(["active", "retired"] as const)(
    "preserves the %s caller across Discord 429 backoff and reopened-state recovery without replay",
    async (state) => {
      // Keep the scheduler's deadline closed until the caller transition is observed.
      vi.useFakeTimers({ toFake: ["Date"] });
      await withOpenClawTestState(
        { prefix: "discord-send-retry-", env: { DISCORD_API_URL: undefined } },
        async (testState) => {
          const fixture = await createFixture(testState);
          const firstPost = createDeferred();
          fixture.post.mockImplementationOnce(async () => {
            firstPost.resolve();
            return Response.json(
              { message: "rate limited", retry_after: 0.1 },
              { status: 429, headers: { "retry-after": "0.1" } },
            );
          });
          const terminalOutcomes: string[] = [];
          const unsubscribe = onTrustedMessageAuditEvent((event) => {
            if (event.action === "message.outbound.finished") {
              terminalOutcomes.push(event.outcome);
            }
          });
          const request = fixture.send();
          try {
            await Promise.race([firstPost.promise, request]);
            // Response parsing and scheduler requeueing finish before this event-loop turn.
            await setImmediate();
            expect(fixture.respond).not.toHaveBeenCalled();
            expect(fixture.post).toHaveBeenCalledOnce();
            const admitted = await loadPendingDeliveries(testState.stateDir);
            expect(admitted).toMatchObject([{ channel: "discord" }]);
            const intent = expectDefined(admitted[0], "durable Discord send intent");
            if (state === "retired") {
              fixture.caller.abort(new Error("message caller retired during backoff"));
            }
            vi.setSystemTime(Date.now() + 200);
            await request;
            expect(fixture.post).toHaveBeenCalledTimes(state === "active" ? 2 : 1);
            expect(fixture.respond).toHaveBeenCalledOnce();
            expect(fixture.respond.mock.calls[0]?.[0]).toBe(state === "active");
            closeOpenClawStateDatabaseForTest();
            if (state === "active") {
              expect(fixture.respond.mock.calls[0]?.[1]).toMatchObject({ messageId: message.id });
              expect(await loadUnfinishedDelivery(intent.id, testState.stateDir)).toBeNull();
            } else {
              const unfinished = await loadUnfinishedDelivery(intent.id, testState.stateDir);
              if (unfinished) {
                // Advance past the stored lease, then honor any remaining normal retry backoff.
                vi.setSystemTime(Math.max(Date.now(), unfinished.availableAt ?? 0) + 1);
                const eligibility = isDeliveryRecoveryRetryEligible(unfinished, Date.now());
                if (!eligibility.eligible) {
                  vi.setSystemTime(Date.now() + eligibility.remainingBackoffMs + 1);
                }
                expect(hasActiveDeliveryOwner(unfinished, Date.now())).toBe(false);
                expect(isDeliveryRecoveryRetryEligible(unfinished, Date.now())).toEqual({
                  eligible: true,
                });
                const resolveAdmission = await prepareDeferredDeliveryAdmission(
                  {
                    cfg: fixture.cfg,
                    channel: unfinished.channel,
                    to: unfinished.to,
                    accountId: unfinished.accountId,
                    phase: "recovery",
                  },
                  { agentId: unfinished.session?.agentId },
                );
                expect(resolveAdmission()).toMatchObject({ status: "allowed" });
              }
              const beforeRecovery = fixture.httpRequests.length;
              const recovery = await recoverPendingDeliveries({
                cfg: fixture.cfg,
                stateDir: testState.stateDir,
                log: createRecoveryLog(),
                deliver: deliverOutboundPayloads,
              });
              expect(recovery).toMatchObject({ deferredBackoff: 0, skippedMaxRetries: 0 });
              if (unfinished && !unfinished.settlement) {
                expect(recovery.recovered + recovery.failed).toBe(1);
              }
              closeOpenClawStateDatabaseForTest();
              expect(await loadUnfinishedDelivery(intent.id, testState.stateDir)).toBeNull();
              const finalStatus = getDeliveryQueueEntryStatus(
                OUTBOUND_DELIVERY_QUEUE_NAME,
                intent.id,
                testState.stateDir,
              );
              // Unknown custody can compact to a failed record or prune its volatile row.
              expect([undefined, "failed"]).toContain(finalStatus);
              expect(terminalOutcomes).toHaveLength(1);
              expect(terminalOutcomes).not.toContain("sent");
              // Recovery may read provider state; it must not create another message.
              expect(
                fixture.httpRequests
                  .slice(beforeRecovery)
                  .filter(({ method }) => method !== "GET" && method !== "HEAD"),
              ).toEqual([]);
              expect(fixture.post).toHaveBeenCalledOnce();
            }
            expect(fixture.unexpectedRequests).toEqual([]);
          } finally {
            unsubscribe();
            vi.useRealTimers();
            await request;
          }
        },
      );
    },
  );

  it("settles an accepted Discord response after the Gateway caller retires", async () =>
    await withOpenClawTestState(
      { prefix: "discord-send-settlement-", env: { DISCORD_API_URL: undefined } },
      async (testState) => {
        const fixture = await createFixture(testState);
        const deferred = createDeferredJsonResponse(message);
        fixture.post.mockImplementationOnce(deferred.respond);
        const request = fixture.send();
        try {
          await Promise.race([deferred.accepted.promise, request]);
          await setImmediate();
          expect(fixture.respond).not.toHaveBeenCalled();
          fixture.caller.abort(new Error("message caller retired after provider acceptance"));
          expect(fixture.post.mock.calls[0]?.[0]?.signal?.aborted).toBe(false);
          deferred.release.resolve();
          await request;
          expect(fixture.post).toHaveBeenCalledOnce();
          expect(fixture.respond).toHaveBeenCalledOnce();
          expect(fixture.respond.mock.calls[0]?.[0]).toBe(true);
          expect(fixture.respond.mock.calls[0]?.[1]).toMatchObject({ messageId: message.id });
          expect(fixture.unexpectedRequests).toEqual([]);
        } finally {
          deferred.release.resolve();
          await request;
        }
      },
    ));
});
