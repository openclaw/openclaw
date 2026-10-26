import { beforeEach, expect, it, vi } from "vitest";
import {
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { recordCommittedSessionMetadataPublication } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createRemoteControlUiIngressTestContext } from "../remote-control-ui.test-support.js";
import {
  prepareGitHubPublicationOptionsRead,
  preparePersonalGitHubSessionActionV2,
} from "./github-personal-authorization.js";
import { createSessionMutationTestClient } from "./sessions-mutations.owner.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

type SessionRead = ReturnType<typeof sessionRead>;
type WorkerRead = Parameters<
  typeof import("../session-utils-store-worker.js").loadGatewaySessionEntryReadOnlyInWorker
>[0];
const mocks = vi.hoisted(() => ({
  loadSession:
    vi.fn<(key: string, options?: { agentId?: string }) => SessionRead | Promise<SessionRead>>(),
  roleScopes: undefined as string[] | undefined,
  roleReads: 0,
}));

// mock-isolation: Reject legacy synchronous reads to enforce the async storage boundary.
vi.mock("../session-utils.js", () => ({
  loadIncognitoGatewaySessionEntryReadOnly: () => {
    throw new Error("Synchronous publication read");
  },
}));
// mock-isolation: Supply selected rows and source identity without opening session stores.
vi.mock("../session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: async ({ key, agentId, onSelected }: WorkerRead) => {
    const loaded = await mocks.loadSession(key, { agentId });
    onSelected?.({
      ...loaded,
      store: loaded.entry ? { [loaded.canonicalKey]: loaded.entry } : {},
      capturedReadSource: {
        agentId: loaded.agentId,
        path: loaded.storePath,
        databaseIdentity: "github-options-fixture",
        databaseBirthtime: "1",
      },
    });
    return loaded;
  },
}));
// mock-isolation: Admit the requester without opening profile or session stores.
vi.mock("../github-publication-requester.js", () => ({
  prepareGitHubPublicationRequesterV2: async () => ({
    requester: {
      signal: new AbortController().signal,
      prepareSource: () => {
        throw new Error("Unexpected publication source preparation");
      },
    },
    release: () => {},
  }),
}));
vi.mock("../../agents/tools/gateway-caller-context.js", () => ({
  getGatewayToolCallerIdentity: () => undefined,
}));
// mock-isolation: Supply profile authority without opening the host profile store.
vi.mock("../../state/user-channel-identity-operations.js", () => ({
  prepareUserProfileRolePolicyAuthority: async (profileId: string) => ({
    profileId,
    isCurrent: () => true,
  }),
}));
// mock-isolation: Supply resident profile facts without hydrating the profile database.
vi.mock("../../state/user-profile-list.js", () => ({
  captureResidentUserProfileAccess: (profileId: string) => ({
    assertCurrent: () => ({ id: profileId, role: null }),
  }),
}));
// mock-isolation: Control role ceilings independently of persistent operator policy.
vi.mock("../operator-role-policy.js", () => {
  const resolve = () => {
    mocks.roleReads++;
    return mocks.roleScopes ? { scopes: mocks.roleScopes } : null;
  };
  return {
    operatorSessionCap: () => undefined,
    resolveOperatorRolePolicy: resolve,
    resolveOperatorRolePolicyForProfile: resolve,
    resolveOperatorRolePolicyForAssignment: resolve,
  };
});
// mock-isolation: Supply selected-session access without initializing sharing storage.
vi.mock("../session-sharing.js", () => ({
  createSessionListEntryFilter: () => undefined,
}));

// mock-isolation: Admit sharing independently of the live personal grant under test.
vi.mock("../session-sharing-authorization-async.js", () => ({
  resolveSessionMutationAuthorizationAsync: async () => ({}),
}));

function createRequest() {
  const client = createSessionMutationTestClient("profile-cache-test");
  client.connId = "github-cache-client";
  client.connect.scopes = ["operator.read", "operator.write"];
  delete client.authenticatedUserId;
  const context = {
    getRuntimeConfig: () => ({}),
    getClientConnIds: (filter?: (candidate: GatewayClient) => boolean) =>
      new Set(!filter || filter(client) ? ["github-cache-client"] : []),
  } as Partial<GatewayRequestContext> as GatewayRequestContext;
  return {
    client,
    context,
    req: { type: "req" as const, id: "github-read", method: "sessions.github.options" },
  };
}

function sessionRead(agentId = "main", patch: Partial<SessionEntry> = {}) {
  return {
    canonicalKey: `agent:${agentId}:main`,
    agentId,
    storePath: "/test/sessions.json",
    storeKeys: [`agent:${agentId}:main`],
    entry: { sessionId: "session-cache-test", updatedAt: 1, ...patch },
  };
}

function prepare(request = createRequest(), agentId?: string, signal?: AbortSignal) {
  return prepareGitHubPublicationOptionsRead(request, { sessionKey: "main", agentId }, signal);
}

function publish(loaded: SessionRead, patch: Partial<SessionEntry>) {
  recordCommittedSessionMetadataPublication(
    "github-options-fixture",
    loaded.canonicalKey,
    undefined,
    { ...loaded.entry, ...patch },
  );
}

function holdSessionRead() {
  const snapshot = sessionRead();
  const pending = Promise.withResolvers<SessionRead>();
  const entered = Promise.withResolvers<void>();
  mocks.loadSession.mockImplementationOnce(() => {
    entered.resolve();
    return pending.promise;
  });
  return { snapshot, pending, entered };
}

beforeEach(() => {
  setRuntimeConfigSnapshot({});
  mocks.roleScopes = undefined;
  mocks.roleReads = 0;
  mocks.loadSession.mockReset();
  mocks.loadSession.mockReturnValue(sessionRead());
});

it("shares overlapping options preparation without sharing caller authority or release", async () => {
  const { snapshot, pending, entered } = holdSessionRead();
  const cancelled = new AbortController();
  const first = prepare(createRequest(), undefined, cancelled.signal);
  const failed = expect(first).rejects.toThrow("synthetic cancellation");
  const second = prepare();
  const third = prepare();
  await entered.promise;
  cancelled.abort(new Error("synthetic cancellation"));
  pending.resolve(snapshot);
  await failed;
  using surviving = await second;
  using independent = await third;
  expect(surviving.currentSession().sessionId).toBe(snapshot.entry.sessionId);
  expect(mocks.loadSession).toHaveBeenCalledTimes(1);
  surviving.release();
  expect(() => surviving.currentSession()).toThrow();
  expect(independent.currentSession().sessionId).toBe(snapshot.entry.sessionId);
  publish(snapshot, { archivedAt: 123 });
  expect(() => independent.currentSession()).toThrow("session lifecycle changed");
  mocks.loadSession.mockReturnValue(sessionRead("main", { archivedAt: 123 }));
  using fresh = await prepare();
  expect(fresh.currentSession().archivedAt).toBe(123);
  expect(mocks.loadSession).toHaveBeenCalledTimes(2);
});

it("prepares the new session store after an in-place config publication", async () => {
  const config = getRuntimeConfigSnapshot()!;
  const { snapshot, pending, entered } = holdSessionRead();
  mocks.loadSession.mockReturnValue(sessionRead("main", { sessionId: "reloaded-session" }));
  const first = prepare();
  await entered.promise;
  config.session = { store: "/test/reloaded/sessions.json" };
  setRuntimeConfigSnapshot(config);
  const second = prepare();
  await Promise.resolve();
  pending.resolve(snapshot);
  (await first).release();
  using reloaded = await second;
  expect(reloaded.currentSession().sessionId).toBe("reloaded-session");
  expect(mocks.loadSession).toHaveBeenCalledTimes(2);
});

it("keeps origin-free personal reads and publication bound to the live ingress grant", async () => {
  const request = createRequest();
  const grant = new AbortController();
  const principal = createRemoteControlUiIngressTestContext({
    principal: { kind: "person", profileId: "profile-cache-test" },
    signal: grant.signal,
  }).resolvePrincipal();
  delete request.client.connId;
  request.client.authenticatedUserProfile = principal.authenticatedUserProfile;
  request.client.internal = {
    remoteIngressPrincipal: principal,
    operatorRoleActor: principal.operatorRoleActor,
  };
  request.context.getClientConnIds = () => new Set();
  using read = await prepare(request);
  expect(read.personal.kind).toBe("eligible");
  const publication = await preparePersonalGitHubSessionActionV2(request, { sessionKey: "main" });
  using _ = { [Symbol.dispose]: publication.release };
  expect(() => publication.action.assertCurrent()).not.toThrow();
  grant.abort();
  expect(() => read.currentSession()).toThrow("connection is no longer current");
  expect(() => publication.action.assertCurrent()).toThrow("current authenticated human");
});

it.each([
  ["operator.read", "operator.sessions.write"],
  ["operator.sessions.write", "operator.read"],
])("retains shared session-read permission for %s capped by %s", async (grant, ceiling) => {
  const request = createRequest();
  request.client.connect.scopes = [grant];
  mocks.roleScopes = [ceiling];

  using read = await prepare(request);
  expect(read.currentSession()).toEqual(read.session);
  expect(read.personal.kind).toBe("ineligible");

  mocks.roleScopes = ["operator.approvals"];
  expect(() => read.currentSession()).toThrow(
    "GitHub requires current operator.sessions.read permission.",
  );
});

it("reuses the worker result until publication metadata changes", async () => {
  const agentId = "research";
  const loaded = sessionRead(agentId);
  mocks.loadSession.mockReturnValue(loaded);
  using read = await prepare(createRequest(), agentId);
  expect(read.currentSession()).toEqual(read.session);
  publish(loaded, { label: "renamed" });
  expect(read.currentSession()).toEqual(read.session);
  expect(mocks.loadSession).toHaveBeenCalledTimes(1);
  read.release();
  expect(() => read.currentSession()).toThrow("session lifecycle changed");
});

it("checks live client policy once per publication options read", async () => {
  mocks.roleScopes = ["operator.read", "operator.write"];
  using read = await prepare();
  // Owner benchmark: OPENCLAW_VITEST_RUNTIME=node OPENCLAW_BENCH_GITHUB_OPTIONS=both
  // node scripts/run-vitest.mjs src/gateway/server-methods/github-personal-authorization.test.ts
  // --maxWorkers=1 -t "checks live client policy". Use timing/allocation for separate runs.
  // OPENCLAW_BENCH_GITHUB_OPTIONS_BASE may name a frozen adjacent copy of the source owner.
  const mode = process.env.OPENCLAW_BENCH_GITHUB_OPTIONS;
  if (mode === "timing" || mode === "allocation" || mode === "both") {
    const iterations = 5_000;
    const expected = JSON.stringify(read.session);
    const baselinePath = process.env.OPENCLAW_BENCH_GITHUB_OPTIONS_BASE;
    const baselineModule: typeof import("./github-personal-authorization.js") | undefined =
      baselinePath ? await import(baselinePath) : undefined;
    using baseline = baselineModule
      ? await baselineModule.prepareGitHubPublicationOptionsRead(createRequest(), {
          sessionKey: "main",
        })
      : undefined;
    const readers = [
      ...(baseline ? [{ arm: "base", reader: baseline }] : []),
      { arm: "candidate", reader: read },
    ];
    for (const { reader } of readers) {
      expect(JSON.stringify(reader.session)).toBe(expected);
      for (let index = 0; index < iterations; index++) {
        reader.currentSession();
      }
    }
    for (const pass of mode === "both" ? ["timing", "allocation"] : [mode]) {
      for (const [pair, ordered] of [readers, readers.toReversed()].entries()) {
        for (const { arm, reader } of ordered) {
          const profiler =
            pass === "allocation"
              ? new (await import("node:inspector/promises")).Session()
              : undefined;
          profiler?.connect();
          try {
            await profiler?.post("HeapProfiler.startSampling", {
              samplingInterval: 512,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            });
            const started = performance.now();
            const cpuStart = process.cpuUsage();
            let result = read.session;
            for (let index = 0; index < iterations; index++) {
              result = reader.currentSession();
            }
            const cpu = process.cpuUsage(cpuStart);
            const wallMs = performance.now() - started;
            const sampled = await profiler?.post("HeapProfiler.stopSampling");
            let allocatedBytes = 0;
            const nodes = sampled ? [sampled.profile.head] : [];
            for (const node of nodes) {
              allocatedBytes += node.selfSize;
              nodes.push(...node.children);
            }
            expect(JSON.stringify(result)).toBe(expected);
            console.log(
              JSON.stringify({
                benchmark: "github-options-prepared-reader",
                arm,
                pair,
                pass,
                iterations,
                wallMsPerCall: wallMs / iterations,
                cpuUsPerCall: (cpu.user + cpu.system) / iterations,
                ...(sampled ? { allocatedBytesPerCall: allocatedBytes / iterations } : {}),
                response: expected,
              }),
            );
          } finally {
            profiler?.disconnect();
          }
        }
      }
    }
  }
  for (const consume of [
    () => read.currentSession(),
    () => read.currentSessionRead(),
    () => read.assertSessionUnchanged(read.session),
  ]) {
    mocks.roleReads = 0;
    consume();
    expect(mocks.roleReads).toBe(1);
  }
  mocks.roleScopes = ["operator.approvals"];
  expect(() => read.currentSession()).toThrow("operator.sessions.read permission");
  expect(() => read.currentSessionRead()).toThrow("operator.sessions.read permission");
  expect(() => read.assertSessionUnchanged(read.session)).toThrow(
    "operator.sessions.read permission",
  );
});

it.each([null, 123])(
  "invalidates a prepared response after an archive receipt from %s",
  async (archivedAt) => {
    const loaded = sessionRead();
    mocks.loadSession.mockReturnValue(sessionRead("main", { archivedAt: archivedAt ?? undefined }));
    using read = await prepare();
    const initial = read.currentSession();
    expect(initial.archivedAt).toBe(archivedAt);
    publish(loaded, { archivedAt: archivedAt === null ? 123 : undefined });
    expect(() => read.currentSession()).toThrow("session lifecycle changed");
    expect(() => read.assertSessionUnchanged(initial)).toThrow("session lifecycle changed");
  },
);
