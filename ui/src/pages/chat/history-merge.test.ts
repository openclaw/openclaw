// @vitest-environment node
import {
  createSessionProjection,
  reduceSessionProjection,
  type SessionProjectionScope,
} from "@openclaw/gateway-client/browser";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { createChatSubmissions } from "../../app/chat-submissions.ts";
import { chatOutboxDeliveryKey } from "../../lib/chat/outbox-store.ts";
import {
  admitChatSubmission,
  getChatRunOwner,
  getChatSessionProjection as projectionFor,
  readChatSessionProjectionScope as scopeFor,
  reconcileChatInputCustody,
  reduceChatSessionProjection as reduceChat,
  setChatRunOwner,
  publishChatSessionProjection as publish,
  publishChatSessionProjectionMessages as publishMessages,
} from "./history-merge.ts";
import type { CompactionStatus } from "./tool-stream-contract.ts";
import { buildInitialChatSubmission } from "./user-message-content.ts";

const imageDataUrl = "data:image/png;base64,iVBORw0KGgo=";

function message(role: "assistant" | "user", text: string, metadata?: Record<string, unknown>) {
  return {
    role,
    content: [{ type: "text", text }],
    ...(metadata === undefined ? {} : { __openclaw: metadata }),
  };
}

function projectLiveMessage(
  owner: { sessionKey: string; chatMessages: unknown[] },
  liveMessage: unknown,
  scope: SessionProjectionScope,
) {
  const projection = reduceSessionProjection(projectionFor(owner, scope), {
    type: "messagePersisted",
    message: liveMessage,
    scope,
  });
  publish(owner, projection);
  return projection;
}

function runningPane(scope: SessionProjectionScope) {
  const runId = "live-run";
  const owner = emptyPane();
  const live = projectLiveMessage(owner, persistedMessage("user", "live", "user", 1), scope);
  const running = reduceSessionProjection(live, { type: "runDelta", runId, scope });
  publish(owner, running);
  setChatRunOwner(owner, runId);
  return { owner, running };
}

function emptyPane() {
  return { sessionKey: "agent:main:shared", chatMessages: [] as unknown[] };
}
function branchScope(activeLeafEntryId: string | null): SessionProjectionScope {
  return { sessionKey: "agent:main:shared", sessionId: "shared-session", activeLeafEntryId };
}
function snapshot(
  owner: Parameters<typeof reduceChat>[0],
  messages: unknown[],
  options?: Parameters<typeof reduceChat>[2],
) {
  return reduceChat(owner, { type: "snapshotLoaded", messages }, options);
}
function persistedMessage(
  role: "assistant" | "user",
  text: string,
  id: string,
  seq: number,
  timestamp?: number,
) {
  const value = message(role, text, { id, seq });
  return timestamp === undefined ? value : { ...value, timestamp };
}
function initialFixture(retain = true) {
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
        attachments: [{ id: "image-1", mimeType: "image/png", dataUrl: imageDataUrl }],
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
  const deliver = (deliveredMessage = initial.message) =>
    expectDefined(
      chatSubmissions.retain({
        kind: "delivered",
        owner: client,
        sessionKey,
        sessionId: owner.currentSessionId,
        deliveryKey: chatOutboxDeliveryKey(owner, { sessionKey, agentId: "main" }, "initial-run"),
        pendingRunId: "initial-run",
        message: deliveredMessage,
      }),
      "delivered source",
    );
  return {
    client,
    chatSubmissions,
    owner,
    sessionKey,
    initial,
    deliver,
    admit: () => admitChatSubmission(owner, undefined),
    reset: () => reduceChat(owner, { type: "sessionReset" }),
    read: () => chatSubmissions.readInitial(sessionKey, client),
  };
}

function authoritativeMessage() {
  return {
    role: "user",
    content: "Inspect this persisted image",
    timestamp: 456,
    serverField: "authoritative",
    __openclaw: {
      id: "persisted-initial-user",
      idempotencyKey: "initial-run:user",
      runId: "initial-execution",
      seq: 1,
      media: [{ url: "media://inbound/image-1.png", contentType: "image/png" }],
      mediaImageLayout: { slots: [{ kind: "inline", factIndex: 0 }] },
    },
  };
}

it.each(["message", "user", "imported", "session", "agent", "lifecycle"])(
  "does not transfer a pairing QR across a different %s identity",
  (change) => {
    const owner = { sessionKey: "agent:main:one", chatMessages: [] as unknown[] };
    const scope = {
      sessionKey: owner.sessionKey,
      sessionId: "one",
      agentId: "main",
      lifecycleRevision: 1,
    };
    const saved = message("assistant", "Pairing details", { id: "pair-reply" });
    projectLiveMessage(
      owner,
      {
        ...saved,
        content: [...saved.content, { type: "openclaw_pairing_qr", image_url: imageDataUrl }],
      },
      scope,
    );
    const incoming = {
      ...saved,
      ...(change === "user" ? { role: "user" } : {}),
      __openclaw: {
        id: change === "message" ? "another-reply" : "pair-reply",
        ...(change === "imported"
          ? { importedFrom: "claude-cli", cliSessionId: "external", externalId: "pair-reply" }
          : {}),
      },
    };
    publish(
      owner,
      createSessionProjection(
        {
          ...scope,
          ...(change === "session" ? { sessionId: "two" } : {}),
          ...(change === "agent" ? { agentId: "other" } : {}),
          ...(change === "lifecycle" ? { lifecycleRevision: 2 } : {}),
        },
        [incoming],
      ),
    );
    expect(owner.chatMessages).toEqual([incoming]);
  },
);

it.each(["reset", "session", "branch"] as const)(
  "retires the compaction marker's live state on %s changes",
  (change) => {
    const owner = {
      sessionKey: "agent:main:one",
      chatMessages: [] as unknown[],
      compactionStatus: null as CompactionStatus | null,
    };
    const scope = { sessionKey: owner.sessionKey, activeLeafEntryId: "first" };
    projectionFor(owner, scope);
    owner.compactionStatus = {
      phase: "complete",
      runId: "compact-one",
      startedAt: 1_000,
      completedAt: 2_000,
    };
    reduceChat(
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

it.each(["messagePersisted", "snapshotLoaded"] as const)(
  "sender provenance does not survive authoritative omission in %s",
  (type) => {
    const { owner, initial: handoff } = initialFixture();
    expect(handoff.message["__openclaw"]).toHaveProperty("senderIdentity", {
      type: "profile",
      id: "local",
    });
    admitChatSubmission(owner, undefined);
    const authoritative = authoritativeMessage();
    reduceChat(
      owner,
      type === "messagePersisted"
        ? { type, message: authoritative }
        : { type, messages: [authoritative] },
    );
    const metadata = (owner.chatMessages[0] as { __openclaw: Record<string, unknown> })[
      "__openclaw"
    ];
    for (const key of ["senderIdentity", "senderId", "senderProfileAvatarUrl"]) {
      expect(metadata).not.toHaveProperty(key);
    }
  },
);

it("uses one canonical identity for an explicitly unbranched pane", () => {
  const owner = {
    sessionKey: "agent:main:shared",
    currentSessionId: "shared-session",
    chatDisplayedLeafEntryId: undefined,
    chatMessages: [],
  };

  expect(scopeFor(owner)).toEqual({
    sessionKey: "agent:main:shared",
    sessionId: "shared-session",
    activeLeafEntryId: null,
  });
  expect(
    scopeFor(owner, {
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
  const { owner, sessionKey, initial, deliver } = initialFixture(false);
  const delivered = deliver();
  delivered.pending = false;
  const imported = {
    ...initial.message,
    __openclaw: { ...initial.message["__openclaw"], importedFrom: "cli", externalId: "peer" },
  };
  snapshot(owner, [structuredClone(initial.message), imported]);
  expect(owner.chatMessages).toEqual([imported]);

  snapshot(owner, [initial.message], {
    scope: { sessionKey, sessionId: "replacement-session" },
  });
  expect(owner.chatMessages).toEqual([initial.message]);
});

it("publishes each pane reducer transition and displayed transcript together", () => {
  const owner = emptyPane();
  const liveUser = persistedMessage("user", "shared prompt", "shared-user", 1);

  const projection = reduceChat(owner, { type: "messagePersisted", message: liveUser });

  expect(owner.chatMessages).toEqual([liveUser]);
  expect(projectionFor(owner, projection.scope)).toBe(projection);
  owner.chatMessages = [];
  expect(projectionFor(owner)).toBe(projection);
  publishMessages(owner, [liveUser, liveUser]);
  const composed = projectionFor(owner);
  expect(owner.chatMessages).toEqual([liveUser, liveUser]);
  expect(composed.entries[0]).toBe(projection.entries[0]);
  expect(composed.entries[1]?.message).toBe(liveUser);
  expect(composed.entries[1]?.live).toBe(false);
  publishMessages(owner, [liveUser, liveUser]);
  expect(projectionFor(owner).entries).toEqual(composed.entries);
});

it.each([false, true])("owns initial adoption with cached seed: %s", (cached) => {
  const f = initialFixture();
  const { owner, initial: handoff } = f;
  if (cached) {
    owner.chatMessages = [handoff.message];
    expect(f.admit()).toBe(!cached);
    expect(projectionFor(owner).entries[0]?.pending).toBe(true);
    const admittedMessage = owner.chatMessages[0];
    f.reset();
    expect(f.admit()).toBe(true);
    expect(owner.chatMessages).toEqual([admittedMessage]);
    f.reset();
    snapshot(owner, [], { scope: scopeFor(owner, { sessionId: "rebound-session" }) });
    expect(owner.chatMessages).toEqual([admittedMessage]);
    owner.currentSessionId = "rebound-session";
    const previousUser = persistedMessage("user", "Earlier prompt", "earlier-user", 1, 120);
    const previousReply = persistedMessage("assistant", "Earlier reply", "earlier-reply", 2, 121);
    const output = persistedMessage("assistant", "Preparing reply", "early-output", 3, 124);
    snapshot(owner, [previousUser, previousReply, output], { runActive: true });
    expect(owner.chatMessages).toEqual([previousUser, previousReply, handoff.message, output]);
    snapshot(owner, [], { runActive: true });
    expect(owner.chatMessages).toEqual([handoff.message]);
  }
  const authoritative = authoritativeMessage();
  const event = cached
    ? ({ type: "messagePersisted", message: authoritative } as const)
    : ({ type: "snapshotLoaded", messages: [authoritative] } as const);
  const projection = reduceChat(owner, event, { runActive: cached });

  expect(owner.chatMessages).toEqual([authoritative]);
  expect(projection.messages[0]).toBe(authoritative);

  if (cached) {
    expect(f.read()).not.toBeNull();
    f.reset();
    expect(f.admit()).toBe(false);
    expect(owner.chatMessages).toEqual([]);
    snapshot(owner, [authoritative], { runActive: false });
  }
  expect(f.read()).toMatchObject({ pending: false, message: null });
  if (!cached) {
    expect(f.admit()).toBe(false);
  }
});

it("does not revive an initial handoff delivered after its canonical user message", () => {
  const { chatSubmissions, owner, initial: handoff } = initialFixture(false);
  const authoritative = authoritativeMessage();
  snapshot(owner, [authoritative]);
  chatSubmissions.retain(handoff);

  expect(admitChatSubmission(owner, undefined)).toBe(false);
  expect(owner.chatMessages).toEqual([authoritative]);
  for (let refresh = 0; refresh < 2; refresh++) {
    snapshot(owner, [], { runActive: true });
    expect(owner.chatMessages).toEqual([]);
  }
});

it("binds learned session and branch identity without reclassifying live runs", () => {
  const initialScope = { sessionKey: "agent:main:shared" };
  const { owner, running } = runningPane(initialScope);
  const learnedScope = {
    ...initialScope,
    sessionId: "learned-session",
    activeLeafEntryId: "learned-leaf",
  };

  const projection = projectionFor(owner, learnedScope);

  expect(projection.scope).toEqual(learnedScope);
  expect(projection.entries).toBe(running.entries);
  expect(projection.entries[0]?.live).toBe(true);
  expect(projection.runs).toBe(running.runs);
  expect(projection.runs["live-run"]?.status).toBe("streaming");
  expect(getChatRunOwner(owner)).toBe("live-run");
  expect(getChatRunOwner({})).toBeUndefined();
});

it.each<[string, SessionProjectionScope, SessionProjectionScope]>([
  [
    "session",
    { sessionKey: "agent:main:previous", sessionId: "previous-session" },
    { sessionKey: "agent:main:next", sessionId: "next-session" },
  ],
  ["active branch", branchScope("previous-leaf"), branchScope("next-leaf")],
  ["cleared branch", branchScope("previous-leaf"), branchScope(null)],
  [
    "lifecycle",
    { sessionKey: "agent:main:shared", lifecycleRevision: 1 },
    { sessionKey: "agent:main:shared", lifecycleRevision: 2 },
  ],
  ["agent", { sessionKey: "main", agentId: "first" }, { sessionKey: "main", agentId: "second" }],
])("drops stale live and run provenance when the %s changes", (_, previous, next) => {
  const { owner } = runningPane(previous);

  const projection = snapshot(owner, [], { scope: next });

  expect([projection.messages, projection.runs, projection.scope]).toEqual([[], {}, next]);
  expect(getChatRunOwner(owner)).toBeUndefined();
});

it("retires every materialized local assistant when its pending send fails", () => {
  const owner = emptyPane();
  const pendingUser = message("user", "prompt", {
    idempotencyKey: "pending-run:user",
  });
  const first = message("assistant", "first part");
  const second = message("assistant", "second part");
  const canonical = persistedMessage("assistant", "persisted boundary", "reply", 1);
  const afterBoundary = message("assistant", "after boundary");
  publishMessages(owner, [pendingUser, first]);
  publishMessages(owner, [pendingUser, first, second, canonical, afterBoundary]);

  reduceChat(owner, { type: "sendFailed", runId: "pending-run" });

  expect(owner.chatMessages).toEqual([canonical, afterBoundary]);
});

it("keeps a retained live prefix across a later empty snapshot", () => {
  const owner = emptyPane();
  const prefix = message("assistant", "causal prefix", { runId: "same-run" });
  const tail = message("assistant", "terminal tail", { runId: "same-run" });
  reduceChat(owner, { type: "messagePersisted", message: prefix });
  publishMessages(owner, [prefix, tail], {
    event: { type: "messagePersisted", message: tail },
  });

  snapshot(owner, []);

  expect(owner.chatMessages).toEqual([prefix, tail]);
});

it.each(["page", "receipt", "custody-first"] as const)(
  "retires optimistic steering only for deferred %s custody",
  (source) => {
    const { owner, initial, deliver } = initialFixture(false);
    const steeringMessage = {
      ...initial.message,
      __openclaw: { ...initial.message["__openclaw"], steerTargetRunId: "active-run" },
    };
    const delivered = deliver(steeringMessage);
    const input = {
      id: "deferred-input",
      runId: "initial-run",
      acceptedAt: 123,
      state: "queued" as const,
      message: steeringMessage,
      queued: true as const,
    };
    if (source === "custody-first") {
      expect(admitChatSubmission(owner, [input], delivered)).toBe(false);
    } else {
      expect(admitChatSubmission(owner, undefined, delivered)).toBe(true);
      reconcileChatInputCustody(owner, { items: [{ ...input, queued: undefined }], total: 1 });
      expect(owner.chatMessages).toEqual([steeringMessage]);
      reconcileChatInputCustody(
        owner,
        source === "page" ? { items: [input], total: 1 } : undefined,
        source === "receipt" ? [{ runId: "initial-run", state: "pending", queued: true }] : [],
      );
    }
    expect(delivered.pending).toBe(false);
    expect(delivered.message).toBe(steeringMessage);
    expect(owner.chatMessages).toEqual([]);
    expect(admitChatSubmission(owner, undefined, delivered)).toBe(false);
  },
);
