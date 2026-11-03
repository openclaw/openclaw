import { AsyncLocalStorage } from "node:async_hooks";
import { expect, vi } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { deleteSessionEntryLifecycle } from "../config/sessions.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  bindLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "../plugins/legacy-sdk-resource-host.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { linkEmail, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { ControlUiSessionPullRequests } from "./control-ui-contract.js";
import { createRepositorySessionReadHost } from "./control-ui-session-pr-runtime.js";
import { prepareSelectedRepositorySessionRead } from "./control-ui-session-pr-source.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { startTestRepositorySessionPresentation } from "./github-account-service.test-support.js";
import type { OperatorScope } from "./operator-scopes.js";
import type {
  PreparedRepositorySessionRead,
  RepositorySessionObservation,
  RepositorySessionSourceScope,
} from "./repository-session-read.types.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { handleGatewayRequest } from "./server-methods.js";
import {
  disposeSessionReadContexts,
  initializeSessionReadContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import type { RespondFn } from "./server-methods/types.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { createGatewayWsTestSocket } from "./server/ws-connection.test-helpers.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import { resolveSessionStoreKey } from "./session-store-key.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils-store.js";

const METHOD = "controlUi.sessionPullRequests.subscribe";
export const sessionKey = "agent:main:guest-publication";
export const branch = { owner: "synthetic", repo: "publication", branch: "guest-change" };
export const snapshot: ControlUiSessionPullRequests = {
  pullRequests: [],
  branch,
  rateLimited: false,
};
export const readerChanges = [
  "unchanged",
  "role",
  "assignment",
  "connection",
  "profile",
  "visibility",
  "grant",
  "grant without abort",
  "replacement grant",
] as const;
export type Load = (
  query: { sessionKey: string; agentId: string },
  signal: AbortSignal,
  source: {
    observation: RepositorySessionObservation;
    sourceScope: RepositorySessionSourceScope;
    assertCurrent: () => void;
  },
) => Promise<ControlUiSessionPullRequests>;

/** Native integration tests substitute only admitted source facts and HTTP responses. */
export function installSourceTransportProbe(
  host: ReturnType<typeof createRepositorySessionReadHost>,
  load: Load,
  signal: AbortSignal,
  projectReads?: (
    reads: ReturnType<ReturnType<typeof createRepositorySessionReadHost>["bindService"]>,
  ) => ReturnType<ReturnType<typeof createRepositorySessionReadHost>["bindService"]>,
) {
  type Source = {
    observation: RepositorySessionObservation;
    sourceScope: RepositorySessionSourceScope;
    assertCurrent: () => void;
    value?: ControlUiSessionPullRequests;
  };
  const transport = new AsyncLocalStorage<Source>();
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const source = transport.getStore();
    if (!source) {
      throw new Error("PR transport outside admitted fixture source");
    }
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.pathname.endsWith("/pulls")) {
      source.value = await load(
        {
          sessionKey: source.observation.session.sessionKey,
          agentId: source.observation.session.agentId,
        },
        init?.signal ?? signal,
        source,
      );
    }
    const value = source.value;
    const number = Number(url.pathname.match(/\/pulls\/(\d+)/)?.[1]);
    const item = (pr: ControlUiSessionPullRequests["pullRequests"][number]) => ({
      number: pr.number,
      title: pr.title,
      html_url: pr.url,
      state: pr.state === "open" || pr.state === "draft" ? "open" : "closed",
      draft: pr.state === "draft",
      merged_at: pr.state === "merged" ? "2026-01-01T00:00:00Z" : null,
      head: { sha: pr.headSha ?? "a".repeat(40), ref: pr.branch },
      base: { ref: "main", repo: { name: pr.repo, owner: { login: pr.owner } } },
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      changed_files: pr.changedFiles ?? 0,
    });
    const selected = value?.pullRequests.find((pr) => pr.number === number);
    const body = url.pathname.endsWith("/pulls")
      ? (value?.pullRequests.map(item) ?? [])
      : selected
        ? item(selected)
        : { fork: false, total_count: 0, check_runs: [], statuses: [] };
    return new Response(JSON.stringify(body), {
      status: value?.rateLimited ? 403 : 200,
      headers: {
        "Content-Type": "application/json",
        ...(value?.rateLimited ? { "x-ratelimit-remaining": "0" } : {}),
      },
    });
  });
  const sourceRun = <T>(
    observation: RepositorySessionObservation,
    scope: RepositorySessionSourceScope,
    operation: (scope: RepositorySessionSourceScope) => Promise<T>,
  ) => {
    const selected = observation.source;
    const source: RepositorySessionSourceScope = {
      ...scope,
      readCheckoutRevision: async () => JSON.stringify(selected),
      readCheckoutFacts: async () =>
        selected
          ? {
              originUrl:
                selected.kind === "repository"
                  ? selected.url
                  : "https://github.com/synthetic/publication",
              branch: selected.kind === "repository" ? selected.branch : branch.branch,
              ...(selected.kind === "checkout" ? { root: selected.root } : {}),
              defaultBranch: "main",
            }
          : undefined,
      readCheckoutBranchFacts: async () => ({ creatable: false, stats: null }),
    };
    return transport.run(
      { observation, sourceScope: scope, assertCurrent: scope.assertCurrent },
      () => operation(source),
    );
  };
  const bind = host.bindService.bind(host);
  const binding = vi.spyOn(host, "bindService").mockImplementation((...args) => {
    const native = bind(...args);
    const reads = projectReads ? projectReads(native) : native;
    const originals = new WeakMap<RepositorySessionObservation, PreparedRepositorySessionRead>();
    const wrapped = new WeakMap<PreparedRepositorySessionRead, PreparedRepositorySessionRead>();
    const prepare = (read: PreparedRepositorySessionRead | undefined) => {
      if (!read) {
        return undefined;
      }
      let projected = wrapped.get(read);
      if (!projected) {
        projected = {
          ...read,
          withSource: (operation) => read.withSource((scope) => sourceRun(read, scope, operation)),
        };
        wrapped.set(read, projected);
        originals.set(projected, read);
      }
      return projected;
    };
    return {
      ...reads,
      prepareServiceRead: async (query) => prepare(await reads.prepareServiceRead(query)),
      createViewerRead: (...params) => {
        const read = reads.createViewerRead(...params);
        return read && (async () => prepare(await read()));
      },
      withSource: (observation, operation) =>
        reads.withSource(originals.get(observation) ?? observation, (scope) =>
          sourceRun(observation, scope, operation),
        ),
    };
  });
  return () => {
    binding.mockRestore();
    fetch.mockRestore();
  };
}

export function createRpcResponseCapture(received = vi.fn<RespondFn>()) {
  // Undefined optional metadata is absent on the wire; retain any actual metadata.
  const respond: RespondFn = (ok, payload, error, metadata) =>
    metadata === undefined ? received(ok, payload, error) : received(ok, payload, error, metadata);
  return { received, respond };
}

function authority(access = new AbortController()) {
  return { signal: access.signal, assertCurrent: () => access.signal.throwIfAborted() };
}

let fixtureSequence = 0;

export async function createFixture(
  scope: OperatorScope,
  useDefaultLoader = false,
  initialSessionPatch: Partial<SessionEntry> = {},
) {
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  const fixtureId = ++fixtureSequence;
  const readerEmail = `guest-publication-reader-${fixtureId}@example.test`;
  const profile = ensureProfileForEmail(readerEmail);
  const other = ensureProfileForEmail(`publication-owner-${fixtureId}@example.test`);
  const seeded = new Set<string>();
  const readerRole = { agents: ["main"], sessions: { others: "view" as const }, scopes: [scope] };
  const cfg: OpenClawConfig = {
    gateway: {
      roles: {
        default: "reader",
        definitions: { reader: readerRole, revoked: { ...readerRole, scopes: [] } },
      },
    },
  };
  setUserProfileRole(profile.id, "reader");
  setRuntimeConfigSnapshot(cfg);
  const seed = async (key: string, creator = profile.id, patch: Partial<SessionEntry> = {}) => {
    if (!seeded.has(key)) {
      expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey: key })).toBeUndefined();
      seeded.add(key);
    }
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: key },
      {
        sessionId: `${key}-${fixtureId}`,
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: creator },
        spawnedCwd: "/synthetic/guest-publication",
        ...patch,
      },
    );
  };
  await seed(sessionKey, profile.id, initialSessionPatch);
  const connections = createGatewayConnectionState({
    scheduler,
    bootId: "publication-read",
    cfg,
    getRuntimeConfig,
  });
  const addReader = (connId: string) => {
    const socket = createGatewayWsTestSocket();
    const client = createOperatorWsClient({ connId, socket, scopes: [scope] });
    const access = new AbortController();
    client.internal = {
      ...client.internal,
      operatorAccessAuthority: authority(access),
    };
    client.authenticatedUserProfile = {
      profileId: profile.id,
      avatarRevision: "fixture",
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    };
    prepareGatewayRecipientProfile(client);
    connections.clients.add(client);
    return { client, socket, access };
  };
  const load = vi.fn<Load>(async () => snapshot);
  const contextParams = makeContextParams(connections);
  const context = createGatewayRequestContext(contextParams);
  context.getRuntimeConfig = getRuntimeConfig;
  const resolveGatewayContext = () => context;
  context.resolveGatewayContext = resolveGatewayContext;
  const resources = new LegacyPluginSdkResourceHost();
  bindLegacyPluginSdkResourceHost(resolveGatewayContext, resources);
  const readHost = createRepositorySessionReadHost({
    signal: scheduler.signal,
    getRuntimeConfig,
    getSessionRowProjection: () => getSessionRowProjection(context),
    getClient: (connId) => connections.clients.getByConnectionId(connId),
    resolveGatewayContext,
    broadcastToConnIds: connections.broadcastToConnIds,
  });
  contextParams.runtime.runtimeState.repositorySessions = readHost;
  const reads = readHost.bindService(scheduler.signal, () => scheduler.signal.throwIfAborted());
  const stopProbe = !useDefaultLoader
    ? installSourceTransportProbe(readHost, load, scheduler.signal)
    : undefined;
  const native = await startTestRepositorySessionPresentation(context, scheduler, undefined, {
    cleanupOnFinish: false,
  });
  const services = {
    stop: async () => {
      try {
        await native.stop({ strict: true });
      } finally {
        stopProbe?.();
        await scheduler.stop();
        await resources.close();
      }
    },
  };
  const presentation = readHost.presentation;
  if (!presentation) {
    throw new Error("Missing registered session presentation");
  }
  const subscriptions = presentation;
  await initializeSessionReadContext(context);
  const reader = addReader("guest-publication-reader");
  const projection = getSessionRowProjection(context);
  if (!projection) {
    throw new Error("Missing fixture session projection");
  }
  const detachProjection = connections.attachSessionRowProjection(projection);
  return {
    ...reader,
    clock,
    addReader,
    profile,
    readerEmail,
    other,
    sessionId: `${sessionKey}-${fixtureId}`,
    cfg,
    seed,
    load,
    subscriptions,
    sessionReads: reads,
    presentation,
    readHost,
    services,
    context,
    async changeReader(change: (typeof readerChanges)[number], key = sessionKey) {
      if (change === "role") {
        const revoked = structuredClone(cfg);
        revoked.gateway!.roles!.definitions!.reader!.scopes = [];
        setRuntimeConfigSnapshot(revoked);
      } else if (change === "assignment") {
        setUserProfileRole(profile.id, "revoked");
        prepareGatewayRecipientProfile(reader.client);
      } else if (change === "connection") {
        reader.client.invalidated = true;
      } else if (change === "profile") {
        linkEmail(readerEmail, other.id);
      } else if (change === "visibility") {
        await seed(key, other.id, { visibility: "draft", updatedAt: 2 });
      } else if (change === "grant") {
        reader.access.abort(new Error("Original access retired"));
      } else if (change === "grant without abort") {
        vi.spyOn(
          reader.client.internal!.operatorAccessAuthority!,
          "assertCurrent",
        ).mockImplementation(() => {
          throw new Error("Original access retired without aborting its signal");
        });
      } else if (change === "replacement grant") {
        reader.client.internal = {
          ...reader.client.internal,
          operatorAccessAuthority: authority(),
        };
      }
    },
    async seedRepository(
      key = sessionKey,
      repo = "publication",
      patch: Partial<SessionEntry> = {},
      repoBranch = "guest-change",
    ) {
      const repository = await getSessionRepositoryWorkspaceStore().create({
        agentId: "main",
        sessionKey: key,
        url: `https://github.com/synthetic/${repo}`,
        branch: repoBranch,
        assertCurrent: () => {},
      });
      await seed(key, profile.id, { ...patch, repositoryWorkspaceId: repository.workspaceId });
      return repository;
    },
    async subscribe(keys = [sessionKey], client = reader.client) {
      const { received, respond } = createRpcResponseCapture();
      await handleGatewayRequest({
        req: { type: "req", id: "watch", method: METHOD, params: { sessionKeys: keys } },
        client,
        context,
        isWebchatConnect: () => false,
        respond,
      });
      expect(received).toHaveBeenCalledExactlyOnceWith(
        true,
        { subscribed: keys.length > 0 },
        undefined,
      );
    },
    async close() {
      await services.stop();
      await scheduler.stop();
      connections.clients.clear();
      detachProjection();
      await disposeSessionReadContexts();
    },
    async removeSessions() {
      for (const key of seeded) {
        const original = loadSessionEntryReadOnly({ agentId: "main", sessionKey: key });
        if (original) {
          await deleteSessionEntryLifecycle({
            agentId: "main",
            storePath: (await loadGatewaySessionEntryReadOnlyAsync(key, { agentId: "main" }))
              .storePath,
            target: { canonicalKey: key, storeKeys: [key] },
            expectedSessionId: original.sessionId,
            archiveTranscript: false,
          });
        }
      }
    },
  };
}

export async function withDefaultLoader(
  provider: typeof fetch,
  run: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
) {
  try {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.stubEnv("GH_TOKEN", "");
      vi.stubEnv("GITHUB_TOKEN", "");
      vi.stubGlobal("fetch", provider);
      const f = await createFixture("operator.read", true);
      try {
        await run(f);
      } finally {
        await f.close();
      }
    });
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
}

/** Loader fixtures use the host's session routing, not vendor-specific key parsing. */
export function resolveSessionPrFixtureRequest(
  params: { sessionKey: string; agentId?: string },
  cfg = getRuntimeConfig(),
) {
  const requested = resolveRequestedSessionAgentId(cfg, params.sessionKey, params.agentId);
  if (!requested.ok) {
    throw new Error(requested.error.message);
  }
  const agentId = requested.agentId;
  return {
    agentId,
    sessionKey: resolveSessionStoreKey({
      cfg,
      sessionKey: params.sessionKey,
      storeAgentId: agentId,
    }),
  };
}

export async function recordSessionPrFixtureCheckout(
  params: { sessionKey: string; agentId: string },
  root: string,
) {
  const current = await loadGatewaySessionEntryReadOnlyAsync(params.sessionKey, {
    agentId: params.agentId,
  });
  if (current.entry?.spawnedCwd !== root) {
    await upsertSessionEntryCore(params, { spawnedCwd: root });
  }
}

/** Retain the real host session, repository and physical source through the fixture's final read. */
export async function prepareSessionPrFixtureRead(params: {
  sessionKey: string;
  agentId?: string;
}) {
  const initial = await loadGatewaySessionEntryReadOnlyAsync(params.sessionKey, {
    agentId: params.agentId,
  });
  const workspace = initial.entry?.repositoryWorkspaceId
    ? await getSessionRepositoryWorkspaceStore().prepare(initial.entry.repositoryWorkspaceId)
    : undefined;
  const selected = await loadGatewaySessionEntryReadOnlyAsync(params.sessionKey, {
    agentId: params.agentId,
  });
  const facts = await prepareSessionMutationFacts({
    cfg: getRuntimeConfig(),
    sessionKey: params.sessionKey,
    agentId: selected.agentId,
  });
  const original = facts.readCurrent(getRuntimeConfig()).target.entry;
  const assertCurrent = () => {
    const current = facts.readCurrent(getRuntimeConfig()).target.entry;
    if (
      current.sessionId !== original.sessionId ||
      current.lifecycleRevision !== original.lifecycleRevision
    ) {
      throw new Error("Session pull-request target changed");
    }
  };
  try {
    const repository = workspace?.current();
    const read = prepareSelectedRepositorySessionRead(
      // Native projection/viewer observations use the admitted physical store target.
      { ...selected, storePath: selected.readSource?.path ?? selected.storePath },
      repository &&
        repository.workspaceId === selected.entry?.repositoryWorkspaceId &&
        repository.agentId === selected.agentId &&
        repository.sessionKey === selected.canonicalKey
        ? repository
        : null,
      { assertCurrent, runSource: (run) => run() },
    );
    if (!read) {
      facts.release();
      return undefined;
    }
    return {
      read: { ...read, boundPullRequest: selected.entry?.worktree?.githubPullRequest },
      release: facts.release,
    };
  } catch (error) {
    facts.release();
    throw error;
  }
}
