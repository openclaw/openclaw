import { expect, vi } from "vitest";
import type { SessionGitHubStatusResult } from "../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../config/io.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { prepareUserGitHubConnection } from "../../state/user-github-connections.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createPersonalGitHubOAuthLifecycle,
  type PersonalGitHubAction,
} from "../github-personal-oauth.js";
import { personalGitHubStatusAsync as personalGitHubStatus } from "../github-personal-status.js";
import * as publicationAvailability from "../github-publication-availability.js";
import { handleGatewayRequest } from "../server-methods.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export const sessionKey = "agent:main:publication-read";
export const sessionId = "publication-read-session";
export const publisher = { source: "agent-override" as const, accountId: 7, login: "shared-bot" };
export const publisherIdentity = () => ({
  source: publisher.source,
  host: "github.com",
  account: { accountId: publisher.accountId, login: publisher.login, avatarUrl: null },
});
export function mockPublicationIdentity() {
  vi.spyOn(
    publicationAvailability,
    "prepareCurrentGitHubPublicationOptionsIdentity",
  ).mockResolvedValue(publisherIdentity());
}
export const receipt = {
  result: {
    requestId: "8c698e8a-bdc7-4927-a0f2-73a842c2d7b1",
    publisher,
    status: "publishing" as const,
    message: "The shared publication is in progress.",
  },
  confirmation: null,
};

export type ReadFixture = ReturnType<typeof createFixture>;
const avatarUrl = (accountId: number) => `https://avatars.githubusercontent.com/u/${accountId}?v=4`;
export const optionsResult = (overrides: Record<string, unknown> = {}) => {
  const personalAccount = (overrides.personal as { account?: { accountId: number } } | undefined)
    ?.account;
  const avatarUrls = {
    ...(overrides.shared === null ? {} : { shared: avatarUrl(publisher.accountId) }),
    ...(personalAccount ? { personal: avatarUrl(personalAccount.accountId) } : {}),
  };
  return {
    personal: null,
    shared: publisher,
    ...(Object.keys(avatarUrls).length ? { avatarUrls } : {}),
    pendingPersonal: null,
    latestShared: receipt,
    ...overrides,
  };
};
export const expectReply = (respond: unknown, result: unknown) =>
  expect(respond).toHaveBeenCalledWith(true, result);
export const expectFailure = (
  respond: unknown,
  detail: Record<string, unknown> = { code: "FORBIDDEN" },
) => expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(detail));
export function expectNoCalls(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}
export function expectNoPersonalReads(fixture: ReadFixture) {
  expectNoCalls(
    fixture.personalConnectionStatus,
    fixture.personalPending,
    fixture.preparePersonalStatus,
    fixture.personalStatus,
    fixture.requestForSession,
  );
}

export async function withHeldReceipt(
  fixture: ReturnType<typeof createFixture>,
  source: "personal" | "shared" | "status",
  run: (
    respond: ReturnType<typeof vi.fn>,
    release: (value: SessionGitHubStatusResult | null) => Promise<void>,
  ) => Promise<void>,
  ready: Promise<unknown> = Promise.resolve(),
) {
  const entered = createDeferredCore();
  const pending = createDeferredCore<SessionGitHubStatusResult | null>();
  const read = {
    personal: fixture.personalPending,
    shared: fixture.latestShared,
    status: fixture.sharedStatus,
  }[source];
  read.mockImplementationOnce(() => {
    entered.resolve();
    return pending.promise;
  });
  const respond = vi.fn();
  const request = source === "status" ? fixture.status(respond) : fixture.options(respond);
  try {
    await awaitGateBeforeSettlement(
      Promise.all([entered.promise, ready]),
      request,
      "Receipt completed before the held read was ready",
    );
    expect(respond).not.toHaveBeenCalled();
    await run(respond, async (value) => {
      pending.resolve(value);
      await request;
    });
    if (source !== "personal") {
      expect(read).toHaveBeenCalledOnce();
    }
  } finally {
    pending.resolve(source === "status" ? receipt : null);
    await request;
  }
}

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
    await captureRuntimeConfigAsyncReader()();
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
    connect: gatewayConnect(scopes, { id: "test", mode: "test", version: "1" }),
  };
  if (profile) {
    client.authenticatedUserProfile = gatewayProfile(
      profile.id,
      profile.displayName,
      profile.updatedAt,
    );
  }
  let connected = true;
  const publication = {
    sharedStatus: vi.fn().mockResolvedValue(receipt),
    latestShared: vi.fn().mockResolvedValue(receipt),
    personalStatusAsync: vi.fn(),
    preparePersonalStatus: vi.fn(async () => undefined),
    personalPending: vi
      .fn<() => Promise<SessionGitHubStatusResult | null>>()
      .mockResolvedValue(null),
    requestForSessionV2: vi.fn(),
  };
  const personalLifecycle = createPersonalGitHubOAuthLifecycle();
  const personalConnectionStatus = vi.fn(async (action: PersonalGitHubAction) => {
    await prepareUserGitHubConnection(action.owner);
    return personalGitHubStatus(action);
  });
  const pullRequests = { subscribe: vi.fn(), unsubscribe: vi.fn(), read: vi.fn(), stop: vi.fn() };
  // Only these services belong to the read handler; the authorization helpers stay real.
  const context = {
    getRuntimeConfig,
    controlUiSessionPullRequests: pullRequests,
    getClientConnIds: (filter?: (candidate: GatewayClient) => boolean) =>
      new Set(connected && (!filter || filter(client)) ? [client.connId] : []),
    githubPublicationService: publication,
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
    options: (respond = vi.fn(), params: Record<string, unknown> = {}) =>
      invoke("sessions.github.options", { sessionKey, ...params }, respond),
    status: (respond = vi.fn()) =>
      invoke(
        "sessions.github.status",
        { sessionKey, requestId: receipt.result.requestId },
        respond,
      ),
    ...publication,
    personalStatus: publication.personalStatusAsync,
    personalLifecycle,
    personalConnectionStatus,
    requestForSession: publication.requestForSessionV2,
    pullRequests,
    disconnect: () => {
      connected = false;
    },
  };
}
