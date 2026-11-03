// Register synthetic I/O before the actual plugin identity and publication graph loads.
// oxfmt-ignore
import {
  SESSION_ID,
  SESSION_KEY,
  createTestGitHubPublicationCoordinator,
  githubPublicationTestMocks,
  overrideCommands,
} from "./github-publication.test-support.js";
import { randomUUID } from "node:crypto";
import { afterEach, expect, onTestFinished, vi } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { updateUserGitHubConnection } from "../state/user-github-connections.test-support.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { installPublicationRpcFixture } from "./github-account-service.test-support.js";
import type { PersonalGitHubSessionActionV2 } from "./github-personal-publication.js";
import { resolveGatewayOperatorAccessAuthority } from "./operator-access-policy.js";
import { handleGatewayRequest } from "./server-methods.js";
import { preparePersonalGitHubSessionActionV2 } from "./server-methods/github-personal-authorization.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { gatewayConnect, gatewayProfile } from "./server/client-fixtures.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const { resolveManagedGitHubProfileDir, writeManagedGitHubProfileFiles } =
  await loadBundledPluginFacade<{
    resolveManagedGitHubProfileDir(params: {
      agentId: string;
      scope: "system" | "agent" | "personal";
      profileId: string;
      env?: NodeJS.ProcessEnv;
    }): string;
    writeManagedGitHubProfileFiles(
      dir: string,
      identity: { login: string; token: string },
      options?: { assertCurrent: () => void },
    ): Promise<void>;
  }>({ pluginId: "github-repositories", artifactBasename: "tool-identity-api.ts" });

const mocks = githubPublicationTestMocks();
export const personalPublicationAccount = { accountId: 101, login: "personal-alice" };
const account = personalPublicationAccount;
const profileId = "ghp_22222222222222222222222222222222";
type PersonalFixture = Awaited<ReturnType<typeof createPersonalPublicationFixture>>;
type PersonalClient = { client: GatewayClient; context: GatewayRequestContext };
const profileCatalogs = new Set<Awaited<ReturnType<typeof prepareUserProfileCatalog>>>();
afterEach(() => {
  for (const catalog of profileCatalogs) {
    catalog.release();
  }
  profileCatalogs.clear();
});

/** Gateway startup prepares profile authority again after database admission closes. */
export async function preparePersonalPublicationProfileCatalog() {
  const catalog = await prepareUserProfileCatalog();
  profileCatalogs.add(catalog);
  return catalog;
}

export async function preparePersonalPublicationFixtureV2(
  fixture: PersonalClient,
  signal?: AbortSignal,
) {
  const owner = fixture.client.authenticatedUserProfile!.profileId;
  fixture.client.internal = {
    ...fixture.client.internal,
    operatorAccessAuthority: resolveGatewayOperatorAccessAuthority(
      owner,
      fixture.context.getRuntimeConfig(),
    ),
  };
  const prepared = await preparePersonalGitHubSessionActionV2(
    { ...fixture, signal },
    { sessionKey: SESSION_KEY },
  );
  onTestFinished(prepared.release);
  return prepared.action;
}

export const preparePersonalPublicationFixtureAction = preparePersonalPublicationFixtureV2;

export function readPersonalPublicationFixtureStatus(
  fixture: Pick<PersonalFixture, "coordinator" | "action">,
  requestId: string,
) {
  return fixture.coordinator.personalStatusAsync(
    fixture.action,
    {
      sessionKey: SESSION_KEY,
      agentId: "main",
      sessionId: SESSION_ID,
      lifecycleRevision: fixture.action.lifecycleRevision,
    },
    requestId,
    undefined,
  );
}

export function personalPublicationRequest(
  { generation }: { generation: string },
  idempotencyKey: string,
) {
  return {
    sessionKey: SESSION_KEY,
    idempotencyKey,
    selection: { source: "personal" as const, generation, account },
  };
}

export async function expectPersonalPublicationReplay(
  {
    generation,
    coordinator,
    action,
  }: Pick<PersonalFixture, "coordinator"> & {
    generation: string;
    action: PersonalGitHubSessionActionV2;
  },
  capture: (requestId: string) => unknown,
) {
  const request = personalPublicationRequest({ generation }, "personal-replay");
  const { selection } = request;
  const publish = (input: Parameters<typeof coordinator.requestPersonalForSessionV2>[0]) =>
    coordinator.requestPersonalForSessionV2(input, action);
  const published = await publish(request);
  expect(published.status).toBe("published");
  const before = capture(published.requestId);
  await expect(
    publish({
      ...request,
      selection: { ...selection, account: { ...account, login: account.login.toUpperCase() } },
    }),
  ).resolves.toEqual(published);
  for (const changed of [
    { ...request, selection: { ...selection, generation: `${generation}-changed` } },
    {
      ...request,
      selection: { ...selection, account: { ...account, accountId: account.accountId + 1 } },
    },
    { ...request, selection: { ...selection, account: { ...account, login: "different-user" } } },
    { ...request, title: "Different title" },
    { ...request, body: "Different body" },
  ]) {
    await expect(publish(changed)).rejects.toThrow(
      "My GitHub publication idempotency key was reused with a different selection.",
    );
  }
  expect(capture(published.requestId)).toEqual(before);
}

export async function createPersonalPublicationFixture() {
  const owner = (await ensureCanonicalUserProfileForEmail("alice@example.test")).id;
  const otherOwner = (await ensureCanonicalUserProfileForEmail("bob@example.test")).id;
  const profileCatalog = await preparePersonalPublicationProfileCatalog();
  const generation = randomUUID();
  const personalToken = `synthetic-personal-credential-${generation}`;
  updateUserGitHubConnection(
    owner,
    () => ({
      version: 1,
      generation,
      selection: {
        kind: "connected",
        profileId,
        ...account,
        refreshToken: "synthetic-refresh",
        accessExpiresAtMs: Date.now() + 3600000,
        refreshExpiresAtMs: Date.now() + 86400000,
        scopes: ["repo"],
      },
    }),
    () => {},
  );
  const dir = resolveManagedGitHubProfileDir({ scope: "personal", agentId: "", profileId });
  await writeManagedGitHubProfileFiles(dir, { login: account.login, token: personalToken });
  const fetchMock = vi.fn<typeof fetch>(async (url, options) => {
    if (
      url !== "https://api.github.com/user" ||
      new Headers(options?.headers).get("Authorization") !== `Bearer ${personalToken}`
    ) {
      throw new Error("Unexpected credential HTTP request");
    }
    return Response.json({
      id: runtime.verifiedAccount.accountId,
      login: runtime.verifiedAccount.login,
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  overrideCommands((argv) => {
    if (argv[0] === "gh" && (argv[1] !== "api" || argv.includes("user"))) {
      throw new Error("Unexpected GitHub CLI credential operation");
    }
  });
  const client: GatewayClient = {
    connId: `direct-human-${generation}`,
    authenticatedUserProfile: gatewayProfile(owner),
    connect: gatewayConnect(["operator.write", "operator.read"], {
      id: "test",
      mode: "test",
      version: "1",
    }),
  };
  const runtime = { live: true, verifiedAccount: account, client };
  const config: OpenClawConfig = {};
  const context = createContext([], () => config);
  context.getClientConnIds = (filter) =>
    new Set(runtime.live && (!filter || filter(runtime.client)) ? [runtime.client.connId!] : []);
  const action = await preparePersonalPublicationFixtureAction({ client, context });
  const placements = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
  const coordinator = createTestGitHubPublicationCoordinator({ placements });
  return {
    owner,
    profileCatalog,
    otherOwner,
    generation,
    runtime,
    client,
    config,
    context,
    action,
    placements,
    coordinator,
  };
}

export async function callPersonalPublicationRpc(
  { client, context, coordinator }: Pick<PersonalFixture, "client" | "context" | "coordinator">,
  method: string,
  params: Record<string, unknown> = { sessionKey: SESSION_KEY },
) {
  const respond = vi.fn();
  const rpcContext = { ...context };
  rpcContext.resolveGatewayContext = () => rpcContext;
  const installedAccount = await installPublicationRpcFixture(rpcContext, coordinator);
  try {
    await handleGatewayRequest({
      req: { type: "req", id: randomUUID(), method, params },
      client,
      context: rpcContext,
      respond,
      isWebchatConnect: () => false,
    });
    return respond.mock.calls[0]!;
  } finally {
    await installedAccount.stop();
  }
}

export async function restartPersonalPublicationFixture(fixture: PersonalFixture) {
  const previous = fixture.placements;
  resetGatewayWorkAdmission();
  await closeOpenClawAgentDatabasesAsync();
  fixture.profileCatalog.release();
  fixture.profileCatalog = await preparePersonalPublicationProfileCatalog();
  fixture.placements = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
  await fixture.placements.recoverWorkerSessionToolOperationsAfterRestart();
  await fixture.placements.clearLocalTurnClaimsAfterRestartAsync();
  expect(fixture.placements.workspaceResultInstanceId()).not.toBe(
    previous.workspaceResultInstanceId(),
  );
  fixture.coordinator = createTestGitHubPublicationCoordinator({ placements: fixture.placements });
  fixture.action = await preparePersonalPublicationFixtureAction(fixture);
}

export async function createForeignPublicationSession(otherOwner: string, incognito = false) {
  const entry = {
    sessionId: SESSION_ID,
    updatedAt: Date.now(),
    visibility: "draft" as const,
    ...(incognito ? { incognito: true as const } : {}),
    createdActor: { type: "human" as const, source: "profile" as const, id: otherOwner },
  };
  await upsertSessionEntryCore({ agentId: "main", sessionKey: SESSION_KEY }, entry);
  const original = mocks.loadSession.getMockImplementation()!;
  mocks.loadSession.mockImplementation((key: string) => ({
    ...original(key),
    entry: { ...original(key).entry, ...entry },
  }));
}

export function createPersonalPublicationRequests(generation: () => string) {
  return {
    request: () => personalPublicationRequest({ generation: generation() }, "personal-publish"),
    confirmation: (requestId: string, requestDigest: string) => ({
      sessionKey: SESSION_KEY,
      requestId,
      requestDigest,
      generation: generation(),
      account,
    }),
  };
}
