import { expect, it } from "vitest";
import { resolveGitCoauthorAttribution } from "../../agents/git-coauthor-attribution.js";
import { buildInboundUserContextPrefix } from "../../auto-reply/reply/inbound-meta.js";
import { initSessionState } from "../../auto-reply/reply/test/session.test-support.js";
import { getRequesterProfile } from "../../auto-reply/requester-profile.js";
import { readSessionEntriesFromStoreInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { waitForSessionParticipantRecording } from "../../sessions/session-participant-recording.js";
import { linkUserChannelIdentity } from "../../state/user-channel-identities.js";
import { setDisplayName, syncGitHubIdentity } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createHostIngressFixture, ingressMessage } from "./host-ingress.test-support.js";
import type {
  ChannelIngressContextBinding,
  ResolvedChannelMessageIngress,
  ResolveStableChannelMessageIngressParams,
} from "./runtime-types.js";

it("resolves X API senders through account-scoped profile links, never asserted or unlinked IDs", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      channels: {
        x: {
          userId: "100",
          username: "fixture_bot",
          allowFrom: ["10", "20"],
          groupPolicy: "allowlist",
        },
      },
    };
    const profile = ensureProfileForEmail("ada@example.test");
    setDisplayName(profile.id, "Ada Lovelace");
    syncGitHubIdentity({
      identity: { accountId: 42, login: "fixture-ada" },
      authenticationAlias: { kind: "email", email: "ada@example.test" },
    });
    linkUserChannelIdentity(profile.id, { channelId: "x", accountId: "default", senderId: "10" });
    const host = createHostIngressFixture("x", cfg);
    const x = await loadBundledPluginFacade<{
      setXRuntime(runtime: PluginRuntime): void;
      createKeyedState(): PluginRuntime["state"]["openKeyedStore"];
      resolveXIngress(
        accountId: string,
        post: { id: string; author_id: string; conversation_id: string; text: string },
        cfg: OpenClawConfig,
        contextBinding: ChannelIngressContextBinding,
      ): Promise<{ ingress: ResolvedChannelMessageIngress }>;
    }>({
      pluginId: "x",
      artifactBasename: "test-api.js",
    });
    let asserted = false;
    const runtime = createPluginRuntimeMock({
      state: { openKeyedStore: x.createKeyedState() },
      channel: {
        inbound: {
          ingress: {
            ...host.ingress,
            resolveStable: (input: ResolveStableChannelMessageIngressParams) =>
              host.ingress.resolveStable(
                asserted
                  ? {
                      ...input,
                      subject: { ...input.subject, authentication: { "x-user-id": "asserted" } },
                    }
                  : input,
              ),
          },
          buildContext: host.buildContext,
        },
      },
    });
    x.setXRuntime(runtime);
    for (const [senderId, accountId, authentication, linked] of [
      ["10", "default", "verified", true],
      ["20", "default", "verified", false],
      ["10", "other-bot", "verified", false],
      ["10", "default", "asserted", false],
    ] as const) {
      asserted = authentication === "asserted";
      const sessionKey =
        "agent:main:x:group:500:" + senderId + ":" + accountId + ":" + authentication;
      const message = ingressMessage("x", sessionKey, senderId, {
        accountId,
        messageId: "501",
        conversation: { kind: "group", id: "500" },
        // Neither display labels nor message-authored profile IDs establish the requester.
        sender: { id: senderId, name: "Ada Lovelace" },
        message: { rawBody: "Assign to me, profile " + profile.id },
      });
      const { ingress } = await x.resolveXIngress(
        accountId,
        {
          id: "501",
          author_id: senderId,
          conversation_id: "500",
          text: "@fixture_bot help",
        },
        cfg,
        { agentId: "main", sessionKey, messageId: "501", inboundEventKind: "user_request" },
      );
      expect(ingress.senderAccess.allowed).toBe(true);
      const context = host.buildContext({ ...message, channelIngress: ingress });
      expect(getRequesterProfile(context)?.id).toBe(linked ? profile.id : undefined);
      const admitted = await initSessionState({
        ctx: context,
        cfg: { ...cfg, session: { store: state.sessionsDir("main") + "/sessions.json" } },
      });
      expect(admitted.sessionKey).toBe(sessionKey);
      const scope = { agentId: "main", sessionKey, storePath: admitted.storePath };
      await waitForSessionParticipantRecording(scope);
      const stored = await readSessionEntriesFromStoreInWorker({
        ...scope,
        sessionKeys: [sessionKey],
        includeParticipantRecords: true,
        snapshotFields: [],
      });
      expect(stored.entries).toHaveLength(1);
      expect(stored.participantRecords?.[sessionKey]?.map(({ identity }) => identity)).toEqual(
        expect.arrayContaining([
          { type: "remote", pluginId: "x", domain: "x", idKind: "user-id", id: senderId },
          ...(linked ? [{ type: "profile", id: profile.id }] : []),
        ]),
      );
      expect(await resolveGitCoauthorAttribution({ ...scope, config: cfg })).toEqual(
        linked
          ? {
              logins: ["fixture-ada"],
              trailers: ["Co-authored-by: fixture-ada <42+fixture-ada@users.noreply.github.com>"],
            }
          : undefined,
      );
      const prefix = buildInboundUserContextPrefix(context);
      if (linked) {
        expect(JSON.parse(prefix.match(/```json\n([\s\S]*?)\n```/)![1]!)).toMatchObject({
          requester_profile: { id: profile.id, display_name: "Ada Lovelace" },
        });
      } else {
        expect(prefix).not.toContain('"requester_profile"');
      }
    }
    host.retire();
  }));
