import { expect, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  bindSessionRowProjection,
  getSessionRowProjection,
} from "../session-row-projection-access.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../session-row-projection.js";
import { sessionReactionHandlers } from "./sessions-reactions.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export const sessionKey = "agent:main:main";
export const sessionId = "reactions-session";
export const transcriptScope = { agentId: "main", sessionKey, sessionId };

export function client(profileId: string, displayName = profileId, admin = false): GatewayClient {
  return {
    connId: `conn-${profileId}`,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: admin ? ["operator.admin"] : ["operator.read", "operator.write"],
    },
    authenticatedUserProfile: { profileId, displayName, hasAvatar: false, updatedAt: 1 },
    preparedSessionProfile: { profileId, aliases: new Set([profileId]), role: null },
  };
}

export function context(config: OpenClawConfig = {}): GatewayRequestContext {
  return {
    getRuntimeConfig: () => config,
    broadcast: vi.fn(),
    logGateway: { warn: vi.fn() },
  } as unknown as GatewayRequestContext;
}

let reactionProjection: Promise<SessionRowProjection> | undefined;

export async function withReactionState(consume: () => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    try {
      await consume();
    } finally {
      if (reactionProjection) {
        (await reactionProjection).dispose();
        reactionProjection = undefined;
      }
    }
  });
}

export async function call(
  method: "session.reactions.set" | "session.reactions.list",
  params: Record<string, unknown>,
  requestClient: GatewayClient | null = client("alice", "Alice"),
  requestContext = context(),
  hasCurrentClientAuthority?: () => boolean,
) {
  if (!getSessionRowProjection(requestContext)) {
    const projection = await (reactionProjection ??= createSessionRowProjection({
      cfg: {},
      modelCatalog: [],
    }));
    bindSessionRowProjection(requestContext, () => projection);
  }
  const responses: Parameters<RespondFn>[] = [];
  await sessionReactionHandlers[method]?.({
    req: { type: "req", id: "reaction-request", method, params },
    params,
    client: requestClient,
    context: requestContext,
    hasCurrentClientAuthority,
    isWebchatConnect: () => true,
    respond: (...response) => responses.push(response),
  });
  expect(responses).toHaveLength(1);
  return responses[0]!;
}

export function roleConfig(others: "none" | "view" | "suggest" | "write"): OpenClawConfig {
  return {
    gateway: {
      roles: {
        default: "test-role",
        definitions: {
          "test-role": {
            sessions: { others },
            agents: "*",
            scopes: ["operator.read", "operator.write"],
          },
        },
      },
    },
  };
}

export async function seedSession(overrides: Partial<SessionEntry> = {}, key = sessionKey) {
  const entry = {
    sessionId,
    updatedAt: 1,
    createdActor: { type: "human", source: "profile", id: "owner" },
    visibility: "shared",
    ...overrides,
  } satisfies SessionEntry;
  await upsertSessionEntryCore({ agentId: "main", sessionKey: key }, entry);
  return { agentId: "main", sessionKey: key, sessionId: entry.sessionId };
}

export async function appendMessage(
  message: Record<string, unknown> = {
    role: "user",
    content: [{ type: "text", text: "Riley's persisted prompt" }],
    __openclaw: { senderName: "Riley", senderUsername: "riley", senderId: "peer-riley" },
  },
  scope = transcriptScope,
) {
  return (await appendTranscriptMessage(scope, { message })).messageId;
}
