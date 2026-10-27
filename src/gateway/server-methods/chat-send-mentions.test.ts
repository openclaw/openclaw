import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { getRuntimeConfig } from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  listSessionPendingInputs,
  loadSessionEntry,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as involvementStore from "../../config/sessions/session-involvement-store.js";
import { readPendingInputSource } from "../../config/sessions/session-pending-input-source.js";
import { parseSessionPendingInputMessage } from "../../config/sessions/session-pending-input-value.js";
import {
  readSessionMembersInWorker,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { setDisplayName, setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { useUserProfileCatalogForTest } from "../../test-utils/user-profile-catalog.js";
import { captureGatewayAuthPolicy } from "../auth-policy.js";
import { resumeChatInput } from "../chat-input-recovery.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import { createMentionInbox } from "../mention-inbox.js";
import { readMentionInbox, dismissMentionInbox } from "../mention-inbox.test-support.js";
import { handleGatewayRequest } from "../server-methods.js";
import * as sharingTargetRead from "../session-sharing-target-read.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import type { GatewayClient, RespondFn } from "./types.js";
installGatewayTestHooks();
const createBrowserFollowupFixture = useBrowserFollowupFixture();
const prepareProfileCatalog = useUserProfileCatalogForTest();
beforeEach(() => prepareProfileCatalog());

function expectStarted(respond: RespondFn, payload: Record<string, unknown> = {}) {
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ status: "started", ...payload }),
    undefined,
    expect.anything(),
  );
}

type FollowupFixture = Awaited<ReturnType<typeof createBrowserFollowupFixture>>;
const pending = (fixture: FollowupFixture) => listSessionPendingInputs(fixture.scope);
function expectNotStarted(respond: RespondFn) {
  expect(respond).toHaveBeenCalledOnce();
  expect(respond).not.toHaveBeenCalledWith(
    true,
    expect.objectContaining({ status: "started" }),
    undefined,
    expect.anything(),
  );
}
async function expectUncommitted(fixture: FollowupFixture) {
  expect(await pending(fixture)).toEqual({ items: [], total: 0 });
  expect(fixture.readTranscript()).toEqual(fixture.activeTranscript);
}
function holdResumedDispatch() {
  const recorder = createDeferred<UserTurnTranscriptRecorder>();
  const release = createDeferred();
  dispatchInboundMessageMock.mockImplementation(async (options: unknown) => {
    const { replyOptions } = options as Parameters<typeof dispatchInboundMessage>[0];
    if (replyOptions?.userTurnTranscriptRecorder) {
      recorder.resolve(replyOptions.userTurnTranscriptRecorder);
    }
    await release.promise;
    return {};
  });
  return { recorder: recorder.promise, release: () => release.resolve() };
}
async function admitPending(fixture: FollowupFixture) {
  expectStarted(await fixture.send());
  const recorder = await fixture.dispatchedRecorder;
  const { items, total } = await pending(fixture);
  expect(total).toBe(1);
  expect(items[0]).toBeDefined();
  return { recorder, original: items[0] };
}

describe("committed human mentions", () => {
  async function createMentionFixture(
    options: {
      active?: boolean;
      preserveContent?: boolean;
      guest?: boolean;
      creator?: "alice" | "carol";
    } = {},
  ) {
    const createProfile = (name: string) => {
      const profile = ensureProfileForEmail(`${name.toLowerCase()}@mentions.example.test`);
      setDisplayName(profile.id, name);
      return { profileId: profile.id, displayName: name, hasAvatar: false, updatedAt: 1 };
    };
    const alice = createProfile("Alice"),
      bob = createProfile("Bob"),
      carol = createProfile("Carol");
    const { creator, ...sessionOptions } = options;
    const fixture = await createBrowserFollowupFixture({
      preserveContent: true,
      ...sessionOptions,
      ...(creator
        ? {
            createdActor: {
              type: "human",
              source: "profile",
              id: creator === "alice" ? alice.profileId : carol.profileId,
            } as const,
          }
        : {}),
      ...(options.guest
        ? {
            sessionKey: "agent:main:dashboard:guest-mentions",
            createdActor: { type: "human", source: "profile", id: alice.profileId },
          }
        : {}),
    });
    fixture.client.authenticatedUserProfile = alice;
    const bobClient = { ...fixture.client, connId: "bob-one", authenticatedUserProfile: bob };
    const carolClient = { ...fixture.client, connId: "carol", authenticatedUserProfile: carol };
    const profileCatalog = await prepareUserProfileCatalog();
    for (const client of [fixture.client, bobClient, carolClient]) {
      prepareGatewayRecipientProfile(client);
    }
    const mentionBroadcast = vi.fn();
    const inbox = createMentionInbox({
      scheduler: createTestGatewayScheduler(),
      gatewayInstanceId: "chat-mention-commit-test",
      getRuntimeConfig,
      getClients: () => [fixture.client, bobClient, carolClient],
      broadcastToConnIds: mentionBroadcast,
    });
    fixture.context.mentionInbox = inbox;
    fixture.params.message = "@Bob could you review this?";
    fixture.params.mentions = [{ profileId: bob.profileId, start: 0, end: 4 }];
    const read = async (client: GatewayClient = bobClient) =>
      (await readMentionInbox(inbox, client)).items;
    const cleanup = () => inbox.dispose().then(fixture.cleanup).finally(profileCatalog.release);
    return {
      ...fixture,
      bobClient,
      carolClient,
      inbox,
      read,
      mentionBroadcast,
      cleanup,
      [Symbol.asyncDispose]: cleanup,
    };
  }

  async function createGuestMentionFixture() {
    const fixture = await createMentionFixture({ active: false, guest: true });
    const cfg = getRuntimeConfig();
    setRuntimeConfigSnapshot({
      ...cfg,
      gateway: {
        ...cfg.gateway,
        roles: {
          default: "guest",
          definitions: {
            administrator: {
              agents: "*",
              scopes: ["operator.admin"],
              sessions: { others: "write" },
            },
            disabled: { agents: [], scopes: [], sessions: { others: "none" } },
            guest: {
              agents: ["main"],
              scopes: ["operator.sessions.read", "operator.sessions.write"],
              sessions: { others: "none" },
            },
          },
        },
      },
    });
    fixture.client.connect = {
      ...fixture.client.connect,
      scopes: ["operator.sessions.read", "operator.sessions.write"],
    };
    setUserProfileRole(fixture.bobClient.authenticatedUserProfile.profileId, "administrator");
    const request = async (method: string, params: Record<string, unknown>) => {
      const respond = vi.fn<RespondFn>();
      await handleGatewayRequest({
        req: { type: "req", id: "guest-mention", method, params },
        client: fixture.client,
        context: fixture.context,
        isWebchatConnect: () => true,
        respond,
      });
      return respond;
    };
    return { ...fixture, request };
  }

  it("lets a session-only guest look up and send a mention through the dispatcher", async () => {
    await using fixture = await createGuestMentionFixture();
    const lookup = await fixture.request("users.mentionable", {
      sessionKey: fixture.scope.sessionKey,
      query: "Bob",
    });
    expect(lookup).toHaveBeenCalledWith(
      true,
      {
        users: [
          {
            profileId: fixture.bobClient.authenticatedUserProfile.profileId,
            displayName: "Bob",
            avatarUrl: expect.stringContaining(
              `/api/users/${fixture.bobClient.authenticatedUserProfile.profileId}/avatar`,
            ),
            online: true,
          },
        ],
        truncated: false,
      },
      undefined,
    );
    expectStarted(await fixture.send(vi.fn(), {}));
    await fixture.finishDispatch();
    expect(await fixture.read()).toMatchObject([
      {
        senderProfileId: fixture.client.authenticatedUserProfile?.profileId,
        excerpt: fixture.params.message,
      },
    ]);
  });

  it("keeps session-only mention lookup and sending within current authority", async () => {
    await using fixture = await createGuestMentionFixture();
    const rejected = (response: RespondFn) => {
      expect(response).toHaveBeenCalledOnce();
      expect(response).toHaveBeenCalledWith(false, undefined, expect.anything());
    };
    for (const method of ["users.list", "system-presence", "cron.list"]) {
      rejected(await fixture.request(method, {}));
    }
    rejected(await fixture.request("users.mentionable", { sessionKey: "unrelated" }));
    rejected(await fixture.send(vi.fn(), {}, { ...fixture.params, sessionKey: "unrelated" }));
    setUserProfileRole(fixture.bobClient.authenticatedUserProfile.profileId, "guest");
    const unavailableRecipient = await fixture.send(vi.fn(), {});
    expect(unavailableRecipient).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "One or more mentioned people are unavailable. Select the recipients again.",
      }),
    );
    await expectUncommitted(fixture);
    setUserProfileRole(fixture.bobClient.authenticatedUserProfile.profileId, "administrator");
    fixture.client.invalidated = true;
    rejected(await fixture.request("users.mentionable", { sessionKey: fixture.scope.sessionKey }));
    rejected(await fixture.send(vi.fn(), {}));
    fixture.client.invalidated = false;
    const prepareRead = sharingTargetRead.prepareSessionSharingRead;
    for (const method of ["users.mentionable", "chat.send"] as const) {
      const ready = createDeferred();
      const release = createDeferred();
      const held = vi
        .spyOn(sharingTargetRead, "prepareSessionSharingRead")
        .mockImplementationOnce(async (params) => {
          const prepared = await prepareRead(params);
          ready.resolve();
          await release.promise;
          return prepared;
        });
      const inFlight =
        method === "users.mentionable"
          ? fixture.request(method, { sessionKey: fixture.scope.sessionKey })
          : fixture.send(vi.fn(), {});
      try {
        await Promise.race([
          ready.promise,
          inFlight.then(() => {
            throw new Error(`${method} completed before the held preparation`);
          }),
        ]);
        setUserProfileRole(fixture.client.authenticatedUserProfile!.profileId, "disabled");
        release.resolve();
        expect(await inFlight).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "FORBIDDEN" }),
        );
        await expectUncommitted(fixture);
        expect(await fixture.read()).toEqual([]);
      } finally {
        release.resolve();
        held.mockRestore();
        await inFlight;
        setUserProfileRole(fixture.client.authenticatedUserProfile!.profileId, "guest");
      }
    }
  });

  async function createInvitationFixture(
    options: { active?: boolean; preserveContent?: boolean; creator?: "alice" | "carol" } = {},
  ) {
    const fixture = await createMentionFixture({ creator: "alice", ...options });
    const aliceId = fixture.client.authenticatedUserProfile!.profileId;
    const bobId = fixture.bobClient.authenticatedUserProfile.profileId;
    const cfg = getRuntimeConfig();
    setRuntimeConfigSnapshot({
      ...cfg,
      gateway: {
        ...cfg.gateway,
        roles: {
          default: "staff",
          definitions: {
            staff: {
              agents: "*",
              scopes: ["operator.read", "operator.write"],
              sessions: { others: "write" },
            },
            guest: {
              agents: "*",
              scopes: ["operator.sessions.read", "operator.sessions.write"],
              sessions: { others: "invited" },
            },
          },
        },
      },
    });
    setUserProfileRole(bobId, "guest");
    for (const client of [fixture.client, fixture.bobClient, fixture.carolClient]) {
      client.connect = {
        ...client.connect,
        scopes:
          client === fixture.bobClient
            ? ["operator.sessions.read", "operator.sessions.write"]
            : ["operator.read", "operator.write"],
      };
      prepareGatewayRecipientProfile(client);
    }
    expect(loadSessionEntry(fixture.scope)?.createdActor?.id).toBe(
      options.creator === "carol"
        ? fixture.carolClient.authenticatedUserProfile.profileId
        : aliceId,
    );
    return {
      ...fixture,
      aliceId,
      bobId,
      members: async () => (await readSessionMembersInWorker(fixture.scope)).members,
    };
  }

  it("invites a guest at the original human commit and never regrants a removed membership on replay", async () => {
    await using fixture = await createInvitationFixture();
    const record = vi.spyOn(fixture.inbox, "recordCommittedInputAsync");
    expectStarted(await fixture.send());
    expect(await fixture.members()).toEqual([]);
    expect(await fixture.read()).toEqual([]);
    const recorder = await fixture.dispatchedRecorder;
    const committed = await recorder.persistApproved();
    expect(committed?.appended).toBe(true);
    expect(await fixture.read()).toHaveLength(1);
    expect(await fixture.members()).toEqual([
      expect.objectContaining({ identityId: fixture.bobId, addedBy: fixture.aliceId }),
    ]);
    const call = record.mock.calls[0]!;
    expect(call[1]).toBeDefined();
    await removeSessionMember(fixture.scope, fixture.bobId, undefined, fixture.scope.sessionId);
    await expect(fixture.inbox.recordCommittedInputAsync(...call)).rejects.toThrow(
      "mention notifications could not be delivered",
    );
    expect(await fixture.members()).toEqual([]);
    expect(await fixture.read()).toEqual([]);
  });

  it.each(["plain text", "rewritten", "non-manager"] as const)(
    "does not invite from %s mentions",
    async (kind) => {
      await using fixture = await createInvitationFixture({
        preserveContent: kind !== "rewritten",
        creator: kind === "non-manager" ? "carol" : "alice",
      });
      if (kind === "plain text") {
        delete fixture.params.mentions;
      }
      const ack = await fixture.send();
      if (kind === "non-manager") {
        expectNotStarted(ack);
        expect(ack.mock.calls[0]?.[2]).toMatchObject({
          message: "One or more mentioned people are unavailable. Select the recipients again.",
        });
        await expectUncommitted(fixture);
      } else {
        expectStarted(ack);
        const committed = await (await fixture.dispatchedRecorder).persistApproved();
        expect(committed?.message["__openclaw"]?.humanMentions).toBeUndefined();
      }
      expect(await fixture.read()).toEqual([]);
      expect(await fixture.members()).toEqual([]);
    },
  );

  it("keeps a queued invitation when the run finishes before Inbox delivery", async () => {
    await using fixture = await createInvitationFixture();
    const deliver = createDeferred();
    const record = fixture.inbox.recordCommittedInputAsync.bind(fixture.inbox);
    let notification: Promise<void> | undefined;
    vi.spyOn(fixture.inbox, "recordCommittedInputAsync").mockImplementationOnce((...args) => {
      notification = deliver.promise.then(() => record(...args));
      return notification;
    });
    try {
      expectStarted(await fixture.send());
      const recorder = await fixture.dispatchedRecorder;
      expect((await recorder.persistApproved())?.appended).toBe(true);
      expect(await fixture.members()).toEqual([
        expect.objectContaining({ identityId: fixture.bobId, addedBy: fixture.aliceId }),
      ]);
      expect(await fixture.read()).toEqual([]);
      expect(recorder.isPendingInputConsumed?.()).toBe(true);
      recorder.finishPendingInput?.("interrupted");
      await recorder.waitForPendingInputSettlement?.();
      fixture.releaseDispatch();
      fixture.activeRun?.complete();
      deliver.resolve();
      await notification;
      await fixture.finishDispatch();
      expect(await fixture.read()).toHaveLength(1);
      expect(fixture.mentionBroadcast).not.toHaveBeenCalledWith(
        "mentions.failed",
        expect.anything(),
        expect.anything(),
      );
    } finally {
      deliver.resolve();
      await notification;
    }
  });

  it.each([false, true])(
    "refuses the original message when invitation preparation fails (queued: %s)",
    async (active) => {
      await using fixture = await createInvitationFixture({ active });
      const failure = new Error("Invitation preparation unavailable");
      vi.spyOn(fixture.inbox, "prepareInvitation").mockImplementation(() => {
        throw failure;
      });
      const ack = await fixture.send();
      expectNotStarted(ack);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      await fixture.finishDispatch();
      expect(fixture.readTranscript()).toEqual(fixture.activeTranscript);
      expect(await pending(fixture)).toMatchObject({
        total: active ? 1 : 0,
        items: active ? [{ state: "interrupted" }] : [],
      });
      expect(await fixture.members()).toEqual([]);
      expect(
        loadSessionEntry(fixture.scope)?.profileInvolvement?.profiles[fixture.bobId],
      ).toBeUndefined();
      expect(await fixture.read()).toEqual([]);
      expect(fixture.mentionBroadcast).not.toHaveBeenCalledWith(
        "mentions.failed",
        expect.anything(),
        expect.anything(),
      );
    },
  );

  it("rolls back an invitation when the sender loses admin authority at the original commit", async () => {
    await using fixture = await createInvitationFixture({ creator: "carol" });
    const cfg = getRuntimeConfig();
    const roles = cfg.gateway!.roles!;
    setRuntimeConfigSnapshot({
      ...cfg,
      gateway: {
        ...cfg.gateway,
        roles: {
          ...roles,
          definitions: {
            ...roles.definitions,
            administrator: {
              agents: "*",
              scopes: ["operator.admin"],
              sessions: { others: "write" },
            },
          },
        },
      },
    });
    setUserProfileRole(fixture.aliceId, "administrator");
    fixture.client.connect.scopes = ["operator.admin"];
    prepareGatewayRecipientProfile(fixture.client);
    expectStarted(await fixture.send());
    const recorder = await fixture.dispatchedRecorder;
    let revoked = false;
    const observe = sqliteWorkerOwnerProbe.admission(workerAdmission, (request, grant, admit) => {
      const admission = isRecord(request.facts) ? request.facts.publication : undefined;
      const actorPublication =
        isRecord(admission) &&
        admission.kind === "session-actor-admission" &&
        admission.final === true
          ? admission.publication
          : undefined;
      const publication =
        isRecord(actorPublication) && actorPublication.kind === "session-actor-outcome"
          ? actorPublication.publication
          : actorPublication;
      if (
        !revoked &&
        request.stage === "commit" &&
        isRecord(publication) &&
        publication.kind === "session-turn"
      ) {
        // Staff can still post here, but only the creator or an admin can invite.
        revoked = true;
        setUserProfileRole(fixture.aliceId, "staff");
      }
      admit(request, grant);
    });
    try {
      await expect(recorder.persistApproved()).rejects.toThrow(
        "Mention invitation authority changed before the message was posted",
      );
    } finally {
      observe.mockRestore();
    }
    expect(revoked).toBe(true);
    expect(recorder.hasPersisted()).toBe(false);
    expect(fixture.readTranscript()).toEqual(fixture.activeTranscript);
    expect(await fixture.members()).toEqual([]);
    expect(
      loadSessionEntry(fixture.scope)?.profileInvolvement?.profiles[fixture.bobId],
    ).toBeUndefined();
    expect(await fixture.read()).toEqual([]);
  });

  it.each([false, true])(
    "reports notification failure while preserving the posted message and invitation (queued: %s)",
    async (active) => {
      await using fixture = await createInvitationFixture({ active });
      const update = vi
        .spyOn(involvementStore, "updateSessionProfileInvolvementAsync")
        .mockRejectedValueOnce(new Error("Inbox worker unavailable"));
      try {
        expectStarted(await fixture.send());
        const recorder = await fixture.dispatchedRecorder;
        if (active) {
          await recorder.persistApproved();
        }
        expect(recorder.hasPersisted()).toBe(true);
        await fixture.finishDispatch();
        await fixture.read();
        expect(fixture.readTranscript()).toContainEqual(
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              role: "user",
              content: fixture.params.message,
            }),
          }),
        );
        expect(await fixture.members()).toEqual([
          expect.objectContaining({ identityId: fixture.bobId, addedBy: fixture.aliceId }),
        ]);
        expect(fixture.mentionBroadcast).toHaveBeenCalledWith(
          "mentions.failed",
          expect.objectContaining({
            sessionKey: fixture.scope.sessionKey,
            errorMessage: expect.stringContaining("mention notifications could not be delivered"),
          }),
          new Set([fixture.client.connId]),
        );
      } finally {
        update.mockRestore();
      }
    },
  );

  it("reports a recipient revoked after posting instead of silently committing a partial mention", async () => {
    await using fixture = await createInvitationFixture();
    const carolId = fixture.carolClient.authenticatedUserProfile.profileId;
    fixture.params.message = "@Bob @Carol please review this";
    fixture.params.mentions = [
      { profileId: fixture.bobId, start: 0, end: 4 },
      { profileId: carolId, start: 5, end: 11 },
    ];
    const record = fixture.inbox.recordCommittedInputAsync.bind(fixture.inbox);
    vi.spyOn(fixture.inbox, "recordCommittedInputAsync").mockImplementationOnce((...args) => {
      const cfg = getRuntimeConfig();
      const roles = cfg.gateway!.roles!;
      setRuntimeConfigSnapshot({
        ...cfg,
        gateway: {
          ...cfg.gateway,
          roles: {
            ...roles,
            definitions: {
              ...roles.definitions,
              guest: { ...roles.definitions.guest!, scopes: [] },
            },
          },
        },
      });
      return record(...args);
    });
    expectStarted(await fixture.send());
    expect((await (await fixture.dispatchedRecorder).persistApproved())?.appended).toBe(true);
    expect(await fixture.read(fixture.carolClient)).toEqual([]);
    expect(await fixture.members()).toEqual([
      expect.objectContaining({ identityId: fixture.bobId, addedBy: fixture.aliceId }),
    ]);
    expect(loadSessionEntry(fixture.scope)?.profileInvolvement?.profiles[carolId]).toBeUndefined();
    expect(fixture.mentionBroadcast).toHaveBeenCalledWith(
      "mentions.failed",
      expect.objectContaining({
        errorMessage: expect.stringContaining("Your message was posted"),
      }),
      new Set([fixture.client.connId]),
    );
  });

  it("creates recipient-only mentions at original message commit, never at the queued ACK", async () => {
    await using fixture = await createMentionFixture();
    const ack = await fixture.send();
    expectStarted(ack);
    expect(await fixture.read()).toEqual([]);
    const recorder = await fixture.dispatchedRecorder;
    const sql = observeHostDataSql();
    let committed: Awaited<ReturnType<typeof recorder.persistApproved>>;
    try {
      committed = await recorder.persistApproved();
      await fixture.read();
      const sqlArgs = sql.calls.flatMap((call) => call.mock.calls).flat();
      expect(
        sqlArgs.filter(
          (value) => typeof value === "string" && value.startsWith("notifications.mentions."),
        ),
      ).toEqual([]);
      expect(
        sql.queries.filter((query) =>
          /\b(?:insert\s+into|update|delete\s+from)\s+["`]?session_nodes\b/i.test(query),
        ),
      ).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(committed?.appended).toBe(true);
    expect(
      loadSessionEntry(fixture.scope)?.profileInvolvement?.profiles[
        fixture.bobClient.authenticatedUserProfile.profileId
      ],
    ).toMatchObject({ hidden: false, lastMention: { sequence: expect.any(Number) } });
    expect(await fixture.read()).toMatchObject([
      {
        messageId: committed?.messageId,
        senderProfileId: fixture.client.authenticatedUserProfile?.profileId,
        excerpt: fixture.params.message,
      },
    ]);
    expect(await fixture.read(fixture.client)).toEqual([]);
    expect(await fixture.read(fixture.carolClient)).toEqual([]);
    const id = (await fixture.read())[0]?.id;
    expect(id).toBeDefined();
    await dismissMentionInbox(fixture.inbox, fixture.bobClient, id ? [id] : []);
    await recorder.persistApproved();
    await fixture.send();
    expect(await fixture.read()).toEqual([]);
  });

  it("includes an idle first commit in the Inbox before ACK without waiting for the agent", async () => {
    await using fixture = await createMentionFixture({ active: false });
    let atAck = 0;
    const ack = await fixture.send(
      vi.fn((ok) => {
        if (ok) {
          atAck = fixture.mentionBroadcast.mock.calls.filter(
            ([event, , recipients]) => event === "mentions.changed" && recipients.has("bob-one"),
          ).length;
        }
      }),
    );
    expectStarted(ack, { messageSeq: 2 });
    expect(atAck).toBe(1);
    await fixture.finishDispatch();
    expect(await fixture.read()).toHaveLength(1);
  });

  it("does not notify when approval replaces the selected token", async () => {
    await using fixture = await createMentionFixture({ preserveContent: false });
    await fixture.send();
    const recorder = await fixture.dispatchedRecorder;
    const committed = await recorder.persistApproved();
    expect(committed?.message.content).toBe(fixture.approvedContent);
    expect(committed?.message["__openclaw"]?.humanMentions).toBeUndefined();
    expect(await fixture.read()).toEqual([]);
  });

  it.each(["retained", "expired"] as const)(
    "rejects changed recipients with %s RAM identity while preserving the queued original",
    async (identity) => {
      await using fixture = await createMentionFixture();
      await fixture.send();
      const recorder = await fixture.dispatchedRecorder;
      if (identity === "expired") {
        fixture.context.dedupe.clear();
      }
      fixture.params.mentions = [
        { profileId: fixture.carolClient.authenticatedUserProfile.profileId, start: 0, end: 4 },
      ];
      const originalRead = sessionAccessor.readSessionSubmittedInput;
      const comparisonSql: string[] = [];
      const read = vi
        .spyOn(sessionAccessor, "readSessionSubmittedInput")
        .mockImplementation(async (...args) => {
          const sql = observeHostDataSql();
          try {
            return await originalRead(...args);
          } finally {
            comparisonSql.push(...sql.queries);
            sql.restore();
          }
        });
      try {
        const replay = await fixture.send();
        expect(replay).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ details: { reason: "chat-request-conflict" } }),
        );
        expect(read).toHaveBeenCalledTimes(identity === "expired" ? 1 : 0);
        expect(comparisonSql).toEqual([]);
      } finally {
        read.mockRestore();
      }
      await recorder.persistApproved();
      expect(await fixture.read()).toHaveLength(1);
      expect(await fixture.read(fixture.carolClient)).toEqual([]);
    },
  );
  it.for([false, true])(
    "restores a queued human invitation with its original offsets (notification failure: %s)",
    async (notificationFailure, { signal }) => {
      await using fixture = await createInvitationFixture();
      fixture.client.internal = {
        ...fixture.client.internal,
        authenticatedOperator: true,
        operatorAccessAuthority: null,
      };
      fixture.client.authPolicy = captureGatewayAuthPolicy(getRuntimeConfig(), {
        role: "operator",
        authMethod: "token",
      });
      fixture.params.message = "hello\n\n@Bob please review";
      fixture.params.mentions = [{ profileId: fixture.bobId, start: 7, end: 11 }];
      const { recorder } = await admitPending(fixture);
      expect(await fixture.members()).toEqual([]);
      const approvalCount = fixture.beforeApprove.mock.calls.length;
      recorder.finishPendingInput?.("interrupted");
      await recorder.waitForPendingInputSettlement?.();
      await fixture.finishDispatch();
      await patchSessionEntryCore(fixture.scope, () => ({ status: "done" }));
      fixture.context.dedupe.clear();

      const source = await readPendingInputSource(
        fixture.scope,
        `${fixture.params.idempotencyKey}:user`,
        true,
      );
      const row = source?.snapshot.pending;
      if (!source || !source.snapshot.current || !row) {
        throw new Error("Expected durable interrupted input");
      }
      source.assertCurrent();
      expect(row.state).toBe("interrupted");
      expect(row.request_hash).toMatch(/^request:/);
      const message = parseSessionPendingInputMessage(row.message_json);
      expect(message["__openclaw"]?.chatInputRecovery).toBeDefined();
      const held = holdResumedDispatch();
      try {
        await resumeChatInput(
          fixture.context,
          { ...fixture.scope, runId: row.run_id, message, requestHash: row.request_hash },
          { signal, assertCurrent: () => source.assertCurrent() },
        );
        const resumed = await withinTest(held.recorder, signal);
        if (notificationFailure) {
          vi.spyOn(involvementStore, "updateSessionProfileInvolvementAsync").mockRejectedValueOnce(
            new Error("Inbox worker unavailable after recovery"),
          );
        }
        const committed = await resumed.persistApproved();
        expect(committed?.appended).toBe(true);
        expect(committed?.message.content).toBe(fixture.params.message);
        expect(committed?.message["__openclaw"]?.humanMentions).toEqual(fixture.params.mentions);
        expect(fixture.beforeApprove).toHaveBeenCalledTimes(approvalCount);
        expect(await fixture.members()).toEqual([
          expect.objectContaining({ identityId: fixture.bobId, addedBy: fixture.aliceId }),
        ]);
        expect(await fixture.read()).toHaveLength(notificationFailure ? 0 : 1);
        if (notificationFailure) {
          expect(fixture.mentionBroadcast).toHaveBeenCalledWith(
            "mentions.failed",
            expect.objectContaining({
              sessionKey: fixture.scope.sessionKey,
              errorMessage: expect.stringContaining("mention notifications could not be delivered"),
            }),
            new Set([fixture.client.connId]),
          );
        }
        await removeSessionMember(fixture.scope, fixture.bobId, undefined, fixture.scope.sessionId);
        await resumed.persistApproved();
        expect(await fixture.members()).toEqual([]);
      } finally {
        held.release();
        await fixture.finishDispatch();
      }
    },
  );
  it.each(["sender", "payload", "cancelled"] as const)(
    "never re-adopts recorded input when its %s changes",
    async (change) => {
      await using fixture = await createMentionFixture({ preserveContent: true });
      const { recorder, original } = await admitPending(fixture);
      if (change === "cancelled") {
        recorder?.finishPendingInput?.("cancelled");
      }
      rotateAgentEventLifecycleGeneration();
      await fixture.finishDispatch();
      fixture.context.dedupe.clear();
      dispatchInboundMessageMock.mockClear();
      await patchSessionEntryCore(fixture.scope, () => ({ status: "done" }));
      if (change === "sender") {
        fixture.client.authenticatedUserProfile = fixture.bobClient.authenticatedUserProfile;
      } else if (change === "payload") {
        fixture.params.message += " Changed request.";
      }
      const response = await fixture.send();
      expect(response.mock.calls[0]?.[0]).toBe(change === "cancelled");
      if (change === "sender") {
        expect(response).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "INVALID_REQUEST",
            message: "One or more mentioned people are unavailable. Select the recipients again.",
          }),
        );
      } else if (change === "payload") {
        expect(response).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ details: { reason: "chat-request-conflict" } }),
        );
      } else {
        expect(response).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "ok" }),
          undefined,
          expect.objectContaining({ cached: true }),
        );
      }
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect((await pending(fixture)).items).toEqual([
        { ...original, state: change === "cancelled" ? "cancelled" : "interrupted" },
      ]);
      expect(fixture.readTranscript()).toEqual(fixture.activeTranscript);
    },
  );
});
