import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { getRequesterProfile } from "../auto-reply/requester-profile.js";
import { buildChannelInboundEventContext } from "../channels/inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../channels/inbound-event/host-context-builder.js";
import { createHostChannelIngressRuntime } from "../channels/message-access/runtime.js";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import {
  dispatchProofHuman,
  expectProofIdle,
  gateway,
  gatewayContext,
  humanReplies,
  patchProofConfig,
  registerProofModelScript,
} from "./gateway.sessions-send-provenance.test-support.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";

// Real Gateway, channel admission, profile/link owners, agent turn, SQLite and
// chat.history. Only external channel I/O and model responses are synthetic.
// No profile IDs, requester origins, or projected avatar fields are seeded.
it(
  "presents an attested channel author without changing its stored observation",
  { timeout: 90_000 },
  async ({ signal }) => {
    // Match the existing native linked-principal fixture: publish the role
    // definitions before assigning a role, then reconnect under that policy.
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
    await disconnectGatewayClient(gateway.client);
    gateway.client = await connectGatewayClient({
      url: `ws://127.0.0.1:${gateway.port}`,
      token: process.env.OPENCLAW_GATEWAY_TOKEN,
      scopes: ["operator.admin", "operator.read", "operator.write"],
      signal,
    });
    const profile = await ensureCanonicalUserProfileForEmail(
      "linked-display@presentation.example.test",
    );
    const identity = {
      channelId: "telegram",
      accountId: "default",
      senderId: "linked-display-human",
    };
    const sessionKey = "agent:main:telegram:direct:linked-display";
    const messageId = randomUUID();
    const prompt = "PROVENANCE_SOURCE_LINKED_DISPLAY_REQUEST: confirm this message.";
    let modelRequests = 0;
    registerProofModelScript("LINKED_DISPLAY_REQUEST", () => {
      modelRequests += 1;
      return { text: "LINKED_DISPLAY_COMPLETE" };
    });
    await gateway.client.request("users.setRole", { profileId: profile.id, role: "admin" });
    await gateway.client.request("users.linkChannelIdentity", {
      profileId: profile.id,
      identity,
    });
    expect(
      await gateway.client.request("users.listChannelIdentities", { profileId: profile.id }),
    ).toMatchObject({ links: [{ profileId: profile.id, identity }] });

    let linkedProfileId = profile.id;
    let live = true;
    const owner = {
      channelId: identity.channelId,
      isLive: () => live,
      resolveGatewayContext: gatewayContext.resolveGatewayContext,
    };
    try {
      const ingress = await createHostChannelIngressRuntime(owner).resolveStable({
        channelId: identity.channelId,
        accountId: identity.accountId,
        identity: { authentication: "verified" },
        subject: { stableId: identity.senderId },
        conversation: { kind: "direct", id: identity.senderId },
        contextBinding: {
          agentId: "main",
          sessionKey,
          messageId,
          inboundEventKind: "user_request",
        },
        dmPolicy: "open",
        groupPolicy: "disabled",
        allowFrom: ["*"],
        useDefaultPairingStore: false,
      });
      const context = await createHostChannelInboundEventContextBuilder(
        buildChannelInboundEventContext,
        owner,
      )({
        channel: identity.channelId,
        accountId: identity.accountId,
        messageId,
        from: `telegram:${identity.senderId}`,
        sender: { id: identity.senderId, name: "Linked sender", isBot: false },
        conversation: { kind: "direct", id: identity.senderId },
        route: { agentId: "main", routeSessionKey: sessionKey },
        reply: { to: identity.senderId },
        message: { rawBody: prompt },
        channelIngress: ingress,
      });
      expect(getRequesterProfile(context)?.id).toBe(profile.id);
      await dispatchProofHuman(context, identity.senderId, "followup", signal);
      await expectProofIdle();
      expect(modelRequests).toBeGreaterThan(0);
      expect(humanReplies).toContainEqual({
        sender: identity.senderId,
        text: "LINKED_DISPLAY_COMPLETE",
      });

      const firstHistory = await gateway.client.request<{ sessionId: string }>("chat.history", {
        sessionKey,
        limit: 20,
      });
      expect(firstHistory.sessionId).toEqual(expect.any(String));
      const readRaw = () =>
        loadTranscriptEvents({
          agentId: "main",
          sessionKey,
          sessionId: firstHistory.sessionId,
          storePath: resolveDefaultSessionStorePath("main"),
        });
      const rawBefore = await readRaw();
      const rawUser = rawBefore
        .map((event) => asOptionalRecord(asOptionalRecord(event)?.message))
        .find((message) => message?.role === "user");
      const expectedIdentity = {
        type: "observation",
        id: identity.senderId,
        pluginId: identity.channelId,
        accountId: identity.accountId,
        senderKind: "human",
      };
      expect(rawUser?.["__openclaw"]).toMatchObject({
        senderIdentity: expectedIdentity,
        requesterOrigin: { operatorProfileId: profile.id },
      });
      const history = await gateway.client.request<{ messages: unknown[] }>("chat.history", {
        sessionKey,
        limit: 20,
      });
      const displayed = history.messages
        .map(asOptionalRecord)
        .find((message) => message?.role === "user");
      const metadata = asOptionalRecord(displayed?.["__openclaw"]);
      expect(metadata?.senderIdentity).toEqual(expectedIdentity);
      expect(metadata).not.toHaveProperty("requesterOrigin");
      expect(metadata?.transport).toMatchObject({ channel: "telegram" });
      expect(await readRaw()).toEqual(rawBefore);
      expect(metadata?.senderProfileAvatarUrl).toEqual(
        expect.stringContaining(`/api/users/${profile.id}/avatar`),
      );
      expect(metadata?.senderDisplayProfileId).toBe(profile.id);
      await gateway.client.request("users.unlinkChannelIdentity", {
        profileId: profile.id,
        identity,
      });
      const other = await ensureCanonicalUserProfileForEmail("other@presentation.example.test");
      for (const reassigned of [false, true]) {
        if (reassigned) {
          await gateway.client.request("users.linkChannelIdentity", {
            profileId: other.id,
            identity,
          });
          linkedProfileId = other.id;
        }
        const refreshed = await gateway.client.request<{ messages: unknown[] }>("chat.history", {
          sessionKey,
          limit: 20,
        });
        const oldAuthor = refreshed.messages
          .map(asOptionalRecord)
          .find((message) => message?.role === "user");
        const oldMetadata = asOptionalRecord(oldAuthor?.["__openclaw"]);
        expect(oldMetadata?.senderIdentity).toEqual(expectedIdentity);
        expect(oldMetadata).not.toHaveProperty("senderDisplayProfileId");
        expect(oldMetadata).not.toHaveProperty("senderProfileAvatarUrl");
      }
      expect(await readRaw()).toEqual(rawBefore);
    } finally {
      live = false;
      await gateway.client.request("users.unlinkChannelIdentity", {
        profileId: linkedProfileId,
        identity,
      });
    }
  },
);
