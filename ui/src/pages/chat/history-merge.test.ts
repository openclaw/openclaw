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
  return reduceChat(owner, { type: "messagePersisted", message: liveMessage }, { scope });
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
        text: "initial prompt",
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
    chatSubmissions,
    owner,
    sessionKey,
    initial,
    deliver,
    admit: () => admitChatSubmission(owner, undefined),
    read: () => chatSubmissions.readInitial(sessionKey, client),
  };
}

function authoritativeMessage() {
  return message("user", "persisted prompt", {
    id: "persisted-initial-user",
    idempotencyKey: "initial-run:user",
    runId: "initial-execution",
    seq: 1,
  });
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
      ...emptyPane(),
      compactionStatus: {
        phase: "complete" as const,
        runId: "compact-one",
        startedAt: 1_000,
        completedAt: 2_000,
      },
    };
    const scope = { sessionKey: owner.sessionKey, activeLeafEntryId: "first" };
    projectionFor(owner, scope);
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

it("uses one canonical identity for an explicitly unbranched pane", () => {
  const owner = {
    ...emptyPane(),
    currentSessionId: "shared-session",
    chatDisplayedLeafEntryId: undefined,
  };

  expect(scopeFor(owner)).toEqual(branchScope(null));
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

it.each([
  { cached: false, type: "snapshotLoaded" },
  { cached: true, type: "snapshotLoaded" },
  { cached: true, type: "messagePersisted" },
] as const)("owns initial adoption with cached seed $cached via $type", ({ cached, type }) => {
  const f = initialFixture();
  const { owner, initial: handoff } = f;
  if (cached) {
    owner.chatMessages = [handoff.message];
    expect(f.admit()).toBe(!cached);
    expect(projectionFor(owner).entries[0]?.pending).toBe(true);
    const previousUser = persistedMessage("user", "Earlier prompt", "earlier-user", 1, 120);
    const previousReply = persistedMessage("assistant", "Earlier reply", "earlier-reply", 2, 121);
    const output = persistedMessage("assistant", "Preparing reply", "early-output", 3, 124);
    snapshot(owner, [previousUser, previousReply, output], { runActive: true });
    expect(owner.chatMessages).toEqual([previousUser, previousReply, handoff.message, output]);
    snapshot(owner, [], { runActive: true });
    expect(owner.chatMessages).toEqual([handoff.message]);
  }
  const authoritative = authoritativeMessage();
  const event =
    type === "messagePersisted"
      ? ({ type: "messagePersisted", message: authoritative } as const)
      : ({ type: "snapshotLoaded", messages: [authoritative] } as const);
  reduceChat(owner, event, { runActive: cached });

  expect(owner.chatMessages).toEqual([authoritative]);
  expect(f.read()).toMatchObject({ pending: false, message: null });
  expect(f.admit()).toBe(false);
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
  expect(projection.entries[0]?.live).toBe(true);
  expect(projection.messages).toEqual(running.messages);
  expect(projection.runs["live-run"]?.status).toBe("streaming");
  expect(getChatRunOwner(owner)).toBe("live-run");
});

it.each([
  { sessionKey: "other", sessionId: "other-session" },
  { activeLeafEntryId: "next-leaf" },
  { activeLeafEntryId: null },
  { lifecycleRevision: 2 },
  { agentId: "other" },
])("drops stale live and run provenance for changed scope %j", (change) => {
  const previous = { ...branchScope("previous-leaf"), lifecycleRevision: 1, agentId: "main" };
  const next = { ...previous, ...change };
  const { owner } = runningPane(previous);

  const projection = snapshot(owner, [], { scope: next });

  expect([projection.messages, projection.runs, projection.scope]).toEqual([[], {}, next]);
  expect(getChatRunOwner(owner)).toBeUndefined();
});

it("publishes repeated rows and retains the live prefix across a later empty snapshot", () => {
  const owner = emptyPane();
  const prefix = message("assistant", "causal prefix", { runId: "same-run" });
  const tail = message("assistant", "terminal tail", { runId: "same-run" });
  reduceChat(owner, { type: "messagePersisted", message: prefix });
  publishMessages(owner, [prefix, prefix, tail], {
    event: { type: "messagePersisted", message: tail },
  });
  expect(owner.chatMessages).toEqual([prefix, prefix, tail]);

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
