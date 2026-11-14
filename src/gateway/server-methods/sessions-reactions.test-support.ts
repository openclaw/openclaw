import { expect, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as projectionAccess from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { sessionReactionHandlers } from "./sessions-reactions.js";
import { profileSessionEntry } from "./sessions-read-cache.test-support.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export const sessionKey = "agent:main:main";
export const sessionId = "reactions-session";
export const transcriptScope = { agentId: "main", sessionKey, sessionId };

export function reactionGate() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const wait = () => {
    entered.resolve();
    return release.promise;
  };
  return {
    entered: entered.promise,
    release: release.resolve,
    wait,
    async hold<T>(reading: Promise<T>) {
      const result = await reading;
      await wait();
      return result;
    },
  };
}

export function client(profileId: string, displayName = profileId, admin = false): GatewayClient {
  const scopes = admin ? ["operator.admin"] : ["operator.read", "operator.write"];
  return {
    connId: `conn-${profileId}`,
    connect: sharingPolicyClient({ scopes }).connect,
    authenticatedUserProfile: { profileId, displayName, hasAvatar: false, updatedAt: 1 },
    preparedSessionProfile: { profileId, aliases: new Set([profileId]), role: null },
  };
}

export function context(config: OpenClawConfig = {}): GatewayRequestContext {
  setRuntimeConfigSnapshot(config);
  return {
    getRuntimeConfig: () => config,
    broadcast: vi.fn(),
    logGateway: { warn: vi.fn() },
  } as unknown as GatewayRequestContext;
}

let reactionProjection: ReturnType<typeof createSessionRowProjection> | undefined;

export const withReactionState = (consume: () => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    try {
      await consume();
    } finally {
      (await reactionProjection)?.dispose();
      reactionProjection = undefined;
    }
  });

export async function call(
  method: "session.reactions.set" | "session.reactions.list",
  params: Record<string, unknown>,
  requestClient: GatewayClient | null = client("alice", "Alice"),
  requestContext = context(),
  hasCurrentClientAuthority?: () => boolean,
) {
  if (!projectionAccess.getSessionRowProjection(requestContext)) {
    reactionProjection ??= createSessionRowProjection({ cfg: {}, modelCatalog: [] });
    const projection = await reactionProjection;
    projectionAccess.bindSessionRowProjection(requestContext, () => projection);
  }
  const respond = vi.fn<RespondFn>();
  await sessionReactionHandlers[method]?.({
    req: { type: "req", id: "reaction-request", method, params },
    params,
    client: requestClient,
    context: requestContext,
    hasCurrentClientAuthority,
    isWebchatConnect: () => true,
    respond,
  });
  expect(respond).toHaveBeenCalledOnce();
  return respond.mock.calls[0]!;
}

export function roleConfig(others: "none" | "view" | "suggest" | "write"): OpenClawConfig {
  const role: GatewayOperatorRoleDefinition = {
    sessions: { others },
    agents: "*" as const,
    scopes: ["operator.read", "operator.write"],
  };
  return { gateway: { roles: { default: "test-role", definitions: { "test-role": role } } } };
}

export function setReaction(
  messageId: string,
  params: Record<string, unknown> = {},
  ...request: [
    client?: GatewayClient | null,
    context?: GatewayRequestContext,
    authority?: () => boolean,
  ]
) {
  return call(
    "session.reactions.set",
    { sessionKey, messageId, emoji: "👍", ...params },
    ...request,
  );
}

export const listReactions = (
  requestClient?: GatewayClient | null,
  requestContext?: GatewayRequestContext,
  key = sessionKey,
) => call("session.reactions.list", { sessionKey: key }, requestClient, requestContext);

export async function seedSession(overrides: Partial<SessionEntry> = {}, key = sessionKey) {
  const entry = {
    ...profileSessionEntry(sessionId, 1, "owner"),
    ...overrides,
  } satisfies SessionEntry;
  await upsertSessionEntryCore({ agentId: "main", sessionKey: key }, entry);
  return { agentId: "main", sessionKey: key, sessionId: entry.sessionId };
}

export const appendMessage = async (
  message: Record<string, unknown> = {
    role: "user",
    content: [{ type: "text", text: "Riley's persisted prompt" }],
    __openclaw: { senderName: "Riley", senderUsername: "riley", senderId: "peer-riley" },
  },
  scope = transcriptScope,
) => (await appendTranscriptMessage(scope, { message })).messageId;
