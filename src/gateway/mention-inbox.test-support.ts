import { statSync } from "node:fs";
import type { Result } from "@openclaw/normalization-core/result";
import { expect, vi } from "vitest";
import {
  validateMentionsListResult,
  type ErrorShape,
  type MentionsListResult,
} from "../../packages/gateway-protocol/src/index.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import type { SessionEntry } from "../config/sessions.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { setDisplayName } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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
const handlers = { ...mentionHandlers, ...usersMentionableHandlers };

export function expectMentionError(
  result: unknown,
  code: string,
  details: Partial<ErrorShape> = {},
) {
  expect(result).toMatchObject({ ok: false, error: { code, ...details } });
}

export function mentionRoles(
  definitions: Record<string, GatewayOperatorRoleDefinition> = {},
): OpenClawConfig {
  return {
    gateway: {
      roles: {
        default: "reader",
        definitions: {
          reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
          ...definitions,
        },
      },
    },
  };
}
type InboxFixtureOptions = {
  notifications?: boolean;
  retainProfileCatalog?: boolean;
};

export async function withMentionInbox(
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  cfg: OpenClawConfig = {},
  options: InboxFixtureOptions = {},
) {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: options.retainProfileCatalog !== false },
    async () => {
      const fixture = await createFixture(cfg, options);
      try {
        await run(fixture);
      } finally {
        await fixture.dispose();
      }
    },
  );
}

async function createFixture(cfg: OpenClawConfig, options: InboxFixtureOptions) {
  setRuntimeConfigSnapshot(cfg);
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  const alice = ensureProfileForEmail("alice@mentions.example.test");
  const bob = ensureProfileForEmail("bob@mentions.example.test");
  const carol = ensureProfileForEmail("carol@mentions.example.test");
  setDisplayName(alice.id, "Alice");
  setDisplayName(bob.id, "Bob");
  setDisplayName(carol.id, "Carol");
  const aliceClient = Object.assign(identifiedClient(alice.id, "Alice"), { connId: "alice" });
  const bobClient = Object.assign(identifiedClient(bob.id, "Bob"), { connId: "bob-one" });
  const bobSecond = Object.assign(identifiedClient(bob.id, "Bob"), { connId: "bob-two" });
  const carolClient = Object.assign(identifiedClient(carol.id, "Carol"), { connId: "carol" });
  const clients: GatewayClient[] = [aliceClient, bobClient, bobSecond, carolClient];
  const broadcast = vi.fn();
  const push = vi.fn<NonNullable<Parameters<typeof createMentionInbox>[0]["onMentionCreated"]>>();
  const setSession = (entry: Partial<SessionEntry>, sessionKey = SESSION_KEY, storePath?: string) =>
    upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId: SESSION_ID,
        updatedAt: Date.now(),
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: alice.id },
        ...entry,
      },
    );
  await setSession({ displayName: "Design review" });
  const catalog =
    options.retainProfileCatalog === false ? undefined : await prepareUserProfileCatalog();
  const inboxes = new Set<MentionInbox>();
  const openInbox = (gatewayInstanceId = "mention-gateway") => {
    const inbox = createMentionInbox({
      scheduler,
      gatewayInstanceId,
      getRuntimeConfig: () => cfg,
      getClients: () => clients,
      broadcastToConnIds: broadcast,
      onMentionCreated: options.notifications === false ? undefined : push,
    });
    inboxes.add(inbox);
    return inbox;
  };
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
    clock,
    scheduler,
    alice,
    bob,
    carol,
    aliceClient,
    bobClient,
    bobSecond,
    carolClient,
    clients,
    inbox,
    async items(client: GatewayClient = bobClient, target = inbox) {
      return (await readMentionInbox(target, client)).items;
    },
    call,
    broadcast,
    push,
    setSession,
    async replaceSessionIdentity(sessionId = "replacement-session") {
      await setSession({ sessionId });
      const file = statSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }), { bigint: true });
      emitSessionIdentityMutation({
        agentId: "main",
        databaseIdentity: `${file.dev}:${file.ino}`,
        kind: "replace",
        previous: { sessionId: SESSION_ID, sessionKeys: [SESSION_KEY] },
        current: { sessionId, sessionKeys: [SESSION_KEY] },
      });
    },
    openInbox,
    async dispose() {
      try {
        await Promise.all([...inboxes].map((instance) => instance.dispose()));
        await scheduler.stop();
      } finally {
        catalog?.release();
      }
    },
    post(sourceId = "source-one", overrides: Partial<MentionCommittedInput> = {}, target = inbox) {
      const committedSource = committedSources.get(sourceId) ?? {
        generation: "test-generation",
        sequence: committedSources.size + 1,
        timestamp: Date.now(),
      };
      committedSources.set(sourceId, committedSource);
      return target.recordCommittedInputAsync({
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

type InboxResult = Result<MentionsListResult, ErrorShape>;

async function captureInboxResult(
  operation: (publish: (result: InboxResult) => undefined) => Promise<void>,
) {
  let result: InboxResult | undefined;
  await operation((value) => {
    result = value;
  });
  if (!result) {
    throw new Error("Mention Inbox did not publish a response");
  }
  return result;
}

export function listMentionInbox(inbox: MentionInbox, client: GatewayClient) {
  return captureInboxResult((publish) => inbox.listAsync(client, publish));
}

export function dismissMentionInbox(
  inbox: MentionInbox,
  client: GatewayClient,
  ids: readonly string[],
) {
  return captureInboxResult((publish) => inbox.dismissAsync(client, ids, publish));
}

export async function readMentionInbox(inbox: MentionInbox, client: GatewayClient) {
  const result = await listMentionInbox(inbox, client);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  expect(validateMentionsListResult(result.value)).toBe(true);
  return result.value;
}
