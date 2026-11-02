import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import {
  CommandOwnerRevokedError,
  getCommandOwnerAuthority,
} from "../auto-reply/command-owner-authority.js";
import { getRequesterProfile } from "../auto-reply/requester-profile.js";
import { buildChannelInboundEventContext } from "../channels/inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../channels/inbound-event/host-context-builder.js";
import { createHostChannelIngressRuntime } from "../channels/message-access/runtime.js";
import { getRuntimeConfig } from "../config/config.js";
import { loadUnfinishedDeliveries } from "../infra/outbound/delivery-queue-storage.js";
import {
  getRpcSourceIdentity,
  isRpcSourceQueued,
  listRpcSourceEntries,
} from "../sessions/session-controller.rpc-sources.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import {
  createScenario,
  dispatchProofHuman,
  expectProofIdle,
  gateway,
  gatewayContext,
  humanReplies,
  outbound,
  patchProofConfig,
  proofDeliveries,
  providerErrors,
  requesterCase,
  waitForProofGate,
  waitForProofRun,
} from "./gateway.sessions-send-provenance.test-support.js";
import { holdProofSend } from "./gateway.sessions-send-provenance.transport.test-support.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";

/** The channel authenticates the subject; canonical links supply its live human authority. */
export async function verifyLinkedPrincipalDelivery(signal: AbortSignal) {
  const originalRoles = getRuntimeConfig().gateway?.roles;
  const scopes = ["operator.read", "operator.write"];
  const definitions = {
    admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
    member: { scopes, agents: "*", sessions: { others: "view" } },
  };
  const alice = await ensureCanonicalUserProfileForEmail("linked-alice@provenance.example.test");
  const bob = await ensureCanonicalUserProfileForEmail("linked-bob@provenance.example.test");
  const identity = { channelId: "telegram", accountId: "default", senderId: "linked-human" };
  const { channelId, accountId, senderId } = identity;
  const refusedRecipients: string[] = [];
  let linkedProfileId: string | undefined;
  let live = true;
  const owner = {
    channelId,
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
      await patchProofConfig({ gateway: { roles: { default: "member", definitions } } });
      // Role publication invalidates the old connection after the config RPC responds.
      await disconnectGatewayClient(gateway.client);
      gateway.client = await connectGatewayClient({
        url: `ws://127.0.0.1:${gateway.port}`,
        token: process.env.OPENCLAW_GATEWAY_TOKEN,
        scopes: ["operator.admin", ...scopes],
        signal,
      });
      for (const profile of [alice, bob]) {
        await gateway.client.request("users.setRole", { profileId: profile.id, role: "admin" });
      }
      for (const action of ["unlink", "reassign", "current"] as const) {
        const current = action === "current";
        if (!current) {
          await link(alice.id);
        }
        const profile = current ? bob : alice;
        const id = `linked-${action}`;
        const sourceKey = `agent:main:telegram:direct:provenance-source-${id}`;
        const scenario = createScenario(
          requesterCase(id, `linked principal ${action} during final send preparation`, {
            sender: senderId,
            denied: !current,
            targetKey: `agent:deployment:telegram:direct:provenance-target-${id}`,
          }),
          sourceKey,
        );
        const { recipient, sourceRecipient, targetKey } = scenario;
        using hold = holdProofSend(recipient);
        const messageId = randomUUID();
        const channelIngress = await ingress.resolveStable({
          channelId,
          accountId,
          identity: { authentication: "verified" },
          subject: { stableId: senderId },
          conversation: { kind: "direct", id: sourceRecipient },
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
          channel: channelId,
          accountId,
          messageId,
          from: `telegram:${senderId}`,
          sender: { id: senderId },
          conversation: { kind: "direct", id: sourceRecipient },
          route: { agentId: "main", routeSessionKey: sourceKey },
          reply: { to: sourceRecipient },
          message: { rawBody: scenario.sourcePrompt },
          channelIngress,
        });
        expect(getRequesterProfile(ctx)?.id).toBe(profile.id);
        const authority = getCommandOwnerAuthority(ctx);
        const revocationSignal = authority?.operatorAuthority?.signal;
        expect(authority?.operatorAuthority?.profileId).toBe(profile.id);
        expect(authority?.isCurrent()).toBe(true);
        expect(revocationSignal).toBeDefined();
        expect(revocationSignal?.aborted).toBe(false);
        await gateway.client.request("sessions.create", { agentId: "deployment", key: targetKey });
        const firstReply = humanReplies.length;
        let completion: ReturnType<typeof waitForProofRun> | undefined;
        try {
          await dispatchProofHuman(ctx, senderId, "followup", signal);
          scenario.sourceCompleted = true;
          expect(
            humanReplies.slice(firstReply),
            JSON.stringify({ providerErrors, requests: scenario.sourceRequests.length }),
          ).toContainEqual({
            sender: senderId,
            text: `SOURCE_COMPLETE_${id}`,
          });
          expect(scenario.accepted).toMatchObject({
            status: "accepted",
            runId: expect.any(String),
          });
          completion = waitForProofRun(scenario.accepted?.runId);
          scenario.releaseTarget.resolve();
          await waitForProofGate(
            hold.entered.promise,
            completion,
            signal,
            `${id}: delegate settled before send preparation`,
          );
          expect(scenario.targetRequests[0]?.tools).toContain("message");
          expect(proofDeliveries(recipient)).toEqual([]);
          if (!current) {
            await unlink();
            if (action === "reassign") {
              await link(bob.id);
            }
          }
          expect(revocationSignal?.aborted).toBe(!current);
          if (!current) {
            expect(revocationSignal?.reason).toBeInstanceOf(CommandOwnerRevokedError);
            expect(revocationSignal?.reason).toMatchObject({
              message: "Channel operator authority changed; send a new request.",
            });
          }
          expect(authority?.isCurrent()).toBe(current);
          // Retained authority cancels the target; the effect boundary also refuses
          // revoked sends after plugin preparation. The plugin only waits.
          hold.release.resolve();
          const terminal = await withinTest(completion, signal);
          expect(terminal, JSON.stringify(terminal)).toMatchObject(
            current ? { status: "ok" } : { status: "error", stopReason: "rpc" },
          );
          if (!current) {
            refusedRecipients.push(recipient);
          }
          await expectProofIdle();
          expect(
            listRpcSourceEntries().some(
              ([, source]) =>
                getRpcSourceIdentity(source).sessionKey === targetKey && isRpcSourceQueued(source),
            ),
          ).toBe(false);
          expect(
            (await loadUnfinishedDeliveries()).filter((entry) => entry.to === recipient),
          ).toEqual([]);
          expect(proofDeliveries(recipient), id).toEqual(
            current ? [{ to: recipient, text: scenario.marker, accountId: "default" }] : [],
          );
          expect(scenario.effectAfterSourceCompletion).toEqual(current ? [true] : []);
        } finally {
          scenario.releaseTarget.resolve();
          hold.release.resolve();
          await completion?.catch(() => undefined);
        }
      }
      // Fresh admission under the new person cannot revive either old send or its retry row.
      expect([
        outbound.filter((entry) => refusedRecipients.includes(entry.to)),
        (await loadUnfinishedDeliveries()).filter((entry) => refusedRecipients.includes(entry.to)),
      ]).toEqual([[], []]);
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
