import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { markPluginRegistryActive } from "../../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { UserProfileIdentity } from "../../state/user-profiles.types.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";

type TestPluginRegistry = Omit<PluginRegistry, "sessionCatalogs"> & {
  sessionCatalogs: Array<{ provider: SessionCatalogProvider }>;
};
type TestClient = {
  connect: { scopes: string[] };
  connId?: string;
  authenticatedUserProfile?: { profileId: string };
  preparedSessionProfile?: UserProfileIdentity;
};

const hoisted = vi.hoisted(() => ({
  activeRegistry: {} as TestPluginRegistry,
  profileRole: vi.fn((): string | null => null),
  hasMultipleSessionSharingIdentities: vi.fn(() => false),
  resolveSessionSharingRole: vi.fn<
    typeof import("../session-sharing-policy.js").resolveSessionSharingRole
  >(() => "viewer"),
  resolveSessionSharingTargetAsync: vi.fn<
    typeof import("../session-sharing-policy.js").resolveSessionSharingTargetAsync
  >(async () => null),
}));

vi.mock("../../plugins/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/runtime.js")>()),
  getActivePluginRegistry: () => hoisted.activeRegistry,
  getPluginRegistryForContext: () => hoisted.activeRegistry,
  requireActivePluginRegistry: () => hoisted.activeRegistry,
}));
vi.mock("../../state/user-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-profiles.js")>()),
  hasMultipleSessionSharingIdentities: hoisted.hasMultipleSessionSharingIdentities,
}));
vi.mock("../../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-profile-list.js")>()),
  hasMultipleResidentSessionSharingIdentities: hoisted.hasMultipleSessionSharingIdentities,
  readResidentUserProfileAliases: (id: string) => new Set([id]),
  readResidentUserProfileId: (id: string) => id,
  readResidentUserProfileIdentity: (id: string) => ({
    profileId: id,
    role: hoisted.profileRole(),
  }),
}));
vi.mock("../session-sharing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-sharing.js")>()),
  resolveSessionSharingRole: hoisted.resolveSessionSharingRole,
  resolveSessionSharingTargetAsync: hoisted.resolveSessionSharingTargetAsync,
}));

const { sessionCatalogHandlers } = await import("./session-catalog.js");
let sessionEntries: Array<{ sessionKey: string; entry: Partial<SessionEntry> }> = [];
const projections = new Set<ReturnType<typeof createSessionRowProjectionFixture>>();

afterEach(() => {
  for (const projection of projections) {
    projection.dispose();
  }
  projections.clear();
  clearRuntimeConfigSnapshot();
});

function client(profileId: string, scopes = ["operator.read", "operator.write"]): TestClient {
  return {
    connect: { scopes },
    authenticatedUserProfile: { profileId },
    preparedSessionProfile: { profileId, aliases: new Set([profileId]), role: null },
  };
}

function unprofiledClient(scopes = ["operator.read", "operator.write"]): TestClient {
  return { connect: { scopes } };
}

function session(threadId: string, sessionKey?: string) {
  return {
    threadId,
    status: "stored",
    archived: false,
    ...(sessionKey ? { sessionKey } : {}),
    canContinue: true,
    canArchive: true,
  };
}

function host(sessions: ReturnType<typeof session>[], nextCursor?: string) {
  return {
    hostId: "gateway:local",
    label: "Local",
    kind: "gateway" as const,
    connected: true,
    sessions,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function provider(overrides: Partial<SessionCatalogProvider> = {}): SessionCatalogProvider {
  return {
    id: "codex",
    label: "Codex",
    list: vi.fn(async () => []),
    read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
    ...overrides,
  };
}

function install(
  overrides: Partial<SessionCatalogProvider>,
  sessions?: ReturnType<typeof session>[],
) {
  const catalog = provider({
    ...(sessions ? { list: vi.fn(async () => [host(sessions)]) } : {}),
    ...overrides,
  });
  hoisted.activeRegistry.sessionCatalogs = [{ provider: catalog }];
}

function page(threadId: string, text?: string) {
  return {
    hostId: "gateway:local",
    threadId,
    items: text ? [{ type: "userMessage" as const, text }] : [],
  };
}

function locator(threadId: string, extra: Record<string, unknown> = {}) {
  return { catalogId: "codex", hostId: "gateway:local", threadId, ...extra };
}

function expectForbidden(
  respond: ReturnType<typeof vi.fn>,
  message?: string | ReturnType<typeof expect.stringContaining>,
) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      code: ErrorCodes.FORBIDDEN,
      ...(message ? { message } : {}),
    }),
  );
}

function expectCatalog(respond: ReturnType<typeof vi.fn>, listedHost: ReturnType<typeof host>) {
  expect(respond).toHaveBeenCalledWith(true, {
    catalogs: [expect.objectContaining({ hosts: [listedHost] })],
  });
}

function mutationProvider(key: string) {
  return {
    read: vi.fn(async () => page(key)),
    continueSession: vi.fn(async () => ({ sessionKey: `agent:main:${key}` })),
    archive: vi.fn(async () => ({ ok: true as const })),
  };
}

function expectNoDispatch(catalog: Partial<ReturnType<typeof mutationProvider>>) {
  for (const method of Object.values(catalog)) {
    expect(method).not.toHaveBeenCalled();
  }
}

const mutations = [
  ["sessions.catalog.read", {}],
  ["sessions.catalog.import", {}],
  ["sessions.catalog.continue", {}],
  ["sessions.catalog.archive", { confirmNoOtherRunner: true }],
] as const;

async function call(
  method: keyof typeof sessionCatalogHandlers,
  params: Record<string, unknown>,
  requestClient: TestClient,
  config: Record<string, unknown> = {},
  contextOverrides: Record<string, unknown> = {},
) {
  const respond = vi.fn();
  setRuntimeConfigSnapshot(config);
  const projection = createSessionRowProjectionFixture({
    cfg: config,
    store: Object.fromEntries(
      sessionEntries.map(({ sessionKey, entry }) => [
        sessionKey,
        { sessionId: sessionKey, updatedAt: 1, ...entry },
      ]),
    ),
  });
  projections.add(projection);
  await sessionCatalogHandlers[method]?.({
    params,
    respond,
    client: requestClient,
    context: bindSessionRowProjection(
      { getRuntimeConfig: () => config, ...contextOverrides },
      () => projection,
    ),
  } as never);
  return respond;
}

function setActors(entries: Array<[sessionKey: string, profileId: string]>) {
  sessionEntries = entries.map(([sessionKey, profileId], index) => ({
    sessionKey,
    entry: {
      createdActor: { type: "human", source: "profile", id: profileId },
      updatedAt: entries.length - index,
    },
  }));
}

function roleConfig(others: "none" | "view" | "suggest" | "write", agents: "*" | string[] = "*") {
  return {
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: {
            sessions: { others },
            agents,
            scopes: ["operator.read", "operator.write"],
          },
        },
      },
    },
  };
}

describe("session catalog caller visibility", () => {
  beforeEach(() => {
    hoisted.activeRegistry = createEmptyPluginRegistry() as TestPluginRegistry;
    markPluginRegistryActive(hoisted.activeRegistry as PluginRegistry);
    hoisted.hasMultipleSessionSharingIdentities.mockReset().mockReturnValue(false);
    hoisted.profileRole.mockReset().mockReturnValue(null);
    sessionEntries = [];
    hoisted.resolveSessionSharingRole.mockReset().mockReturnValue("viewer");
    hoisted.resolveSessionSharingTargetAsync.mockReset().mockResolvedValue(null);
  });

  it.each(["foreign", "channel collision", "shared Gateway owner"] as const)(
    "rejects %s targets before provider dispatch",
    async (kind) => {
      const collision = kind === "channel collision";
      const gatewayOwner = kind === "shared Gateway owner";
      const caller = gatewayOwner ? GATEWAY_OWNER_PROFILE_ID : "profile-owner";
      hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(!collision);
      sessionEntries = [
        {
          sessionKey: "agent:main:target",
          entry: {
            createdActor: {
              type: "human",
              source: collision ? "channel" : "profile",
              id: kind === "foreign" ? "profile-other" : caller,
            },
            ...(collision ? { visibility: "draft" as const } : {}),
          },
        },
      ];
      const catalog = gatewayOwner
        ? { read: vi.fn(async () => page("target", "private host history")) }
        : mutationProvider("target");
      install(catalog, [session("target", "agent:main:target")]);
      const cfg = collision ? roleConfig("none") : {};
      if (collision) {
        for (let pass = 0; pass < 2; pass++) {
          const listed = await call("sessions.catalog.list", {}, client(caller), cfg);
          expect(listed.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([]);
        }
      }
      const operations = gatewayOwner
        ? mutations.slice(0, 1)
        : collision
          ? mutations.filter(([method]) => method !== "sessions.catalog.import")
          : mutations;
      for (const [method, extra] of operations) {
        const result = await call(method, locator("target", extra), client(caller), cfg);
        expectForbidden(
          result,
          collision ? undefined : "session catalog thread is not visible to this caller",
        );
      }
      expectNoDispatch(catalog);
    },
  );

  it("shares only Gateway-hosted catalog rows with authenticated operators", async () => {
    hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
    const sharedRead = vi.fn(async () => page("shared-snapshot", "sanitized snapshot"));
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider({
          id: "beam",
          label: "Beam",
          audience: "gateway-operators",
          list: vi.fn(async () => [host([session("shared-snapshot")])]),
          read: sharedRead,
        }),
      },
      {
        provider: provider({
          id: "codex",
          list: vi.fn(async () => [host([session("private-native")])]),
        }),
      },
    ];
    const operator = unprofiledClient(["operator.read"]);

    const listed = await call("sessions.catalog.list", {}, operator);
    const transcript = await call(
      "sessions.catalog.read",
      { catalogId: "beam", hostId: "gateway:local", threadId: "shared-snapshot" },
      operator,
    );

    expect(listed.mock.calls[0]?.[1]?.catalogs).toEqual([
      expect.objectContaining({
        id: "beam",
        hosts: [expect.objectContaining({ sessions: [session("shared-snapshot")] })],
      }),
      expect.objectContaining({
        id: "codex",
        hosts: [expect.objectContaining({ sessions: [] })],
      }),
    ]);
    expect(transcript).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ threadId: "shared-snapshot" }),
    );
    expect(sharedRead).toHaveBeenCalledOnce();
  });

  it("keeps solo Gateway list and read responses unfiltered", async () => {
    const listedHost = host([session("unadopted-thread")]);
    const readResult = page("unadopted-thread", "host history");
    install({
      list: vi.fn(async () => [listedHost]),
      read: vi.fn(async () => readResult),
    });
    const requestClient = client("profile-owner", ["operator.read"]);

    const listed = await call("sessions.catalog.list", {}, requestClient);
    const transcript = await call(
      "sessions.catalog.read",
      locator("unadopted-thread"),
      requestClient,
    );

    expectCatalog(listed, listedHost);
    expect(transcript).toHaveBeenCalledWith(true, readResult);
  });

  it("shares concurrent catalog enumeration when only owner attribution arrives", async () => {
    const listedHost = host([session("unadopted-thread")]);
    const release = createDeferredCore();
    const list = vi.fn(async () => {
      await release.promise;
      return [listedHost];
    });
    install({ list });
    const requestClient = unprofiledClient();
    const config = {};

    const before = call("sessions.catalog.list", {}, requestClient, config);
    requestClient.authenticatedUserProfile = { profileId: GATEWAY_OWNER_PROFILE_ID };
    const after = call("sessions.catalog.list", {}, requestClient, config);
    release.resolve();

    for (const respond of await Promise.all([before, after])) {
      expectCatalog(respond, listedHost);
    }
    expect(list).toHaveBeenCalledOnce();
  });

  it("pages before authorizing an older owner thread", async () => {
    hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
    setActors([
      ["agent:main:other", "profile-other"],
      ["agent:main:owned", "profile-owner"],
    ]);
    const list = vi.fn(async ({ cursors }: { cursors?: Record<string, string> }) => [
      cursors
        ? host([session("owned-thread", "agent:main:owned")])
        : host([session("other-thread", "agent:main:other")], "page-2"),
    ]);
    const readResult = page("owned-thread");
    install({ list: list as never, read: vi.fn(async () => readResult) });

    const transcript = await call(
      "sessions.catalog.read",
      locator("owned-thread"),
      client("profile-owner"),
    );

    expect(transcript).toHaveBeenCalledWith(true, readResult);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursors: { "gateway:local": "page-2" } }),
    );
  });

  it("keeps a none role owner-only with a single identity", async () => {
    setActors([
      ["agent:main:owned", "profile-owner"],
      ["agent:main:other", "profile-other"],
    ]);
    const read = vi.fn(async () => page("other-thread"));
    install({ read }, [
      session("owned-thread", "agent:main:owned"),
      session("other-thread", "agent:main:other"),
    ]);
    const config = roleConfig("none");

    const listed = await call("sessions.catalog.list", {}, client("profile-owner"), config);
    const foreign = await call(
      "sessions.catalog.read",
      locator("other-thread"),
      client("profile-owner"),
      config,
    );

    expect(listed.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([
      expect.objectContaining({ threadId: "owned-thread" }),
    ]);
    expectForbidden(foreign);
    expect(read).not.toHaveBeenCalled();
  });

  it("blocks foreign catalog continue and archive for view roles without explicit membership", async () => {
    setActors([["agent:main:other", "profile-other"]]);
    const catalog = mutationProvider("other");
    install(catalog, [session("other-thread", "agent:main:other")]);
    const config = roleConfig("view");

    for (const [method, extra] of mutations.slice(2)) {
      const respond = await call(
        method,
        locator("other-thread", extra),
        client("profile-owner"),
        config,
      );
      expectForbidden(respond);
    }
    expectNoDispatch(catalog);
  });

  it("permits a view-capped person to archive a foreign session after explicit membership", async () => {
    setActors([["agent:main:other", "profile-other"]]);
    hoisted.resolveSessionSharingTargetAsync.mockResolvedValue({
      agentId: "main",
      canonicalKey: "agent:main:other",
      storeKey: "agent:main:other",
      storeKeys: ["agent:main:other"],
      storePath: "",
      entry: {
        sessionId: "agent:main:other",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: "profile-other" },
      },
    });
    hoisted.resolveSessionSharingRole.mockImplementation(
      (await import("../session-sharing-policy.js")).resolveSessionSharingRole,
    );
    const archive = vi.fn(async () => ({ ok: true as const }));
    install({
      list: vi.fn(async () => {
        const projection = [...projections].at(-1)!;
        projection.describe({ agentId: "main", key: "agent:main:other" })!.membership = new Set([
          "profile-owner",
        ]);
        return [host([session("other-thread", "agent:main:other")])];
      }),
      archive,
    });

    const respond = await call(
      "sessions.catalog.archive",
      locator("other-thread", { confirmNoOtherRunner: true }),
      client("profile-owner"),
      roleConfig("view"),
    );

    expect(archive).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("rejects catalog adoption before the provider creates a disallowed agent session", async () => {
    setActors([["agent:main:owned", "profile-owner"]]);
    const continueSession = vi.fn(async () => ({ sessionKey: "agent:main:owned" }));
    install({ continueSession }, [session("owned-thread", "agent:main:owned")]);

    const respond = await call(
      "sessions.catalog.continue",
      locator("owned-thread"),
      client("profile-owner"),
      roleConfig("write", ["research"]),
    );

    expect(continueSession).not.toHaveBeenCalled();
    expectForbidden(respond, expect.stringContaining('cannot create sessions for agent "main"'));
  });

  it("keeps operator.admin unrestricted despite a configured none role", async () => {
    hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
    const listedHost = host([session("unadopted-thread")]);
    install({ list: vi.fn(async () => [listedHost]) });

    const listed = await call(
      "sessions.catalog.list",
      {},
      client("profile-owner", ["operator.admin"]),
      roleConfig("none"),
    );

    expectCatalog(listed, listedHost);
  });
});
