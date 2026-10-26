import { fileURLToPath } from "node:url";
import { expect, onTestFinished, vi, type Mock } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import type { OpenClawPluginToolContext } from "../plugins/types.js";
import { decodeGitHubPublicationRequester } from "../state/github-publication-requester.js";
import { readGitHubPublicationSessionLifecycle } from "../state/github-publication-session-lifecycles.worker.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { listProfiles } from "../state/user-profile-reads.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { createVisitorAccessPluginConfig } from "../test-utils/visitor-access-config.test-support.js";
import { currentGitHubPublicationConfig } from "./github-publication-availability.js";
import { prepareGitHubPublicationRequesterV2 } from "./github-publication-requester.js";
import { readRepositoryGitHubPublicationFixture as readRepositoryGitHubPublication } from "./github-publication-store.test-support.js";
import { readGitHubPublicationRequest } from "./github-publication-store.worker.js";
import {
  createRealPublicationWorkspace,
  createTestGitHubPublicationCoordinator,
  githubPublicationTestMocks,
  persistPublicationTestSession,
  root,
} from "./github-publication.test-support.js";
import { repositoryGitHubPublicationDigest } from "./github-repository-publication-store.js";
import { createRepositoryPublicationFixture } from "./github-repository-publication.test-support.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { SESSION_READ_SCOPE, SESSION_WRITE_SCOPE } from "./operator-scopes.js";
import {
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "./worker-environments/placement-test-fixtures.js";

const mocks = githubPublicationTestMocks();

type Backend = "local" | "repository";
type Coordinator = ReturnType<typeof createTestGitHubPublicationCoordinator>;
type Requester = NonNullable<Parameters<Coordinator["requestForSessionV2"]>[0]["requester"]>;
export const guestScopes = [SESSION_READ_SCOPE, SESSION_WRITE_SCOPE];
export const publicationGuestEmail = "publication-guest@example.test";
export const publicationBackends = ["local", "repository"] as const;
export const forPublicationBackends = <T extends string>(changes: readonly T[]) =>
  publicationBackends.flatMap((backend) => changes.map((change) => ({ backend, change })));

export function createPublicationRepositories(fork = false) {
  const baseRepo = {
    id: 10,
    full_name: "openclaw/openclaw",
    private: false,
    archived: false,
    owner: { type: "Organization" },
    permissions: { push: true },
  };
  const headRepo = fork
    ? {
        ...baseRepo,
        id: 20,
        full_name: "contributor/openclaw",
        owner: { type: "User" },
        permissions: { push: false },
      }
    : baseRepo;
  return { baseRepo, headRepo };
}

export function capturePublicationGuest(
  f: Awaited<ReturnType<typeof createRequesterPolicyFixture>>,
) {
  return createGitHubPublicationRequesterFixture({
    profileId: f.guestProfile,
    scopes: guestScopes,
    ...f.guestSource.session,
  });
}

export async function startVisitorPublicationFixture(
  f: Parameters<typeof prepareVisitorPublicationFixture>[0],
) {
  const visitors = await prepareVisitorPublicationFixture(f);
  try {
    await visitors.start();
    await visitors.execute("visitor_invite", { email: publicationGuestEmail, days: 1 });
    return Object.assign(visitors, { [Symbol.asyncDispose]: () => visitors.close() });
  } catch (error) {
    await visitors.close();
    throw error;
  }
}

export async function queueGuestPublication(
  f: Awaited<ReturnType<typeof createRequesterPublicationFixture>>,
  key: string,
  claimBound = false,
) {
  const original = await capturePublicationGuest(f);
  const claim =
    claimBound && f.backend === "local"
      ? await f.placements.claimTurn({
          ...f.session,
          agentId: "main",
          owner: { kind: "local" },
          claimId: "immediate-alias-retry-claim",
          runId: "immediate-alias-retry-run",
        })
      : await holdWorkerTurn(f);
  const input = f.request(key, original.requester);
  const queued = claimBound
    ? await f.coordinator.requestForClaimV2({ ...input, claim })
    : await f.coordinator.requestForSessionV2(input);
  expect(queued.status).toBe("requested");
  return { original, claim, input, queued };
}

export async function resumePublicationFixture(
  f: Awaited<ReturnType<typeof createRequesterPublicationFixture>>,
) {
  const restarted = f.restart();
  await restarted.resumeSessionRequests();
  return restarted;
}

export async function createGitHubPublicationRequesterFixture(params: {
  profileId: string;
  scopes: readonly string[];
  sessionKey: string;
  agentId: string;
  getCommittedRuntimeConfig?: () => OpenClawConfig;
}) {
  const [{ createOperatorWsClient }, { prepareGatewayConnectOperatorAccess }] = await Promise.all([
    import("./server/ws-connection/authenticated-request-dispatch.test-support.js"),
    import("./server/ws-connection/connect-operator-access.js"),
  ]);
  const client = createOperatorWsClient({
    connId: params.profileId,
    scopes: [...params.scopes],
  });
  client.authenticatedUserProfile = {
    profileId: params.profileId,
    displayName: null,
    avatarRevision: "fixture",
    hasAvatar: false,
    updatedAt: 1,
  };
  prepareGatewayConnectOperatorAccess(client);
  const context = {
    getRuntimeConfig: currentGitHubPublicationConfig,
    getCommittedRuntimeConfig: params.getCommittedRuntimeConfig ?? currentGitHubPublicationConfig,
  };
  const session = { sessionKey: params.sessionKey, agentId: params.agentId };
  const captured = await prepareGitHubPublicationRequesterV2({ client, context }, session);
  onTestFinished(captured.release);
  return { ...captured, client, context, session };
}

async function createRequesterPolicySources(
  session: { sessionId: string; sessionKey: string },
  workspace: string,
) {
  const guestProfile = (await ensureCanonicalUserProfileForEmail(publicationGuestEmail)).id;
  const maintainerProfile = (
    await ensureCanonicalUserProfileForEmail("publication-maintainer@example.test")
  ).id;
  await setCanonicalUserProfileRole(maintainerProfile, "maintainer");
  invalidateOperatorRolePolicy(maintainerProfile);
  const config: OpenClawConfig = {
    agents: { entries: { main: { workspace } } },
    session: { maintenance: { mode: "warn" } },
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: { sessions: { others: "view" }, agents: ["main"], scopes: guestScopes },
          maintainer: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
          revoked: { sessions: { others: "none" }, agents: [], scopes: [] },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(config);
  expect(
    loadSessionEntryReadOnly({ agentId: "main", sessionKey: session.sessionKey }),
  ).toMatchObject({
    createdActor: { type: "human", source: "profile", id: guestProfile },
  });
  const capture = (profileId: string, scopes: readonly string[]) =>
    createGitHubPublicationRequesterFixture({
      profileId,
      scopes,
      sessionKey: session.sessionKey,
      agentId: "main",
    });
  const guestSource = await capture(guestProfile, guestScopes);
  const maintainerSource = await capture(maintainerProfile, ["operator.admin"]);
  const database = openOpenClawStateDatabase();
  const publishedTitles: string[] = [];
  const externalWrites: string[] = [];
  const transport = mocks.runCommand.getMockImplementation()!;
  mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
    if (argv.includes("push") || argv.includes("POST") || argv.includes("graphql")) {
      externalWrites.push(argv.join(" "));
    }
    if (argv.includes("POST") && argv.some((arg) => arg.endsWith("/pulls"))) {
      publishedTitles.push(JSON.parse(options!.input!).title);
    }
    return await transport(argv, options);
  });
  return {
    config,
    session,
    database,
    guest: guestSource.requester,
    guestSource,
    guestProfile,
    maintainer: maintainerSource.requester,
    maintainerSource,
    maintainerProfile,
    publishedTitles,
    externalWrites,
    async revoke() {
      await setCanonicalUserProfileRole(guestProfile, "revoked");
      invalidateOperatorRolePolicy(guestProfile);
    },
  };
}

export async function createRequesterPolicyFixture(
  session: { sessionId: string; sessionKey: string } = REQUEST,
) {
  await persistPublicationTestSession(session.sessionKey);
  return await createRequesterPolicySources(session, "/repo/worktree");
}

export async function createRequesterPublicationFixture(
  checkpoint: Mock,
  backend: Backend,
  session: { sessionId: string; sessionKey: string } = REQUEST,
  repositoryOptions: {
    requestedRef?: Parameters<typeof createRepositoryPublicationFixture>[1];
    baseFiles?: Record<string, string>;
  } = {},
) {
  const repository =
    backend === "repository"
      ? await createRepositoryPublicationFixture(
          checkpoint,
          repositoryOptions.requestedRef,
          session,
          repositoryOptions.baseFiles,
        )
      : undefined;
  await persistPublicationTestSession(session.sessionKey);
  const local =
    backend === "local"
      ? await createRealPublicationWorkspace(undefined, session.sessionKey)
      : undefined;
  const policy = await createRequesterPolicySources(session, local?.cwd ?? "/repo/worktree");
  const placements =
    repository?.placements ?? createWorkerSessionPlacementStore({ database: policy.database });
  const coordinator = createTestGitHubPublicationCoordinator({ placements });
  const request = (idempotencyKey: string, requester: Requester, title = idempotencyKey) => ({
    sessionKey: session.sessionKey,
    agentId: "main",
    idempotencyKey,
    title,
    requester,
  });
  return {
    ...policy,
    backend,
    local,
    repository,
    placements,
    coordinator,
    request,
    restart() {
      return createTestGitHubPublicationCoordinator({
        placements: createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() }),
      });
    },
    readReceipt(requestId: string) {
      return backend === "repository"
        ? readRepositoryGitHubPublication(requestId)
        : readGitHubPublicationRequest(openOpenClawStateDatabase().db, { requestId });
    },
    readRequester(requestId: string) {
      return decodeGitHubPublicationRequester(
        backend === "repository"
          ? readRepositoryGitHubPublication(requestId)?.requester_authority_json
          : readGitHubPublicationSessionLifecycle(
              { publicationKind: "shared", requestId },
              openOpenClawStateDatabase().db,
            )?.requester_authority_json,
      );
    },
    removeRequesterSnapshot(requestId: string) {
      runOpenClawStateWriteTransaction(({ db }) => {
        if (backend === "repository") {
          const row = readRepositoryGitHubPublication(requestId)!;
          db.prepare(
            "UPDATE github_repository_publication_requests SET requester_authority_json = NULL, request_digest = ? WHERE request_id = ?",
          ).run(
            repositoryGitHubPublicationDigest({ ...row, requester_authority_json: null }),
            requestId,
          );
          return;
        }
        db.prepare(
          "UPDATE github_publication_session_lifecycles SET requester_authority_json = NULL WHERE publication_kind = 'shared' AND request_id = ?",
        ).run(requestId);
      });
    },
  };
}

export async function holdWorkerTurn(
  f: Awaited<ReturnType<typeof createRequesterPublicationFixture>>,
) {
  const owner = { environmentId: "requester-worker", ownerEpoch: 2 };
  seedAttachedPlacementEnvironment(f.database, { ...owner, sessionId: REQUEST.sessionId });
  await seedActivePlacement(f.placements, owner);
  return f.placements.claimTurn({
    sessionId: REQUEST.sessionId,
    sessionKey: REQUEST.sessionKey,
    agentId: "main",
    claimId: "requester-claim",
    runId: "requester-run",
    owner: { kind: "worker", ...owner },
  });
}

type StoredVisitorGrant = {
  grantId: string;
  email: string;
  createdAt: number;
  expiresAt: number | null;
};

export function requireVisitorPublicationPolicy(f: { config: OpenClawConfig }): OpenClawConfig {
  const config = withPublicationGuestRole(f.config, {
    sandbox: "required" as const,
    accessPolicyPlugin: "visitor-access",
    modelPolicy: {},
  });
  setRuntimeConfigSnapshot(config);
  return config;
}

export function withPublicationGuestRole(
  config: OpenClawConfig,
  overrides: Partial<GatewayOperatorRoleDefinition>,
): OpenClawConfig {
  const roles = config.gateway!.roles!;
  return {
    ...config,
    gateway: {
      ...config.gateway,
      roles: {
        ...roles,
        definitions: { ...roles.definitions, guest: { ...roles.definitions.guest!, ...overrides } },
      },
    },
  };
}

export async function prepareVisitorPublicationFixture(f: {
  config: OpenClawConfig;
  session: { sessionKey: string };
  maintainer: Requester;
  local?: { cwd: string };
}) {
  const [loader, servicesRuntime, runtime, registryFactory] = await Promise.all([
    import("../plugins/loader.js"),
    import("../plugins/services.test-support.js"),
    import("../plugins/runtime.js"),
    import("../plugins/registry-empty.js"),
  ]);
  const config: OpenClawConfig = {
    ...requireVisitorPublicationPolicy(f),
    plugins: createVisitorAccessPluginConfig(
      "publication-test",
      "publication-test",
      "synthetic-publication-policy-token",
    ),
  };
  setRuntimeConfigSnapshot(config);
  const env = {
    ...process.env,
    OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../extensions/", import.meta.url)),
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
  };
  const workspaceDir = f.local?.cwd ?? root;
  const priorRegistry = runtime.captureActivePluginRegistrySnapshot();
  const policyUrl =
    "https://api.cloudflare.com/client/v4/accounts/publication-test/access/apps/publication-test/policies";
  let emails: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (!url.href.startsWith(policyUrl)) {
        throw new Error("Unexpected Visitor Access test request");
      }
      if (init?.method === "GET") {
        const policy = {
          id: "publication-visitors",
          name: "Visitors (openclaw-managed)",
          decision: "allow",
          include: emails.map((email) => ({ email: { email } })),
        };
        return Response.json({
          success: true,
          result: url.search ? (emails.length ? [policy] : []) : policy,
        });
      }
      if (init?.method === "DELETE") {
        emails = [];
      } else {
        if (typeof init?.body !== "string") {
          throw new Error("Expected the Visitor Access policy body");
        }
        const body = JSON.parse(init.body) as { include: Array<{ email: { email: string } }> };
        emails = body.include.map((entry) => entry.email.email);
      }
      return Response.json({ success: true, result: {} });
    }),
  );
  const unexpected = () => {
    throw new Error("Unexpected Visitor publication Gateway operation");
  };
  const gateway: PluginRuntime["gateway"] = {
    isAvailable: async () => true,
    openPluginPanel: unexpected,
    readSessionFacts: unexpected,
    withSessionFacts: unexpected,
    appendAgentMessage: unexpected,
    subscribeSessionChanges: unexpected,
    request: async () => unexpected(),
  };
  vi.spyOn(gateway, "request").mockImplementation(async (method) => {
    expect(method).toBe("users.list");
    return { profiles: await listProfiles() };
  });
  const toolContext: OpenClawPluginToolContext<2> = {
    sessionKey: f.session.sessionKey,
    agentId: "main",
    senderIsOwner: true,
    assertInvocationCurrent: f.maintainer.assertCurrent,
  };
  const register = async () => {
    const registry = await loader.loadAndActivateRootPluginRegistry({
      config,
      env,
      workspaceDir,
      onlyPluginIds: ["visitor-access"],
      preferBuiltPluginArtifacts: true,
      cache: false,
      runtimeOptions: {
        gateway,
        // Service node setup reads this host facet even when Visitor never invokes nodes.
        subagent: {
          complete: unexpected,
          forkSession: unexpected,
          run: unexpected,
          waitForRun: unexpected,
          getSessionMessages: unexpected,
          deleteSession: unexpected,
        },
      },
    });
    const loaded = registry.plugins.find(({ id }) => id === "visitor-access");
    expect(loaded, loaded?.error).toMatchObject({
      origin: "bundled",
      status: "loaded",
    });
    let services: PluginServicesHandle | undefined;
    return {
      store: createPluginStateKeyedStore<StoredVisitorGrant>("visitor-access", {
        namespace: "visitor-grants",
        maxEntries: 500,
        overflowPolicy: "reject-new",
        env,
      }),
      async start() {
        await servicesRuntime.startPluginServices({
          registry,
          config,
          workspaceDir,
          throwOnStartError: true,
          onHandle: (handle) => {
            services = handle;
          },
        });
      },
      async stop() {
        try {
          const stopped = await services?.stop({ strict: true });
          if (stopped) {
            expect(stopped.errors).toEqual([]);
          }
        } finally {
          await runtime.clearActivePluginRegistry(registry);
        }
      },
      async execute(name: "visitor_invite" | "visitor_revoke", input: Record<string, unknown>) {
        const registration = registry.tools.find(
          ({ pluginId, names }) => pluginId === "visitor-access" && names.includes(name),
        );
        if (!registration || registration.contextVersion !== 2) {
          throw new Error("Visitor Access did not register " + name + " with action authority");
        }
        const created = registration.factory(toolContext);
        const tool = (Array.isArray(created) ? created : created ? [created] : []).find(
          (candidate) => candidate.name === name,
        );
        if (!tool) {
          throw new Error("Visitor Access did not register " + name);
        }
        const result = await tool.execute("publication-" + name, input);
        expect(result).toMatchObject({ details: {} });
        expect(result).not.toMatchObject({ isError: true });
        return result;
      },
    };
  };
  let active = await register();
  const resetStores = async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  };
  return {
    get store() {
      return active.store;
    },
    start: () => active.start(),
    execute: (...args: Parameters<typeof active.execute>) => active.execute(...args),
    suspendRegistry() {
      const snapshot = runtime.captureActivePluginRegistrySnapshot();
      runtime.stageActivePluginRegistry(
        registryFactory.createEmptyPluginRegistry(),
        null,
        snapshot.runtimeSubagentMode,
        snapshot.workspaceDir ?? undefined,
      );
      return () => runtime.rollbackStagedPluginRegistry(snapshot);
    },
    async reopen() {
      await active.stop();
      await resetStores();
      active = await register();
    },
    async close() {
      try {
        await active.stop();
      } finally {
        runtime.restoreActivePluginRegistrySnapshot(priorRegistry);
        await resetStores();
        vi.unstubAllGlobals();
      }
    },
  };
}
