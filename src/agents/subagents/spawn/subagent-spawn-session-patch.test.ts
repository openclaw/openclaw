import path from "node:path";
import { expect, it } from "vitest";
import { buildChannelInboundEventContext } from "../../../channels/inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../../../channels/inbound-event/host-context-builder.js";
import { createHostChannelIngressRuntime } from "../../../channels/message-access/runtime.js";
import {
  loadSessionEntry,
  recordSessionParticipant,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { recordAcceptedSessionParticipantInput } from "../../../sessions/session-participant-input-recording.js";
import { recordSessionParticipantBestEffort } from "../../../sessions/session-participant-recording.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import { ensureProfileForEmail, syncGitHubIdentity } from "../../../state/user-profiles.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { resolveGitCoauthorAttribution } from "../../git-coauthor-attribution.js";
import { createInitialSubagentSession } from "./subagent-spawn-session-patch.js";

it("inherits accepted human credit when participant persistence is still queued", async () => {
  await withOpenClawTestState({ label: "spawn-pending-participant" }, async (state) => {
    const agentId = "main";
    const sessionKey = "agent:main:parent";
    const childSessionKey = "agent:main:subagent:child";
    const storePath = resolveOpenClawAgentSqlitePath({ agentId });
    const scope = { agentId, sessionKey, storePath };
    await upsertSessionEntryCore(scope, { sessionId: "parent-id", updatedAt: 1 });
    const releaseWriter = createDeferredCore();
    const writerStarted = createDeferredCore();
    const heldWriter = runOpenClawAgentWriteAdmission({ agentId, path: storePath }, async () => {
      writerStarted.resolve();
      await releaseWriter.promise;
    });
    await writerStarted.promise;
    const work = new AsyncWorkScope();
    const errors: unknown[] = [];
    try {
      work.run(() =>
        recordSessionParticipantBestEffort({
          ...scope,
          storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
          identity: { type: "profile", id: "human-requester" },
          promptedAt: 1,
          onError: (error) => errors.push(error),
        }),
      );
      // The real recorder defers its write to the next microtask. Keep that original order.
      await Promise.resolve();
      expect(loadSessionEntry(scope)?.participants ?? []).toEqual([]);
      const creation = createInitialSubagentSession({
        cfg: {},
        targetAgentId: agentId,
        childSessionKey,
        incognito: false,
        requesterInternalKey: sessionKey,
        creationPolicy: { actor: { type: "agent", id: agentId } },
        completionOwnerSessionKey: sessionKey,
        modelPatch: {},
        collect: false,
      });
      releaseWriter.resolve();
      await heldWriter;
      expect(await creation).toMatchObject({ status: "ok" });
      await work.drain();

      expect(errors).toEqual([]);
      expect(loadSessionEntry(scope)?.participants).toEqual([
        { identity: { type: "profile", id: "human-requester" } },
      ]);
      const child = loadSessionEntry({ ...scope, sessionKey: childSessionKey });
      expect(child?.inheritedGitContributorProfileIds).toEqual(["human-requester"]);
      expect(child?.participants ?? []).toEqual([]);
    } finally {
      releaseWriter.resolve();
      await heldWriter;
      await work.drain();
    }
  });
});

it("does not copy unrelated main-session contributors into a channel task", async () => {
  await withOpenClawTestState({ label: "spawn-shared-main-credit" }, async () => {
    const agentId = "main";
    const sessionKey = "agent:main:main";
    const childSessionKey = "agent:main:subagent:channel-task";
    const storePath = resolveOpenClawAgentSqlitePath({ agentId });
    const scope = { agentId, sessionKey, storePath };
    await upsertSessionEntryCore(scope, { sessionId: "shared-main", updatedAt: 1 });
    for (const [accountId, login] of [
      [20, "earlier-person"],
      [21, "other-person"],
    ] as const) {
      const email = `${login}@example.test`;
      const profile = ensureProfileForEmail(email);
      syncGitHubIdentity({
        identity: { accountId, login },
        authenticationAlias: { kind: "email", email },
      });
      await recordSessionParticipant(scope, {
        identity: { type: "profile", id: profile.id },
        promptedAt: 1,
      });
    }
    const owner = { channelId: "test-channel", isLive: () => true };
    const binding = {
      agentId,
      sessionKey,
      messageId: "message",
      inboundEventKind: "user_request" as const,
    };
    const ingress = await createHostChannelIngressRuntime(owner).resolveStable({
      channelId: "test-channel",
      accountId: "account-a",
      identity: {
        authentication: "verified",
        resolveParticipant: (subject) => ({
          domain: "test-channel",
          idKind: "user",
          id: String(subject.stableId),
        }),
      },
      subject: { stableId: "current-channel-human" },
      conversation: { kind: "direct", id: "conversation" },
      contextBinding: binding,
      dmPolicy: "open",
      groupPolicy: "disabled",
      allowFrom: ["*"],
      useDefaultPairingStore: false,
    });
    expect(ingress.ingress.admission).toBe("dispatch");
    const ctx = await createHostChannelInboundEventContextBuilder(
      buildChannelInboundEventContext,
      owner,
    )({
      channel: owner.channelId,
      accountId: "account-a",
      messageId: binding.messageId,
      from: "test-channel:conversation",
      sender: { id: "current-channel-human" },
      conversation: { kind: "direct", id: "conversation" },
      route: { agentId, routeSessionKey: sessionKey },
      reply: { to: "test-channel:conversation" },
      message: { rawBody: "Please work on this new task." },
      channelIngress: ingress,
    });
    recordAcceptedSessionParticipantInput(ctx, scope);
    const created = await createInitialSubagentSession({
      cfg: {},
      targetAgentId: agentId,
      childSessionKey,
      incognito: false,
      requesterInternalKey: sessionKey,
      creationPolicy: { actor: { type: "agent", id: agentId } },
      completionOwnerSessionKey: sessionKey,
      modelPatch: {},
      collect: false,
    });
    expect(created).toMatchObject({ status: "ok" });
    expect(loadSessionEntry(scope)?.participants).toContainEqual({
      identity: {
        type: "remote",
        pluginId: "test-channel",
        domain: "test-channel",
        idKind: "user",
        id: "current-channel-human",
      },
    });
    const child = loadSessionEntry({ ...scope, sessionKey: childSessionKey });
    expect(child?.inheritedGitContributorProfileIds ?? []).toEqual([]);
    expect(child?.participants ?? []).toEqual([]);
    await expect(
      resolveGitCoauthorAttribution({ ...scope, sessionKey: childSessionKey, config: {} }),
    ).resolves.toBeUndefined();
  });
});
