import { createHash } from "node:crypto";
import { expect, vi } from "vitest";
import {
  validateMentionsListResult,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail, setDisplayName } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { MentionStoreSource } from "./mention-inbox-store.codec.js";
import {
  readMentionStoreSnapshotInDatabase,
  writeMentionStoreChanges,
} from "./mention-inbox-store.js";
import { createMentionInbox } from "./mention-inbox.js";
import type { MentionCommittedInput, MentionInbox } from "./mention-inbox.types.js";
import { mentionHandlers } from "./server-methods/mentions.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./server-methods/types.js";
import { usersMentionableHandlers } from "./server-methods/users-mentionable.js";

export const SESSION_KEY = "agent:main:dashboard:mention-test";
export const SESSION_ID = "mention-test-session";

// Retained inventory is setup, not delivery proof. Clone a real stored source so
// overflow, merge, expiry, dismissal, and replay still run through the Inbox owner.
export function seedRetainedMentionSources(
  entries: { sourceId: string; recipientProfileIds: string[]; messageId?: string }[],
) {
  runOpenClawStateWriteTransaction(({ db }) => {
    const stored = readMentionStoreSnapshotInDatabase(-1, db)!;
    const template = stored.sources.find((source) => source.message);
    if (!template?.message) {
      throw new Error("Seed a real mention before extending retained inventory");
    }
    const { message } = template;
    const sources = new Map<string, MentionStoreSource>();
    let nextSequence = stored.head.nextSequence;
    for (const { sourceId, recipientProfileIds, messageId } of entries) {
      // The persisted replay identity must match recordCommittedInput, not just
      // pass the codec's hex-string validation. Replays below exercise that link.
      const key = createHash("sha256")
        .update(
          JSON.stringify([
            message.content.agentId,
            message.content.sessionKey,
            message.sessionId,
            sourceId,
          ]),
        )
        .digest("hex");
      sources.set(key, {
        key,
        sequence: nextSequence++,
        expiresAt: template.expiresAt,
        recipients: recipientProfileIds.map((id, offset) => [id, `seed-${sourceId}-${offset}`]),
        message: {
          sessionId: message.sessionId,
          content: { ...message.content, messageId: messageId ?? `message-${sourceId}` },
        },
      });
    }
    writeMentionStoreChanges(db, { ...stored.head, nextSequence }, sources);
  });
}

const handlers = { ...mentionHandlers, ...usersMentionableHandlers };
type InboxFixtureOptions = { notifications?: boolean; beforeInbox?: () => void };

export async function withMentionInbox(
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  cfg: OpenClawConfig = {},
  options: InboxFixtureOptions = {},
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = await createFixture(cfg, options);
    try {
      await run(fixture);
    } finally {
      await fixture.dispose();
      vi.useRealTimers();
    }
  });
}

async function createFixture(cfg: OpenClawConfig, options: InboxFixtureOptions) {
  const alice = ensureProfileForEmail("alice@mentions.example.test");
  const bob = ensureProfileForEmail("bob@mentions.example.test");
  const carol = ensureProfileForEmail("carol@mentions.example.test");
  setDisplayName(alice.id, "Alice");
  setDisplayName(bob.id, "Bob");
  setDisplayName(carol.id, "Carol");
  const aliceClient = { ...identifiedClient(alice.id, "Alice"), connId: "alice" };
  const bobClient = { ...identifiedClient(bob.id, "Bob"), connId: "bob-one" };
  const bobSecond = { ...identifiedClient(bob.id, "Bob"), connId: "bob-two" };
  const carolClient = { ...identifiedClient(carol.id, "Carol"), connId: "carol" };
  const clients: GatewayClient[] = [aliceClient, bobClient, bobSecond, carolClient];
  const broadcast = vi.fn();
  const push = vi.fn<NonNullable<Parameters<typeof createMentionInbox>[0]["onMentionCreated"]>>();
  const setSession = (entry: Partial<SessionEntry>, sessionKey = SESSION_KEY) =>
    upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: SESSION_ID,
        updatedAt: Date.now(),
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: alice.id },
        ...entry,
      },
    );
  await setSession({ displayName: "Design review" });
  const inboxes = new Set<MentionInbox>();
  const openInbox = (gatewayInstanceId = "mention-gateway") => {
    const inbox = createMentionInbox({
      gatewayInstanceId,
      getRuntimeConfig: () => cfg,
      getClients: () => clients,
      broadcastToConnIds: broadcast,
      onMentionCreated: options.notifications === false ? undefined : push,
    });
    inboxes.add(inbox);
    return inbox;
  };
  options.beforeInbox?.();
  const committedSources = new Map<string, MentionCommittedInput["committedSource"]>();
  const inbox = openInbox();
  const context = { mentionInbox: inbox, getRuntimeConfig: () => cfg } as GatewayRequestContext;
  async function call(
    method: string,
    params: Record<string, unknown>,
    client: GatewayClient = bobClient,
    onResponse?: GatewayRequestHandlerOptions["respond"],
  ) {
    let response: { ok: boolean; payload?: unknown; error?: ErrorShape } | undefined;
    // Mention publication tests depend on dispatch staying in the current stack.
    // Only involvement tests need the broader session mutation runtime.
    const handler =
      method === "sessions.setInvolvement"
        ? (await import("./server-methods/sessions-mutations.js")).sessionMutationHandlers[method]
        : handlers[method];
    if (!handler) {
      throw new Error(`Missing test method ${method}`);
    }
    await handler({
      req: { type: "req", id: "mention-test", method, params },
      client,
      params,
      context,
      isWebchatConnect: () => true,
      respond: (ok, payload, error) => {
        response = { ok, payload, error };
        onResponse?.(ok, payload, error);
      },
    });
    if (!response) {
      throw new Error(`${method} did not respond`);
    }
    return response;
  }
  return {
    alice,
    bob,
    carol,
    aliceClient,
    bobClient,
    bobSecond,
    carolClient,
    clients,
    inbox,
    call,
    broadcast,
    push,
    setSession,
    openInbox,
    async dispose() {
      await Promise.all([...inboxes].map((instance) => instance.dispose()));
    },
    post(sourceId = "source-one", overrides: Partial<MentionCommittedInput> = {}, target = inbox) {
      let committedSource = committedSources.get(sourceId);
      if (!committedSource) {
        committedSource = {
          generation: "test-generation",
          sequence: committedSources.size + 1,
          timestamp: Date.now(),
        };
        committedSources.set(sourceId, committedSource);
      }
      return target.recordCommittedInput({
        sourceId,
        committedSource,
        sessionKey: SESSION_KEY,
        agentId: "main",
        sessionId: SESSION_ID,
        messageId: `message-${sourceId}`,
        senderProfileId: alice.id,
        recipientProfileIds: [bob.id],
        excerpt: "@Bob review **this change**",
        ...overrides,
      });
    },
  };
}

export async function readMentionInbox(inbox: MentionInbox, client: GatewayClient) {
  let result:
    | import("@openclaw/normalization-core/result").Result<
        import("../../packages/gateway-protocol/src/index.js").MentionsListResult,
        ErrorShape
      >
    | undefined;
  await inbox.list(client, (value) => {
    result = value;
  });
  if (!result) {
    throw new Error("Inbox did not publish");
  }
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  expect(validateMentionsListResult(result.value)).toBe(true);
  return result.value;
}

export async function dismissMentionInbox(
  inbox: MentionInbox,
  client: GatewayClient,
  ids: readonly string[],
) {
  let result:
    | import("@openclaw/normalization-core/result").Result<
        import("../../packages/gateway-protocol/src/index.js").MentionsListResult,
        ErrorShape
      >
    | undefined;
  await inbox.dismiss(client, ids, (value) => {
    result = value;
  });
  if (!result) {
    throw new Error("Inbox did not publish");
  }
  return result;
}

export async function listMentionInbox(inbox: MentionInbox, client: GatewayClient) {
  let result:
    | import("@openclaw/normalization-core/result").Result<
        import("../../packages/gateway-protocol/src/index.js").MentionsListResult,
        ErrorShape
      >
    | undefined;
  await inbox.list(client, (value) => {
    result = value;
  });
  if (!result) {
    throw new Error("Inbox did not publish");
  }
  return result;
}
