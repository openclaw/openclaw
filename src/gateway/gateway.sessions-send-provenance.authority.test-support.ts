import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { getCommandOwnerAuthority } from "../auto-reply/command-owner-authority.js";
import { getRequesterProfile } from "../auto-reply/requester-profile.js";
import { buildChannelInboundEventContext } from "../channels/inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../channels/inbound-event/host-context-builder.js";
import { createHostChannelIngressRuntime } from "../channels/message-access/runtime.js";
import { getRuntimeConfig } from "../config/config.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { loadUnfinishedDeliveries } from "../infra/outbound/delivery-queue-storage.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import {
  createScenario,
  dispatchProofHuman,
  gateway,
  gatewayContext,
  humanReplies,
  outbound,
  patchProofConfig,
  providerErrors,
  waitForProofRun,
} from "./gateway.sessions-send-provenance.test-support.js";
import { holdProofSend } from "./gateway.sessions-send-provenance.transport.test-support.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";

/** The channel authenticates the subject; canonical links supply its live human authority. */
export async function verifyLinkedPrincipalDelivery(signal: AbortSignal) {
  const originalRoles = getRuntimeConfig().gateway?.roles;
  const alice = await ensureCanonicalUserProfileForEmail("linked-alice@provenance.example.test");
  const bob = await ensureCanonicalUserProfileForEmail("linked-bob@provenance.example.test");
  const identity = { channelId: "telegram", accountId: "default", senderId: "linked-human" };
  const refusedRecipients: string[] = [];
  let linkedProfileId: string | undefined;
  let live = true;
  const owner = {
    channelId: identity.channelId,
    isLive: () => live,
    resolveGatewayContext: gatewayContext.resolveGatewayContext,
  };
  const ingress = createHostChannelIngressRuntime(owner);
  const buildContext = createHostChannelInboundEventContextBuilder(
    buildChannelInboundEventContext,
    owner,
  );
  const link = async (profileId: string) => {
    await gateway.client.request("users.linkChannelIdentity", { profileId, identity });
    linkedProfileId = profileId;
  };
  const unlink = async () => {
    await gateway.client.request("users.unlinkChannelIdentity", {
      profileId: linkedProfileId,
      identity,
    });
    linkedProfileId = undefined;
  };
  await runQaGatewayFixture(
    async () => {
      await patchProofConfig({
        gateway: {
          roles: {
            default: "member",
            definitions: {
              admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
              member: {
                scopes: ["operator.read", "operator.write"],
                agents: "*",
                sessions: { others: "view" },
              },
            },
          },
        },
      });
      // Role publication invalidates the old connection after the config RPC responds.
      await disconnectGatewayClient(gateway.client);
      gateway.client = await connectGatewayClient({
        url: `ws://127.0.0.1:${gateway.port}`,
        token: process.env.OPENCLAW_GATEWAY_TOKEN,
        scopes: ["operator.admin", "operator.read", "operator.write"],
        signal,
      });
      for (const profile of [alice, bob]) {
        await gateway.client.request("users.setRole", { profileId: profile.id, role: "admin" });
      }
      for (const action of ["unlink", "reassign", "current"] as const) {
        if (action !== "current") {
          await link(alice.id);
        }
        const profile = action === "current" ? bob : alice;
        const id = `linked-${action}`;
        const sourceKey = `agent:main:telegram:direct:provenance-source-${id}`;
        const scenario = createScenario(
          {
            name: `linked principal ${action} during final send preparation`,
            id,
            sender: identity.senderId,
            agent: "main",
            denied: action !== "current",
            targetKey: `agent:deployment:telegram:direct:provenance-target-${id}`,
          },
          sourceKey,
        );
        using hold = holdProofSend(scenario.recipient);
        const messageId = randomUUID();
        const channelIngress = await ingress.resolveStable({
          channelId: identity.channelId,
          accountId: identity.accountId,
          identity: { authentication: "verified" },
          subject: { stableId: identity.senderId },
          conversation: { kind: "direct", id: scenario.sourceRecipient },
          contextBinding: {
            agentId: "main",
            sessionKey: sourceKey,
            messageId,
            inboundEventKind: "user_request",
          },
          dmPolicy: "open",
          groupPolicy: "disabled",
          allowFrom: ["*"],
          useDefaultPairingStore: false,
        });
        const ctx = await buildContext({
          channel: identity.channelId,
          accountId: identity.accountId,
          messageId,
          from: `telegram:${identity.senderId}`,
          sender: { id: identity.senderId },
          conversation: { kind: "direct", id: scenario.sourceRecipient },
          route: { agentId: "main", routeSessionKey: sourceKey },
          reply: { to: scenario.sourceRecipient },
          message: { rawBody: scenario.sourcePrompt },
          channelIngress,
        });
        expect(getRequesterProfile(ctx)?.id).toBe(profile.id);
        expect(getCommandOwnerAuthority(ctx)?.operatorAuthority?.profileId).toBe(profile.id);
        expect(getCommandOwnerAuthority(ctx)?.isCurrent()).toBe(true);
        await gateway.client.request("sessions.create", {
          agentId: "deployment",
          key: scenario.targetKey,
        });
        const firstReply = humanReplies.length;
        let completion: ReturnType<typeof waitForProofRun> | undefined;
        try {
          await dispatchProofHuman(ctx, identity.senderId, "followup", signal);
          scenario.sourceCompleted = true;
          expect(
            humanReplies.slice(firstReply),
            JSON.stringify({
              providerErrors,
              requests: scenario.sourceRequests.length,
            }),
          ).toContainEqual({
            sender: identity.senderId,
            text: `SOURCE_COMPLETE_${id}`,
          });
          expect(scenario.accepted).toMatchObject({
            status: "accepted",
            runId: expect.any(String),
          });
          completion = waitForProofRun(scenario.accepted?.runId);
          scenario.releaseTarget.resolve();
          await withinTest(
            awaitGateBeforeSettlement(
              hold.entered.promise,
              completion,
              `${id}: delegate settled before send preparation`,
            ),
            signal,
          );
          expect(scenario.targetRequests[0]?.tools).toContain("message");
          expect(outbound.filter((item) => item.to === scenario.recipient)).toEqual([]);
          if (action !== "current") {
            await unlink();
            if (action === "reassign") {
              await link(bob.id);
            }
          }
          expect(getCommandOwnerAuthority(ctx)?.isCurrent()).toBe(action === "current");
          // The plugin only waits. Production's post-await authority check owns refusal.
          hold.release.resolve();
          const terminal = await withinTest(completion, signal);
          expect(terminal, JSON.stringify(terminal)).toMatchObject({
            status: action === "current" ? "ok" : "error",
          });
          if (action !== "current") {
            expect(terminal.error).toContain("Channel operator authority changed");
            refusedRecipients.push(scenario.recipient);
          }
          await waitForGatewayActiveWork(30_000);
          expect(
            [...gatewayContext.chatQueuedTurns.values()].some(
              (entry) => entry.sessionKey === scenario.targetKey,
            ),
          ).toBe(false);
          expect(
            (await loadUnfinishedDeliveries()).filter((entry) => entry.to === scenario.recipient),
          ).toEqual([]);
          expect(
            outbound.filter((item) => item.to === scenario.recipient),
            id,
          ).toEqual(
            action === "current"
              ? [{ to: scenario.recipient, text: scenario.marker, accountId: "default" }]
              : [],
          );
          expect(scenario.effectAfterSourceCompletion).toEqual(action === "current" ? [true] : []);
          expect(providerErrors).toEqual([]);
        } finally {
          scenario.releaseTarget.resolve();
          hold.release.resolve();
          await completion?.catch(() => undefined);
        }
      }
      // Fresh admission under the new person cannot revive either old send or its retry row.
      expect(outbound.filter((entry) => refusedRecipients.includes(entry.to))).toEqual([]);
      expect(
        (await loadUnfinishedDeliveries()).filter((entry) => refusedRecipients.includes(entry.to)),
      ).toEqual([]);
    },
    async () => {
      live = false;
      if (linkedProfileId) {
        await unlink();
      }
    },
    () =>
      patchProofConfig({ gateway: { roles: originalRoles ?? null } }, [
        "gateway.roles",
        "gateway.roles.definitions.admin.scopes",
        "gateway.roles.definitions.member.scopes",
      ]),
  );
}
