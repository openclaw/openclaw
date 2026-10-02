import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { expect, vi, type Mock } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import type { OpenClawPluginToolContext } from "../plugins/types.js";
import { decodeGitHubPublicationRequester } from "../state/github-publication-requester.js";
import { readGitHubPublicationSessionLifecycle } from "../state/github-publication-session-lifecycles.js";
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
import { currentGitHubPublicationConfig } from "./github-publication-availability.js";
import { readGitHubPublicationRequest } from "./github-publication-store.js";
import {
  createGitHubPublicationRequesterFixture,
  createRealPublicationWorkspace,
  createTestGitHubPublicationCoordinator,
  githubPublicationTestMocks,
  persistPublicationTestSession,
  root,
} from "./github-publication.test-support.js";
import {
  readRepositoryGitHubPublication,
  repositoryGitHubPublicationDigest,
} from "./github-repository-publication-store.js";
import { createRepositoryPublicationFixture } from "./github-repository-publication.test-support.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { SESSION_READ_SCOPE, SESSION_WRITE_SCOPE, WRITE_SCOPE } from "./operator-scopes.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareGatewayConnectOperatorAccess } from "./server/ws-connection/connect-operator-access.js";
import {
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "./worker-environments/placement-test-fixtures.js";

const mocks = githubPublicationTestMocks();

type Backend = "local" | "repository";
type Coordinator = ReturnType<typeof createTestGitHubPublicationCoordinator>;
type Requester = NonNullable<Parameters<Coordinator["requestForSession"]>[0]["requester"]>;
export const guestScopes = [SESSION_READ_SCOPE, SESSION_WRITE_SCOPE];
export const publisherScopes = [WRITE_SCOPE];

async function createRequesterPolicySources(
  session: { sessionId: string; sessionKey: string },
  workspace: string,
) {
  const guestProfile = (await ensureCanonicalUserProfileForEmail("publication-guest@example.test"))
    .id;
  const maintainerProfile = (
    await ensureCanonicalUserProfileForEmail("publication-maintainer@example.test")
  ).id;
  const publisherProfile = (
    await ensureCanonicalUserProfileForEmail("publication-publisher@example.test")
  ).id;
  await setCanonicalUserProfileRole(publisherProfile, "publisher");
  invalidateOperatorRolePolicy(publisherProfile);
  await setCanonicalUserProfileRole(maintainerProfile, "maintainer");
  invalidateOperatorRolePolicy(maintainerProfile);
  const config: OpenClawConfig = {
    agents: { list: [{ id: "main", default: true, workspace }] },
    session: { maintenance: { mode: "warn" } },
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: { sessions: { others: "view" }, agents: ["main"], scopes: guestScopes },
          publisher: { sessions: { others: "write" }, agents: ["main"], scopes: publisherScopes },
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
    sandbox: "required",
  });
  const guestClient = createOperatorWsClient({ connId: guestProfile, scopes: guestScopes });
  guestClient.authenticatedUserProfile = {
    profileId: guestProfile,
    displayName: null,
    avatarRevision: "fixture",
    hasAvatar: false,
    updatedAt: 1,
  };
  prepareGatewayConnectOperatorAccess(guestClient);
  const guestSource = {
    client: guestClient,
    context: {
      getRuntimeConfig: currentGitHubPublicationConfig,
      getCommittedRuntimeConfig: currentGitHubPublicationConfig,
    },
    session: { sessionKey: session.sessionKey, agentId: "main" },
  };
  const publisherSource = await createGitHubPublicationRequesterFixture({
    profileId: publisherProfile,
    scopes: publisherScopes,
    ...guestSource.session,
  });
  const maintainerSource = await createGitHubPublicationRequesterFixture({
    profileId: maintainerProfile,
    scopes: ["operator.admin"],
    sessionKey: session.sessionKey,
    agentId: "main",
  });
  const publisher = publisherSource.requester;
  const maintainer = maintainerSource.requester;
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
    guestSource,
    guestProfile,
    publisher,
    publisherSource,
    publisherProfile,
    maintainer,
    maintainerSource,
    maintainerProfile,
    publishedTitles,
    externalWrites,
    async revoke() {
      await setCanonicalUserProfileRole(publisherProfile, "revoked");
      invalidateOperatorRolePolicy(publisherProfile);
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
          : readGitHubPublicationSessionLifecycle({ publicationKind: "shared", requestId })
              ?.requester_authority_json,
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
    replaceRequesterSnapshot(requestId: string, snapshot: Requester["snapshot"]) {
      const json = JSON.stringify(snapshot);
      runOpenClawStateWriteTransaction(({ db }) => {
        if (backend === "repository") {
          const row = readRepositoryGitHubPublication(requestId)!;
          db.prepare(
            "UPDATE github_repository_publication_requests SET requester_authority_json = ?, request_digest = ? WHERE request_id = ?",
          ).run(
            json,
            repositoryGitHubPublicationDigest({ ...row, requester_authority_json: json }),
            requestId,
          );
          return;
        }
        db.prepare(
          "UPDATE github_publication_session_lifecycles SET requester_authority_json = ? WHERE publication_kind = 'shared' AND request_id = ?",
        ).run(json, requestId);
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

export function requirePublisherAccessPolicy(f: { config: OpenClawConfig }): OpenClawConfig {
  const roles = f.config.gateway!.roles!;
  const config: OpenClawConfig = {
    ...f.config,
    gateway: {
      ...f.config.gateway,
      roles: {
        ...roles,
        definitions: {
          ...roles.definitions,
          publisher: { ...roles.definitions.publisher!, accessPolicyPlugin: "publication-access" },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(config);
  return config;
}

/** Exercise retained generic policy grants without widening the restricted Visitor role. */
export async function preparePublisherAccessPolicyFixture(f: { config: OpenClawConfig }) {
  const {
    captureActivePluginRegistrySnapshot,
    restoreActivePluginRegistrySnapshot,
    setActivePluginRegistry,
    stageActivePluginRegistry,
    rollbackStagedPluginRegistry,
  } = await import("../plugins/runtime.js");
  const { createEmptyPluginRegistry } = await import("../plugins/registry-empty.js");
  const priorRegistry = captureActivePluginRegistrySnapshot();
  requirePublisherAccessPolicy(f);
  const email = "publication-publisher@example.test";
  const store = createPluginStateKeyedStore<StoredVisitorGrant>("publication-access", {
    namespace: "publication-grants",
    maxEntries: 1,
    overflowPolicy: "reject-new",
  });
  let grant: StoredVisitorGrant | undefined;
  let controller = new AbortController();
  const authority = () => {
    const captured = grant!;
    const signal = controller.signal;
    return {
      grantId: captured.grantId,
      signal,
      assertCurrent() {
        signal.throwIfAborted();
        if (
          !grant ||
          grant.grantId !== captured.grantId ||
          (grant.expiresAt !== null && Date.now() >= grant.expiresAt)
        ) {
          throw new Error("Publication access grant ended");
        }
      },
    };
  };
  const register = () => {
    const fixture = createPluginRegistryFixture();
    registerVirtualTestPlugin({
      registry: fixture.registry,
      config: fixture.config,
      id: "publication-access",
      name: "Publication access",
      register(api) {
        api.registerGatewayAccessPolicy({
          authorize({ profile, requiredByRole }) {
            if (!requiredByRole) {
              return undefined;
            }
            if (
              !grant ||
              !profile.emails.includes(email) ||
              (grant.expiresAt !== null && Date.now() >= grant.expiresAt)
            ) {
              throw new Error("Publication access grant required");
            }
            return authority();
          },
          resume({ profile, grantId }) {
            if (
              !grant ||
              grant.grantId !== grantId ||
              !profile.emails.includes(email) ||
              (grant.expiresAt !== null && Date.now() >= grant.expiresAt)
            ) {
              return undefined;
            }
            return authority();
          },
        });
      },
    });
    setActivePluginRegistry(fixture.registry.registry);
  };
  return {
    store,
    async start() {
      grant = await store.lookup(email);
      register();
    },
    async execute(operation: "grant" | "revoke", input: { email: string; days?: number }) {
      expect(input.email).toBe(email);
      if (operation === "revoke") {
        controller.abort();
        grant = undefined;
        await store.delete(email);
        return;
      }
      const previous = await store.lookup(email);
      const continuous =
        previous && (previous.expiresAt === null || previous.expiresAt > Date.now());
      if (!continuous) {
        controller.abort();
        controller = new AbortController();
      }
      grant = {
        grantId: continuous ? previous.grantId : randomUUID(),
        email,
        createdAt: continuous ? previous.createdAt : Date.now(),
        expiresAt: Date.now() + (input.days ?? 1) * 86400000,
      };
      await store.register(email, grant);
    },
    suspendRegistry() {
      const snapshot = captureActivePluginRegistrySnapshot();
      stageActivePluginRegistry(
        createEmptyPluginRegistry(),
        null,
        snapshot.runtimeSubagentMode,
        snapshot.workspaceDir ?? undefined,
      );
      return () => rollbackStagedPluginRegistry(snapshot);
    },
    async reopen() {
      restoreActivePluginRegistrySnapshot(priorRegistry);
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      grant = undefined;
    },
    async close() {
      restoreActivePluginRegistrySnapshot(priorRegistry);
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
    },
  };
}

function requireVisitorPublicationPolicy(f: { config: OpenClawConfig }): OpenClawConfig {
  const roles = f.config.gateway!.roles!;
  const config: OpenClawConfig = {
    ...f.config,
    gateway: {
      ...f.config.gateway,
      roles: {
        ...roles,
        definitions: {
          ...roles.definitions,
          guest: {
            ...roles.definitions.guest!,
            sandbox: "required",
            accessPolicyPlugin: "visitor-access",
            modelPolicy: {},
          },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(config);
  return config;
}

export async function prepareVisitorPublicationFixture(f: {
  config: OpenClawConfig;
  session: { sessionKey: string };
  maintainer: Requester;
  local?: { cwd: string };
}) {
  const [
    { loadAndActivateRootPluginRegistry },
    { startPluginServices },
    {
      captureActivePluginRegistrySnapshot,
      clearActivePluginRegistry,
      restoreActivePluginRegistrySnapshot,
      stageActivePluginRegistry,
      rollbackStagedPluginRegistry,
    },
    { createEmptyPluginRegistry },
  ] = await Promise.all([
    import("../plugins/loader.js"),
    import("../plugins/services.js"),
    import("../plugins/runtime.js"),
    import("../plugins/registry-empty.js"),
  ]);
  const config: OpenClawConfig = {
    ...requireVisitorPublicationPolicy(f),
    plugins: {
      allow: ["visitor-access"],
      slots: { memory: "none" },
      entries: {
        "visitor-access": {
          enabled: true,
          config: {
            accountId: "publication-test",
            appId: "publication-test",
            apiToken: "synthetic-publication-policy-token",
          },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(config);
  const env = {
    ...process.env,
    OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../extensions/", import.meta.url)),
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
  };
  const workspaceDir = f.local?.cwd ?? root;
  const priorRegistry = captureActivePluginRegistrySnapshot();
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
  const gateway: PluginRuntime["gateway"] = {
    isAvailable: async () => true,
    async readSessionFacts() {
      throw new Error("Unexpected session facts request");
    },
    async request() {
      throw new Error("Unexpected Gateway request");
    },
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
  const unexpectedSubagent = () => {
    throw new Error("Visitor publication fixtures must not dispatch subagent work");
  };
  const register = async () => {
    const registry = await loadAndActivateRootPluginRegistry({
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
          complete: unexpectedSubagent,
          run: unexpectedSubagent,
          waitForRun: unexpectedSubagent,
          getSessionMessages: unexpectedSubagent,
          deleteSession: unexpectedSubagent,
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
        await startPluginServices({
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
          await clearActivePluginRegistry(registry);
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
  return {
    get store() {
      return active.store;
    },
    start: () => active.start(),
    execute: (...args: Parameters<typeof active.execute>) => active.execute(...args),
    suspendRegistry() {
      const snapshot = captureActivePluginRegistrySnapshot();
      stageActivePluginRegistry(
        createEmptyPluginRegistry(),
        null,
        snapshot.runtimeSubagentMode,
        snapshot.workspaceDir ?? undefined,
      );
      return () => rollbackStagedPluginRegistry(snapshot);
    },
    async reopen() {
      await active.stop();
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      active = await register();
    },
    async close() {
      try {
        await active.stop();
      } finally {
        restoreActivePluginRegistrySnapshot(priorRegistry);
        await closeOpenClawAgentDatabasesAsync();
        await closeOpenClawStateDatabaseAsync();
        resetPluginStateStoreForTests();
        vi.unstubAllGlobals();
      }
    },
  };
}
