// @vitest-environment node
import {
  reduceSessionProjection,
  reduceSessionProjectionRunEvent,
  type SessionProjectionScope,
} from "@openclaw/gateway-client/browser";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { createChatSubmissions } from "../../app/chat-submissions.ts";
import { chatOutboxDeliveryKey } from "../../lib/chat/outbox-store.ts";
import {
  admitChatSubmission,
  getChatRunOwner,
  getChatSessionProjection,
  readChatSessionProjectionScope,
  reduceChatSessionProjection,
  setChatRunOwner,
  publishChatSessionProjection,
  publishChatSessionProjectionMessages,
  reconcileChatInputCustody,
} from "./history-merge.ts";
import type { CompactionStatus } from "./tool-stream-contract.ts";
import { buildInitialChatSubmission } from "./user-message-content.ts";

const imageDataUrl = "data:image/png;base64,iVBORw0KGgo=";

function createHistoryMessage(
  role: "assistant" | "user",
  text: string,
  metadata?: Record<string, unknown>,
) {
  return {
    role,
    content: [{ type: "text", text }],
    ...(metadata === undefined ? {} : { __openclaw: metadata }),
  };
}

function projectLiveMessage(
  owner: { sessionKey: string; chatMessages: unknown[] },
  message: unknown,
  scope: SessionProjectionScope,
) {
  const projection = reduceSessionProjection(getChatSessionProjection(owner, scope), {
    type: "messagePersisted",
    message,
    scope,
  });
  publishChatSessionProjection(owner, projection);
  return projection;
}

function createInitialHandoffFixture(retain = true) {
  const sessionKey = "agent:main:initial-image";
  const client = {};
  const chatSubmissions = createChatSubmissions();
  const owner = {
    sessionKey,
    client,
    chatSubmissions,
    chatMessages: [] as unknown[],
    currentSessionId: "initial-session",
  };
  const initial = expectDefined(
    buildInitialChatSubmission(
      sessionKey,
      {
        text: "inspect this image",
        attachments: [
          {
            id: "image-1",
            mimeType: "image/png",
            fileName: "image.png",
            sizeBytes: 68,
            dataUrl: imageDataUrl,
          },
        ],
        createdAt: 123,
        sender: {
          id: "local",
          name: "Local",
          identity: { type: "profile", id: "local" },
          profileAvatarUrl: "/api/users/local/avatar",
        },
      },
      client,
      "initial-run",
    ),
    "initial input",
  );
  if (retain) {
    chatSubmissions.retain(initial);
  }
  return { client, chatSubmissions, owner, sessionKey, initial };
}

function createAuthoritativeInitialMessage(sequence = 1) {
  return {
    role: "user",
    content: "Inspect this persisted image",
    timestamp: 456,
    serverField: "authoritative",
    __openclaw: {
      id: "persisted-initial-user",
      idempotencyKey: "initial-run:user",
      runId: "initial-execution",
      seq: sequence,
      media: [{ url: "media://inbound/image-1.png", contentType: "image/png" }],
      mediaImageLayout: { slots: [{ kind: "inline", factIndex: 0 }] },
    },
  };
}

describe("pane-owned canonical session projection", () => {
  it.each(["reset", "session", "branch"] as const)(
    "retires the compaction marker's live state on %s changes",
    (change) => {
      const owner = {
        sessionKey: "agent:main:one",
        chatMessages: [] as unknown[],
        compactionStatus: null as CompactionStatus | null,
      };
      const scope = { sessionKey: owner.sessionKey, activeLeafEntryId: "first" };
      getChatSessionProjection(owner, scope);
      owner.compactionStatus = {
        phase: "complete",
        runId: "compact-one",
        startedAt: 1_000,
        completedAt: 2_000,
      };
      reduceChatSessionProjection(
        owner,
        change === "reset" ? { type: "sessionReset" } : { type: "snapshotLoaded", messages: [] },
        {
          scope: {
            ...scope,
            ...(change === "session" ? { sessionKey: "agent:main:two" } : {}),
            ...(change === "branch" ? { activeLeafEntryId: "other" } : {}),
          },
        },
      );
      expect(owner.compactionStatus).toBeNull();
    },
  );

  it("publishes run-only events without traversing the unchanged transcript", () => {
    const owner = { sessionKey: "agent:main:shared", chatMessages: [] as unknown[] };
    const initial = reduceChatSessionProjection(owner, {
      type: "snapshotLoaded",
      messages: [createHistoryMessage("user", "persisted", { id: "user", seq: 1 })],
    });
    let rowReads = 0;
    const messages = new Proxy(owner.chatMessages, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/u.test(key)) {
          rowReads += 1;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    owner.chatMessages = messages;
    setChatRunOwner(owner, "running");
    const next = expectDefined(
      reduceSessionProjectionRunEvent(initial, { state: "delta", runId: "running" }, initial.scope),
      "run-only projection transition",
    );
    publishChatSessionProjection(owner, next.projection);

    expect(rowReads).toBe(0);
    expect(owner.chatMessages).toBe(messages);
    expect(getChatRunOwner(owner)).toBe("running");
    expect(getChatSessionProjection(owner).runs.running?.status).toBe("streaming");
    reduceChatSessionProjection(owner, { type: "sessionReset" });
    expect(getChatRunOwner(owner)).toBeUndefined();
    expect(owner.chatMessages).toEqual([]);
  });

  it.each(["messagePersisted", "snapshotLoaded"] as const)(
    "sender provenance does not survive authoritative omission in %s",
    (type) => {
      const { owner, initial: handoff } = createInitialHandoffFixture();
      expect(handoff.message["__openclaw"]).toHaveProperty("senderIdentity", {
        type: "profile",
        id: "local",
      });
      admitChatSubmission(owner, undefined);
      const authoritative = createAuthoritativeInitialMessage();
      reduceChatSessionProjection(
        owner,
        type === "messagePersisted"
          ? { type, message: authoritative }
          : { type, messages: [authoritative] },
      );
      const metadata = (owner.chatMessages[0] as { __openclaw: Record<string, unknown> })[
        "__openclaw"
      ];
      expect(metadata).not.toHaveProperty("senderIdentity");
      expect(metadata).not.toHaveProperty("senderId");
      expect(metadata).not.toHaveProperty("senderProfileAvatarUrl");
    },
  );

  it("uses one canonical identity for an explicitly unbranched pane", () => {
    const owner = {
      sessionKey: "agent:main:shared",
      currentSessionId: "shared-session",
      chatDisplayedLeafEntryId: undefined,
      chatMessages: [],
    };

    expect(readChatSessionProjectionScope(owner)).toEqual({
      sessionKey: "agent:main:shared",
      sessionId: "shared-session",
      activeLeafEntryId: null,
    });
    expect(
      readChatSessionProjectionScope(owner, {
        agentId: "main",
        sessionId: null,
        activeLeafEntryId: "selected-leaf",
      }),
    ).toEqual({
      sessionKey: "agent:main:shared",
      agentId: "main",
      activeLeafEntryId: "selected-leaf",
    });
  });

  it("does not revive a consumed delivered copy from the cache or consume foreign provenance", () => {
    const { client, chatSubmissions, owner, sessionKey, initial } =
      createInitialHandoffFixture(false);
    const delivered = expectDefined(
      chatSubmissions.retain({
        kind: "delivered",
        owner: client,
        sessionKey,
        sessionId: owner.currentSessionId,
        deliveryKey: chatOutboxDeliveryKey(owner, { sessionKey, agentId: "main" }, "initial-run"),
        pendingRunId: "initial-run",
        message: initial.message,
      }),
      "delivered source",
    );
    delivered.pending = false;
    const imported = {
      ...initial.message,
      __openclaw: { ...initial.message["__openclaw"], importedFrom: "cli", externalId: "peer" },
    };
    reduceChatSessionProjection(owner, {
      type: "snapshotLoaded",
      messages: [structuredClone(initial.message), imported],
    });
    expect(owner.chatMessages).toEqual([imported]);

    reduceChatSessionProjection(
      owner,
      { type: "snapshotLoaded", messages: [initial.message] },
      {
        scope: { sessionKey, sessionId: "replacement-session" },
      },
    );
    expect(owner.chatMessages).toEqual([initial.message]);
  });

  it("publishes each pane reducer transition and displayed transcript together", () => {
    const owner = { sessionKey: "agent:main:shared", chatMessages: [] as unknown[] };
    const liveUser = createHistoryMessage("user", "shared prompt", {
      id: "shared-user",
      seq: 1,
    });

    const projection = reduceChatSessionProjection(owner, {
      type: "messagePersisted",
      message: liveUser,
    });

    expect(owner.chatMessages).toEqual([liveUser]);
    expect(getChatSessionProjection(owner, projection.scope)).toBe(projection);
    // A renderer's temporary copy cannot silently replace the authoritative projection.
    owner.chatMessages = [];
    expect(getChatSessionProjection(owner)).toBe(projection);
    publishChatSessionProjectionMessages(owner, [liveUser, liveUser]);
    const composed = getChatSessionProjection(owner);
    expect(owner.chatMessages).toEqual([liveUser, liveUser]);
    expect(composed.entries[0]).toBe(projection.entries[0]);
    expect(composed.entries[1]?.message).toBe(liveUser);
    expect(composed.entries[1]?.live).toBe(false);
    publishChatSessionProjectionMessages(owner, [liveUser, liveUser]);
    expect(getChatSessionProjection(owner).entries).toEqual(composed.entries);
  });

  it.each([
    {
      name: "live-first active adoption",
      admitFirst: true,
      cached: false,
      eventType: "messagePersisted" as const,
    },
    {
      name: "history-first terminal adoption",
      admitFirst: false,
      cached: false,
      eventType: "snapshotLoaded" as const,
    },
    {
      name: "cached initial seed adoption",
      admitFirst: true,
      cached: true,
      eventType: "messagePersisted" as const,
    },
  ])("owns $name in one projection publication", ({ admitFirst, cached, eventType }) => {
    const {
      client,
      chatSubmissions,
      owner,
      sessionKey,
      initial: handoff,
    } = createInitialHandoffFixture();
    if (admitFirst) {
      if (cached) {
        owner.chatMessages = [handoff.message];
      }
      expect(admitChatSubmission(owner, undefined)).toBe(!cached);
      expect(getChatSessionProjection(owner).entries[0]?.pending).toBe(true);
      const admittedMessage = owner.chatMessages[0];
      reduceChatSessionProjection(owner, { type: "sessionReset" });
      expect(admitChatSubmission(owner, undefined)).toBe(true);
      expect(owner.chatMessages).toEqual([admittedMessage]);
      reduceChatSessionProjection(owner, { type: "sessionReset" });
      const reboundScope = readChatSessionProjectionScope(owner, {
        sessionId: "rebound-session",
      });
      reduceChatSessionProjection(
        owner,
        { type: "snapshotLoaded", messages: [] },
        { scope: reboundScope },
      );
      expect(owner.chatMessages).toEqual([admittedMessage]);
      owner.currentSessionId = "rebound-session";
    }
    if (admitFirst) {
      const previousUser = {
        ...createHistoryMessage("user", "Earlier prompt", { id: "earlier-user", seq: 1 }),
        timestamp: 120,
      };
      const previousReply = {
        ...createHistoryMessage("assistant", "Earlier reply", { id: "earlier-reply", seq: 2 }),
        timestamp: 121,
      };
      const output = {
        ...createHistoryMessage("assistant", "Preparing the first reply", {
          id: "early-output",
          seq: 3,
        }),
        timestamp: 124,
      };
      reduceChatSessionProjection(
        owner,
        { type: "snapshotLoaded", messages: [previousUser, previousReply, output] },
        { runActive: true },
      );
      expect(owner.chatMessages).toEqual([previousUser, previousReply, handoff.message, output]);
      reduceChatSessionProjection(
        owner,
        { type: "snapshotLoaded", messages: [] },
        { runActive: true },
      );
      expect(owner.chatMessages).toEqual([handoff.message]);
    }
    const authoritative = createAuthoritativeInitialMessage();
    const event =
      eventType === "messagePersisted"
        ? ({ type: eventType, message: authoritative } as const)
        : ({ type: eventType, messages: [authoritative] } as const);
    const projection = reduceChatSessionProjection(owner, event, { runActive: admitFirst });

    expect(owner.chatMessages).toEqual([authoritative]);
    expect(projection.messages[0]).toBe(authoritative);

    if (admitFirst) {
      expect(chatSubmissions.readInitial(sessionKey, client)).not.toBeNull();
      reduceChatSessionProjection(owner, { type: "sessionReset" });
      expect(admitChatSubmission(owner, undefined)).toBe(false);
      expect(owner.chatMessages).toEqual([]);
      reduceChatSessionProjection(
        owner,
        { type: "snapshotLoaded", messages: [authoritative] },
        { runActive: false },
      );
      expect(chatSubmissions.readInitial(sessionKey, client)).toMatchObject({
        pending: false,
        message: null,
      });
    } else {
      expect(chatSubmissions.readInitial(sessionKey, client)).toMatchObject({
        pending: false,
        message: null,
      });
      expect(admitChatSubmission(owner, undefined)).toBe(false);
    }
  });

  it("adopts the exact submission at its actual committed position", () => {
    const { client, chatSubmissions, owner, sessionKey } = createInitialHandoffFixture();
    admitChatSubmission(owner, undefined);
    const authoritative = createAuthoritativeInitialMessage(4);
    reduceChatSessionProjection(
      owner,
      { type: "snapshotLoaded", messages: [authoritative] },
      { runActive: false },
    );
    expect(owner.chatMessages).toEqual([authoritative]);
    expect(chatSubmissions.readInitial(sessionKey, client)).toMatchObject({
      pending: false,
      message: null,
    });
  });

  it("does not revive an initial handoff delivered after its canonical user message", () => {
    const { chatSubmissions, owner, initial: handoff } = createInitialHandoffFixture(false);
    const authoritative = createAuthoritativeInitialMessage();
    reduceChatSessionProjection(owner, { type: "snapshotLoaded", messages: [authoritative] });
    chatSubmissions.retain(handoff);

    expect(admitChatSubmission(owner, undefined)).toBe(false);
    expect(owner.chatMessages).toEqual([authoritative]);
    for (let refresh = 0; refresh < 2; refresh++) {
      reduceChatSessionProjection(
        owner,
        { type: "snapshotLoaded", messages: [] },
        { runActive: true },
      );
      expect(owner.chatMessages).toEqual([]);
    }
  });

  it.each(
    ["messagePersisted", "snapshotLoaded"].flatMap((eventType) =>
      ["handoff-first", "receipt-first"].map((order) => ({ eventType, order })),
    ),
  )("adopts consumed input through $eventType ($order)", ({ eventType, order }) => {
    const {
      client,
      chatSubmissions,
      owner,
      sessionKey,
      initial: handoff,
    } = createInitialHandoffFixture(false);
    const canonical = createHistoryMessage("user", "Collected initial input", {
      id: "aggregate-input",
      seq: 2,
      idempotencyKey: "followup-collect:session:batch",
    });
    const imported = {
      ...canonical,
      __openclaw: { ...canonical["__openclaw"], importedFrom: "cli", externalId: "peer" },
    };
    reduceChatSessionProjection(owner, { type: "snapshotLoaded", messages: [imported] });
    const retain = () => {
      chatSubmissions.retain({ ...handoff, kind: "initial", consumedByEventId: "aggregate-input" });
      admitChatSubmission(owner, undefined);
    };
    if (order === "handoff-first") {
      retain();
      expect(owner.chatMessages).toContain(handoff.message);
    }
    reduceChatSessionProjection(
      owner,
      eventType === "messagePersisted"
        ? { type: "messagePersisted", message: canonical }
        : { type: "snapshotLoaded", messages: [imported, canonical] },
    );
    if (order === "receipt-first") {
      retain();
    }
    expect(owner.chatMessages).toContain(canonical);
    expect(owner.chatMessages).toContain(imported);
    expect(owner.chatMessages).not.toContain(handoff.message);
    expect(chatSubmissions.readInitial(sessionKey, client)?.pending).toBe(false);
  });

  it("keeps the initial optimistic bubble on a pending receipt, retires it when consumed", () => {
    const { owner, initial } = createInitialHandoffFixture(true);
    reduceChatSessionProjection(owner, {
      type: "sendPending",
      runId: "initial-run",
      message: initial.message,
    });
    expect(owner.chatMessages).toContain(initial.message);

    // A pending receipt only confirms server custody; with no rendered custody or
    // canonical row it must not drop the just-sent bubble (the reported vanish).
    reconcileChatInputCustody(owner, undefined, [{ runId: "initial-run", state: "pending" }]);
    expect(owner.chatMessages).toContain(initial.message);

    // A consumed receipt means the input joined the transcript and retires it.
    reconcileChatInputCustody(owner, undefined, [
      { runId: "initial-run", state: "consumed", consumedByEventId: "aggregate" },
    ]);
    expect(owner.chatMessages).not.toContain(initial.message);
  });

  it("keeps each split pane's live projection independent", () => {
    const scope = { sessionKey: "agent:main:shared", sessionId: "shared-session" };
    const firstPane = { sessionKey: scope.sessionKey, chatMessages: [] as unknown[] };
    const secondPane = { sessionKey: scope.sessionKey, chatMessages: [] as unknown[] };
    const liveUser = createHistoryMessage("user", "first pane", {
      id: "first-user",
      seq: 1,
    });

    projectLiveMessage(firstPane, liveUser, scope);

    expect(getChatSessionProjection(firstPane, scope).messages).toEqual([liveUser]);
    expect(getChatSessionProjection(secondPane, scope).messages).toEqual([]);
  });

  it("binds learned session and branch identity without reclassifying live runs", () => {
    const owner = { sessionKey: "agent:main:shared", chatMessages: [] as unknown[] };
    const initialScope = { sessionKey: "agent:main:shared" };
    const liveUser = createHistoryMessage("user", "same live turn", {
      id: "same-live-user",
      seq: 1,
    });
    const liveProjection = projectLiveMessage(owner, liveUser, initialScope);
    const runningProjection = reduceSessionProjection(liveProjection, {
      type: "runDelta",
      runId: "same-live-run",
      scope: initialScope,
    });
    publishChatSessionProjection(owner, runningProjection);
    setChatRunOwner(owner, "same-live-run");
    const learnedScope = {
      ...initialScope,
      sessionId: "learned-session",
      activeLeafEntryId: "learned-leaf",
    };

    const projection = getChatSessionProjection(owner, learnedScope);

    expect(projection.scope).toEqual(learnedScope);
    expect(projection.entries).toBe(runningProjection.entries);
    expect(projection.entries[0]?.live).toBe(true);
    expect(projection.runs).toBe(runningProjection.runs);
    expect(projection.runs["same-live-run"]?.status).toBe("streaming");
    expect(getChatRunOwner(owner)).toBe("same-live-run");
    expect(getChatRunOwner({})).toBeUndefined();
  });

  it.each([
    {
      name: "session",
      previous: { sessionKey: "agent:main:previous", sessionId: "previous-session" },
      next: { sessionKey: "agent:main:next", sessionId: "next-session" },
    },
    {
      name: "active branch",
      previous: {
        sessionKey: "agent:main:shared",
        sessionId: "shared-session",
        activeLeafEntryId: "previous-leaf",
      },
      next: {
        sessionKey: "agent:main:shared",
        sessionId: "shared-session",
        activeLeafEntryId: "next-leaf",
      },
    },
    {
      name: "cleared branch",
      previous: {
        sessionKey: "agent:main:shared",
        sessionId: "shared-session",
        activeLeafEntryId: "previous-leaf",
      },
      next: {
        sessionKey: "agent:main:shared",
        sessionId: "shared-session",
        activeLeafEntryId: null,
      },
    },
    {
      name: "lifecycle",
      previous: { sessionKey: "agent:main:shared", lifecycleRevision: 1 },
      next: { sessionKey: "agent:main:shared", lifecycleRevision: 2 },
    },
    {
      name: "agent",
      previous: { sessionKey: "main", agentId: "first" },
      next: { sessionKey: "main", agentId: "second" },
    },
  ])("drops stale live and run provenance when the $name changes", ({ previous, next }) => {
    const owner = { sessionKey: "agent:main:shared", chatMessages: [] as unknown[] };
    const liveUser = createHistoryMessage("user", "obsolete turn", {
      id: "obsolete-user",
      seq: 1,
    });
    const running = reduceSessionProjection(projectLiveMessage(owner, liveUser, previous), {
      type: "runDelta",
      runId: "obsolete-run",
      scope: previous,
    });
    publishChatSessionProjection(owner, running);
    setChatRunOwner(owner, "obsolete-run");

    const projection = reduceChatSessionProjection(
      owner,
      { type: "snapshotLoaded", messages: [] },
      { scope: next },
    );

    expect(projection.messages).toEqual([]);
    expect(projection.runs).toEqual({});
    expect(projection.scope).toEqual(next);
    expect(getChatRunOwner(owner)).toBeUndefined();
  });

  it("retires run display ownership when the same session is reset", () => {
    const owner = { sessionKey: "agent:main:shared", chatMessages: [] as unknown[] };
    reduceChatSessionProjection(owner, { type: "runDelta", runId: "before-reset" });
    setChatRunOwner(owner, "before-reset");

    reduceChatSessionProjection(owner, { type: "sessionReset" });

    expect(getChatRunOwner(owner)).toBeUndefined();
    expect(getChatSessionProjection(owner).runs).toEqual({});
  });

  it("retains a proven live branch when another consumer omits optional scope", () => {
    const owner = { sessionKey: "agent:main:shared", chatMessages: [] as unknown[] };
    const scope = {
      sessionKey: "agent:main:shared",
      sessionId: "shared-session",
      activeLeafEntryId: "current-leaf",
    };
    const liveUser = createHistoryMessage("user", "same branch", { id: "live-user", seq: 1 });
    const projection = projectLiveMessage(owner, liveUser, scope);

    expect(
      getChatSessionProjection(owner, {
        sessionKey: scope.sessionKey,
        sessionId: scope.sessionId,
      }),
    ).toBe(projection);
  });

  it("binds an explicit unbranched transcript before resetting for a selected leaf", () => {
    const owner = { sessionKey: "agent:main:shared", chatMessages: [] as unknown[] };
    const initialScope = { sessionKey: "agent:main:shared" };
    const liveUser = createHistoryMessage("user", "unbranched turn", {
      id: "unbranched-user",
      seq: 1,
    });
    projectLiveMessage(owner, liveUser, initialScope);

    expect(
      getChatSessionProjection(owner, {
        ...initialScope,
        activeLeafEntryId: null,
      }).scope,
    ).toEqual({ ...initialScope, activeLeafEntryId: null });
    expect(
      getChatSessionProjection(owner, {
        ...initialScope,
        activeLeafEntryId: "selected-leaf",
      }).messages,
    ).toEqual([]);
  });

  it("lets the shared reducer mark and adopt a newly materialized pending send", () => {
    const owner = { sessionKey: "agent:main:shared", chatMessages: [] as unknown[] };
    const scope = { sessionKey: "agent:main:shared", sessionId: "shared-session" };
    const firstUser = createHistoryMessage("user", "first persisted prompt", {
      id: "first-user",
      idempotencyKey: "first-run:user",
      seq: 1,
    });
    const pendingUser = createHistoryMessage("user", "second prompt", {
      idempotencyKey: "second-run:user",
    });
    const persistedUser = createHistoryMessage("user", "second prompt", {
      id: "second-user",
      idempotencyKey: "second-run:user",
      seq: 2,
    });
    publishChatSessionProjectionMessages(owner, [firstUser], { scope });

    const pending = publishChatSessionProjectionMessages(owner, [firstUser, pendingUser], {
      scope,
    });

    expect(pending.entries[0]?.pending).toBe(false);
    expect(pending.entries[1]).toMatchObject({ pending: true, pendingRunId: "second-run" });
    const adopted = reduceSessionProjection(pending, {
      type: "snapshotLoaded",
      messages: [firstUser, persistedUser],
      scope,
    });
    expect(adopted.messages).toEqual([firstUser, persistedUser]);
    expect(adopted.entries[1]).toMatchObject({
      pending: false,
      identity: { id: "second-user", runId: "second-run" },
    });
  });

  it("retires every materialized local assistant when its pending send fails", () => {
    const owner = { sessionKey: "agent:main:shared", chatMessages: [] as unknown[] };
    const pendingUser = createHistoryMessage("user", "prompt", {
      idempotencyKey: "pending-run:user",
    });
    const first = createHistoryMessage("assistant", "first part");
    const second = createHistoryMessage("assistant", "second part");
    const canonical = createHistoryMessage("assistant", "persisted boundary", {
      id: "reply",
      seq: 1,
    });
    const afterBoundary = createHistoryMessage("assistant", "after boundary");
    publishChatSessionProjectionMessages(owner, [pendingUser, first]);
    publishChatSessionProjectionMessages(owner, [
      pendingUser,
      first,
      second,
      canonical,
      afterBoundary,
    ]);

    reduceChatSessionProjection(owner, { type: "sendFailed", runId: "pending-run" });

    expect(owner.chatMessages).toEqual([canonical, afterBoundary]);
  });

  it("keeps a retained live prefix across a later empty snapshot", () => {
    const owner = { sessionKey: "agent:main:shared", chatMessages: [] as unknown[] };
    const prefix = createHistoryMessage("assistant", "causal prefix", { runId: "same-run" });
    const tail = createHistoryMessage("assistant", "terminal tail", { runId: "same-run" });
    reduceChatSessionProjection(owner, { type: "messagePersisted", message: prefix });
    publishChatSessionProjectionMessages(owner, [prefix, tail], {
      event: { type: "messagePersisted", message: tail },
    });

    reduceChatSessionProjection(owner, { type: "snapshotLoaded", messages: [] });

    expect(owner.chatMessages).toEqual([prefix, tail]);
  });

  it("does not classify later authoritative rows as optimistic sends", () => {
    const owner = { sessionKey: "agent:main:shared", chatMessages: [] as unknown[] };
    const scope = { sessionKey: "agent:main:shared" };
    const first = createHistoryMessage("user", "first", {
      id: "first-user",
      idempotencyKey: "first-run:user",
      seq: 1,
    });
    const second = createHistoryMessage("user", "second", {
      id: "second-user",
      idempotencyKey: "second-run:user",
      seq: 2,
    });
    publishChatSessionProjectionMessages(owner, [first], { scope });

    expect(
      publishChatSessionProjectionMessages(owner, [first, second], { scope }).entries,
    ).toMatchObject([{ pending: false }, { pending: false }]);
  });

  it("never resurrects an ordinary historical row removed by a snapshot", () => {
    const owner = { sessionKey: "agent:main:shared", chatMessages: [] as unknown[] };
    const scope = { sessionKey: "agent:main:shared" };
    const removed = createHistoryMessage("user", "removed prompt", {
      id: "removed-user",
      seq: 1,
    });
    const reply = createHistoryMessage("assistant", "remaining reply", {
      id: "remaining-reply",
      seq: 2,
    });
    const projection = publishChatSessionProjectionMessages(owner, [removed, reply], { scope });

    expect(
      reduceSessionProjection(projection, {
        type: "snapshotLoaded",
        messages: [reply],
        scope,
      }).messages,
    ).toEqual([reply]);
  });

  it("does not restore a hidden live message into the displayed transcript", () => {
    const owner = { sessionKey: "agent:main:shared", chatMessages: [] as unknown[] };
    const scope = { sessionKey: "agent:main:shared" };
    const hidden = createHistoryMessage("user", "hidden prompt", {
      id: "hidden-user",
      seq: 1,
    });

    expect(
      reduceSessionProjection(projectLiveMessage(owner, hidden, scope), {
        type: "snapshotLoaded",
        messages: [],
        scope,
        options: { shouldIncludeMessage: (message) => message !== hidden },
      }).messages,
    ).toEqual([]);
  });

  it("preserves distinct same-text prompts by canonical message identity", () => {
    const owner = { sessionKey: "agent:main:shared", chatMessages: [] as unknown[] };
    const scope = { sessionKey: "agent:main:shared" };
    const first = createHistoryMessage("user", "continue", {
      id: "first-user",
      idempotencyKey: "first-run:user",
      seq: 1,
    });
    const second = createHistoryMessage("user", "continue", {
      id: "second-user",
      idempotencyKey: "second-run:user",
      seq: 2,
    });
    const projection = reduceSessionProjection(projectLiveMessage(owner, first, scope), {
      type: "messagePersisted",
      message: second,
      scope,
    });

    expect(projection.messages).toEqual([first, second]);
  });

  it("keeps colliding native and imported provider identities separate", () => {
    const owner = { sessionKey: "agent:main:shared", chatMessages: [] as unknown[] };
    const scope = { sessionKey: "agent:main:shared" };
    const native = createHistoryMessage("user", "native", {
      id: "provider-local",
      seq: 1,
    });
    const imported = createHistoryMessage("user", "imported", {
      id: "provider-local",
      importedFrom: "claude-cli",
      cliSessionId: "cli-session",
      externalId: "provider-local",
      seq: 2,
    });

    expect(
      reduceSessionProjection(projectLiveMessage(owner, native, scope), {
        type: "messagePersisted",
        message: imported,
        scope,
      }).messages,
    ).toEqual([native, imported]);
  });

  it("adopts an attachment-only pending turn by its run identity", () => {
    const owner = { sessionKey: "agent:main:shared", chatMessages: [] as unknown[] };
    const scope = { sessionKey: "agent:main:shared" };
    const pending = {
      role: "user",
      content: "",
      __openclaw: { idempotencyKey: "attachment-run:user" },
    };
    const persisted = {
      role: "user",
      content: "",
      __openclaw: {
        id: "attachment-user",
        idempotencyKey: "attachment-run:user",
        seq: 4,
        media: [{ mimeType: "application/pdf", fileName: "brief.pdf" }],
      },
    };

    expect(
      reduceSessionProjection(publishChatSessionProjectionMessages(owner, [pending], { scope }), {
        type: "snapshotLoaded",
        messages: [persisted],
        scope,
      }).messages,
    ).toEqual([persisted]);
  });
});
