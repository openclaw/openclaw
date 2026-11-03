import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import type { SessionGitHubStatusResult } from "../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../config/io.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { prepareUserGitHubConnection } from "../../state/user-github-connections.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRepositorySessionReadHost } from "../control-ui-session-pr-runtime.js";
import { installPublicationRpcFixture } from "../github-account-service.test-support.js";
import type { LegacyPersonalGitHubService } from "../github-oauth-lifecycle-host.types.js";
import type {
  RepositoryPublicationProvider,
  RepositoryPublicationApi,
} from "../repository-publication-contract.js";
import type { RepositorySessionPresentation } from "../repository-session-read.types.js";
import { handleGatewayRequest, createRequestGatewayMethodRegistry } from "../server-methods.js";
import { createContext } from "../server-plugin-in-process-dispatch.test-support.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";
import type { GatewayClient } from "./types.js";

export const publicationIdentity = await loadBundledPluginFacade<{
  prepareCurrentGitHubPublicationOptionsIdentity(
    agentId: string,
    assertCurrent?: () => void,
  ): Promise<
    NonNullable<
      Awaited<ReturnType<RepositoryPublicationProvider["readOptionsIdentity"]>>["identity"]
    >
  >;
}>({ pluginId: "github-repositories", artifactBasename: "publication-availability-api.ts" });

export const { clearNativeGitHubTokenCache } = await loadBundledPluginFacade<{
  clearNativeGitHubTokenCache(): void;
}>({ pluginId: "github-repositories", artifactBasename: "read-identity-api.ts" });
export const { resolveManagedGitHubProfileDir, writeManagedGitHubProfileFiles } =
  await loadBundledPluginFacade<{
    resolveManagedGitHubProfileDir(input: {
      agentId: string;
      scope: "system" | "agent" | "personal";
      profileId: string;
      env?: NodeJS.ProcessEnv;
    }): string;
    writeManagedGitHubProfileFiles(
      dir: string,
      identity: { login: string; token: string },
      options?: { assertCurrent(): void },
    ): Promise<void>;
  }>({ pluginId: "github-repositories", artifactBasename: "tool-identity-api.ts" });

export const sessionKey = "agent:main:publication-read";
export const sessionId = "publication-read-session";
export const publisher = { source: "agent-override" as const, accountId: 7, login: "shared-bot" };
export const publisherIdentity = () => ({
  source: publisher.source,
  host: "github.com",
  account: { accountId: publisher.accountId, login: publisher.login, avatarUrl: null },
});
export function mockPublicationIdentity() {
  vi.spyOn(publicationIdentity, "prepareCurrentGitHubPublicationOptionsIdentity").mockResolvedValue(
    publisherIdentity(),
  );
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

export type ReadFixture = Awaited<ReturnType<typeof createFixture>>;
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
  fixture: Awaited<ReturnType<typeof createFixture>>,
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
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  options: {
    personal?: boolean;
    scopes?: string[];
    others?: "none" | "view";
    foreign?: boolean;
    projection?: boolean;
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
    const fixture = await createFixture(profile, options.scopes);
    if (options.projection !== false) {
      await initializeSessionReadContext(fixture.context);
    }
    const profileCatalog = await prepareUserProfileCatalog();
    try {
      await run(fixture);
    } finally {
      // Vitest retains global restorers after mockRestore(); restore while managed handles live.
      vi.restoreAllMocks();
      await fixture.stopAccount();
      await fixture.readScheduler.stop();
      profileCatalog.release();
    }
  });
}

async function createFixture(
  profile?: ReturnType<typeof ensureProfileForEmail>,
  scopes = ["operator.read"],
) {
  const client: GatewayClient & { connId: string } = {
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
  const readScheduler = createTestGatewayScheduler();
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
  let personal: LegacyPersonalGitHubService | undefined = undefined;
  const personalConnectionStatus = vi.fn(
    async (action: Parameters<LegacyPersonalGitHubService["status"]>[0]) => {
      await prepareUserGitHubConnection(action.owner);
      return expectDefined(personal, "The registered personal account service").status(action);
    },
  );
  const preparePersonalAccountStatus: RepositoryPublicationApi["preparePersonalAccountStatus"] =
    async (action) => {
      const status = await personalConnectionStatus(action);
      return {
        status,
        assertCurrent() {
          action.assertCurrent();
          expectDefined(personal, "The registered personal account service").revalidateStatus(
            action,
            status,
          );
        },
      };
    };
  const context = createContext([], getRuntimeConfig);
  context.getClientConnIds = (filter) =>
    new Set(connected && (!filter || filter(client)) ? [client.connId] : []);
  const methods = createRequestGatewayMethodRegistry();
  context.getGatewayMethodRegistry = () => methods;
  context.resolveGatewayContext = () => context;
  const readHost = createRepositorySessionReadHost({
    signal: readScheduler.signal,
    getRuntimeConfig,
    getSessionRowProjection: () => getSessionRowProjection(context),
    getClient: (connId) => (connected && connId === client.connId ? client : undefined),
    resolveGatewayContext: () => context,
    broadcastToConnIds: vi.fn(),
  });
  context.repositorySessions = readHost;
  const boundPublication = { ...publication, preparePersonalAccountStatus };
  const account = await installPublicationRpcFixture(context, boundPublication);
  personal = account.oauth.personal;
  const personalLifecycle = personal;
  const presentation = expectDefined(readHost.presentation, "The registered PR presentation");
  const pullRequests = {
    unsubscribe: vi.spyOn(presentation, "unsubscribe"),
    read: vi
      .spyOn(presentation, "read")
      .mockImplementation(vi.fn<RepositorySessionPresentation["read"]>()),
    stop: vi.spyOn(presentation, "stop"),
  };
  const stopAccount = account.stop;
  const invoke = async (
    method: "sessions.github.options" | "sessions.github.status",
    params: Record<string, unknown>,
    respond = vi.fn(),
  ) => {
    await handleGatewayRequest({
      respond,
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
    publication: boundPublication,
    provider: account.provider,
    oauth: account.oauth,
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
    readScheduler,
    stopAccount,
    personalConnectionStatus,
    requestForSession: publication.requestForSessionV2,
    pullRequests,
    disconnect: () => {
      connected = false;
    },
  };
}
