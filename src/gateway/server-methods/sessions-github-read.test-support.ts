import { vi } from "vitest";
import type { SessionGitHubStatusResult } from "../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { getRuntimeConfig } from "../../config/io.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createPersonalGitHubOAuthLifecycle,
  personalGitHubStatusAsync as personalGitHubStatus,
  type PersonalGitHubAction,
} from "../github-personal-oauth.js";
import { handleGatewayRequest } from "../server-methods.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export const sessionKey = "agent:main:publication-read";
export const sessionId = "publication-read-session";
export const publisher = { source: "agent-override" as const, accountId: 7, login: "shared-bot" };
export const receipt = {
  result: {
    requestId: "8c698e8a-bdc7-4927-a0f2-73a842c2d7b1",
    publisher,
    status: "publishing" as const,
    message: "The shared publication is in progress.",
  },
  confirmation: null,
};

export async function withReadFixture(
  run: (fixture: ReturnType<typeof createFixture>) => Promise<void>,
  options: {
    personal?: boolean;
    scopes?: string[];
    others?: "none" | "view";
    foreign?: boolean;
  } = {},
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    if (options.scopes) {
      await state.writeConfig({
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              blocked: { scopes: [], sessions: { others: "none" }, agents: [] },
              guest: {
                scopes: options.scopes,
                sessions: { others: options.others ?? "view" },
                agents: ["main"],
              },
            },
          },
        },
      });
    }
    const profile = options.personal
      ? ensureProfileForEmail("publication-reader@example.test")
      : undefined;
    const creator = options.foreign
      ? ensureProfileForEmail("other-publication-reader@example.test")
      : profile;
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId,
        updatedAt: 1,
        ...(creator
          ? { createdActor: { type: "human", source: "profile", id: creator.id } as const }
          : {}),
      },
    );
    const fixture = createFixture(profile, options.scopes);
    const profileCatalog = await prepareUserProfileCatalog();
    try {
      await run(fixture);
    } finally {
      await fixture.personalLifecycle.stop();
      profileCatalog.release();
    }
  });
}

function createFixture(
  profile?: ReturnType<typeof ensureProfileForEmail>,
  scopes = ["operator.read"],
) {
  const client: GatewayClient = {
    connId: "publication-reader",
    ...(profile
      ? {
          authenticatedUserProfile: {
            profileId: profile.id,
            displayName: profile.displayName,
            hasAvatar: false,
            updatedAt: profile.updatedAt,
          },
        }
      : {}),
    connect: {
      role: "operator",
      scopes,
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "test", mode: "test", platform: "test", version: "1" },
    },
  };
  let connected = true;
  const sharedStatus = vi.fn().mockResolvedValue(receipt);
  const latestShared = vi.fn().mockResolvedValue(receipt);
  const personalStatus = vi.fn();
  const preparePersonalStatus = vi.fn(async () => undefined);
  const personalPending = vi
    .fn<() => Promise<SessionGitHubStatusResult | null>>()
    .mockResolvedValue(null);
  const personalLifecycle = createPersonalGitHubOAuthLifecycle();
  const personalConnectionStatus = vi.fn(async (action: PersonalGitHubAction) =>
    personalGitHubStatus(action),
  );
  const requestForSession = vi.fn();
  const pullRequests = { subscribe: vi.fn(), unsubscribe: vi.fn(), read: vi.fn(), stop: vi.fn() };
  // Only these services belong to the read handler; the authorization helpers stay real.
  const context = {
    getRuntimeConfig,
    controlUiSessionPullRequests: pullRequests,
    getClientConnIds: (filter?: (candidate: GatewayClient) => boolean) =>
      new Set(connected && (!filter || filter(client)) ? [client.connId] : []),
    githubPublicationService: {
      preparePersonalStatus,
      sharedStatus,
      latestShared,
      personalStatusAsync: personalStatus,
      personalPending,
      requestForSessionV2: requestForSession,
    },
    githubOAuthService: {
      personal: {
        ...personalLifecycle,
        status: personalConnectionStatus,
      },
    },
  } as unknown as GatewayRequestContext;
  const invoke = async (
    method: "sessions.github.options" | "sessions.github.status",
    params: Record<string, unknown>,
    respond = vi.fn(),
  ) => {
    await handleGatewayRequest({
      respond: respond as never,
      context,
      client,
      req: { type: "req", id: "publication-read", method, params },
      isWebchatConnect: () => false,
    });
    return respond;
  };
  return {
    client,
    context,
    invoke,
    sharedStatus,
    latestShared,
    personalStatus,
    preparePersonalStatus,
    personalPending,
    personalLifecycle,
    personalConnectionStatus,
    requestForSession,
    pullRequests,
    disconnect: () => {
      connected = false;
    },
  };
}
