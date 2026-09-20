import { expect, vi } from "vitest";
import {
  validateMentionsListResult,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureProfileForEmail, setDisplayName } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createMentionInbox } from "./mention-inbox.js";
import type { MentionCommittedInput, MentionInbox } from "./mention-inbox.types.js";
import { mentionHandlers } from "./server-methods/mentions.js";
import { sessionMutationHandlers } from "./server-methods/sessions-mutations.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./server-methods/types.js";
import { usersMentionableHandlers } from "./server-methods/users-mentionable.js";

export const SESSION_KEY = "agent:main:dashboard:mention-test";
export const SESSION_ID = "mention-test-session";
const handlers = { ...mentionHandlers, ...usersMentionableHandlers, ...sessionMutationHandlers };
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
      fixture.dispose();
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
    const handler = handlers[method];
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
    dispose() {
      for (const instance of inboxes) {
        instance.dispose();
      }
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
      target.recordCommittedInput({
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

export function readMentionInbox(inbox: MentionInbox, client: GatewayClient) {
  const result = inbox.list(client);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  expect(validateMentionsListResult(result.value)).toBe(true);
  return result.value;
}
