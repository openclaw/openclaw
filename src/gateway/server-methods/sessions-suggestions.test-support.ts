import { afterEach, beforeEach, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  identifiedClient,
  initializeSessionReadContext,
} from "./sessions-read-cache.test-support.js";
import { sessionSuggestionHandlers } from "./sessions-suggestions.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export const sessionKey = "agent:main:main";

const defaultSuggestionSession = {
  sessionId: "session-main",
  updatedAt: 1,
  createdActor: { type: "human", source: "profile", id: "owner" },
  visibility: "suggest",
} as const;

export function upsertDefaultSuggestionSession(
  patch: Parameters<typeof upsertSessionEntryCore>[1] = {},
  key = sessionKey,
) {
  return upsertSessionEntryCore(
    { agentId: "main", sessionKey: key },
    { ...defaultSuggestionSession, ...patch },
  );
}

export function withSuggestionState(
  run: Parameters<typeof withOpenClawTestState>[1],
  options: { prepareProfileCatalog?: boolean } = {},
) {
  return withOpenClawTestState({ scenario: "minimal", ...options }, async (state) => {
    setRuntimeConfigSnapshot({});
    await run(state);
  });
}

export function client(profileId: string, displayName: string, admin = false): GatewayClient {
  const result = identifiedClient(profileId);
  result.connId = `conn-${profileId}`;
  result.connect.client.instanceId = `instance-${profileId}`;
  result.connect.scopes = admin ? ["operator.admin"] : ["operator.read", "operator.write"];
  result.authenticatedUserId = `${profileId}@example.com`;
  result.authenticatedUserProfile = { profileId, displayName, hasAvatar: false, updatedAt: 1 };
  return result;
}

export function context(
  broadcast = vi.fn(),
  runtimeConfig: ReturnType<GatewayRequestContext["getRuntimeConfig"]> = {},
): GatewayRequestContext {
  return {
    getRuntimeConfig: () => runtimeConfig,
    broadcast,
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
    logGateway: { warn: vi.fn() },
  } as unknown as GatewayRequestContext;
}

export async function call(
  method:
    | "session.suggestions.add"
    | "session.suggestions.list"
    | "session.suggestions.resolve"
    | "session.typing",
  params: Record<string, unknown>,
  requestClient: GatewayClient | null,
  requestContext = context(),
) {
  await initializeSessionReadContext(requestContext);
  const responses: Parameters<RespondFn>[] = [];
  await sessionSuggestionHandlers[method]?.({
    req: { type: "req", id: "request-1", method, params },
    params,
    client: requestClient,
    context: requestContext,
    isWebchatConnect: () => true,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  });
  return { responses, context: requestContext };
}

export function requests(
  key: string,
  requester: Parameters<typeof call>[2],
  requestContext = context(),
  scope: Record<string, unknown> = {},
) {
  return (method: Parameters<typeof call>[0], params: Record<string, unknown> = {}) =>
    call(method, { sessionKey: key, ...scope, ...params }, requester, requestContext);
}

export function responseSuggestionId(result: Awaited<ReturnType<typeof call>>): string {
  const payload = result.responses[0]?.[1] as { suggestion?: { id?: string } } | undefined;
  if (!payload?.suggestion?.id) {
    throw new Error("suggestion response id missing");
  }
  return payload.suggestion.id;
}

export function registerSessionSuggestionTestLifecycle(mocks: {
  handleChatSend: ReturnType<typeof vi.fn>;
  suggestionMutationFailure?: string;
  presence: unknown[];
}): void {
  beforeEach(() => {
    mocks.handleChatSend.mockReset();
    mocks.handleChatSend.mockImplementation(({ respond }: { respond: RespondFn }) => {
      respond(true, { runId: "suggestion-run", status: "started" });
    });
    mocks.suggestionMutationFailure = undefined;
    mocks.presence = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
  });
}
