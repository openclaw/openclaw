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
    sessionEntries = [];
    hoisted.resolveSessionSharingRole.mockReset().mockReturnValue("viewer");
    hoisted.resolveSessionSharingTargetAsync.mockReset().mockResolvedValue(null);
  });

  it("rejects hidden targets before read, import, continue, or archive dispatch", async () => {
    hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
    setActors([["agent:main:other", "profile-other"]]);
    const list = vi.fn(async () => [host([session("other-thread", "agent:main:other")])]);
    const read = vi.fn(async () => ({
      hostId: "gateway:local",
      threadId: "other-thread",
      items: [],
    }));
    const continueSession = vi.fn(async () => ({ sessionKey: "agent:main:other" }));
    const archive = vi.fn(async () => ({ ok: true as const }));
    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider({ list, read, continueSession, archive }) },
    ];

    for (const [method, params] of [
      ["sessions.catalog.read", {}],
      ["sessions.catalog.import", {}],
      ["sessions.catalog.continue", {}],
      ["sessions.catalog.archive", { confirmNoOtherRunner: true }],
    ] as const) {
      const respond = await call(
        method,
        { catalogId: "codex", hostId: "gateway:local", threadId: "other-thread", ...params },
        client("profile-owner"),
      );
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.FORBIDDEN,
          message: "session catalog thread is not visible to this caller",
        }),
      );
    }
    expect(read).not.toHaveBeenCalled();
    expect(continueSession).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
  });

  it.each(["channel"] as const)(
    "denies colliding %s creators across catalog operations",
    async (source) => {
      sessionEntries = [
        {
          sessionKey: "agent:main:collision",
          entry: {
            createdActor: { type: "human", source, id: "profile-owner" },
            visibility: "draft",
          },
        },
      ];
      const read = vi.fn(async () => ({
        hostId: "gateway:local",
        threadId: "collision",
        items: [],
      }));
      const continueSession = vi.fn(async () => ({ sessionKey: "agent:main:collision" }));
      const archive = vi.fn(async () => ({ ok: true as const }));
      hoisted.activeRegistry.sessionCatalogs = [
        {
          provider: provider({
            list: vi.fn(async () => [host([session("collision", "agent:main:collision")])]),
            read,
            continueSession,
            archive,
          }),
        },
      ];
      const cfg = roleConfig("none");
      for (let pass = 0; pass < 2; pass++) {
        const listed = await call("sessions.catalog.list", {}, client("profile-owner"), cfg);
        expect(listed.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([]);
      }
      for (const method of [
        "sessions.catalog.read",
        "sessions.catalog.continue",
        "sessions.catalog.archive",
      ] as const) {
        const result = await call(
          method,
          {
            catalogId: "codex",
            hostId: "gateway:local",
            threadId: "collision",
            ...(method === "sessions.catalog.archive" ? { confirmNoOtherRunner: true } : {}),
          },
          client("profile-owner"),
          cfg,
        );
        expect(result).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
        );
      }
      expect(read).not.toHaveBeenCalled();
      expect(continueSession).not.toHaveBeenCalled();
      expect(archive).not.toHaveBeenCalled();
    },
  );

  it.each(["shared owner"])("rejects reads for a %s multi-identity caller", async (identity) => {
    hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
    setActors([["agent:main:owner", GATEWAY_OWNER_PROFILE_ID]]);
    const read = vi.fn(async () => ({
      hostId: "gateway:local",
      threadId: "owner-thread",
      items: [{ type: "userMessage" as const, text: "private host history" }],
    }));
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider({
          list: vi.fn(async () => [host([session("owner-thread", "agent:main:owner")])]),
          read,
        }),
      },
    ];

    const transcript = await call(
      "sessions.catalog.read",
      { catalogId: "codex", hostId: "gateway:local", threadId: "owner-thread" },
      identity === "shared owner" ? client(GATEWAY_OWNER_PROFILE_ID) : unprofiledClient(),
    );

    expect(transcript).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.FORBIDDEN,
        message: "session catalog thread is not visible to this caller",
      }),
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("shares only Gateway-hosted catalog rows with authenticated operators", async () => {
    hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
    const sharedRead = vi.fn(async () => ({
      hostId: "gateway:local",
      threadId: "shared-snapshot",
      items: [{ type: "userMessage" as const, text: "sanitized snapshot" }],
    }));
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

  it.each([
    {
      label: "solo Gateway",
      multiple: false,
      scopes: ["operator.read"],
      profileId: "profile-owner",
    },
  ])("keeps $label list and read responses unfiltered", async ({ multiple, scopes, profileId }) => {
    hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(multiple);
    const listedHost = host([session("unadopted-thread")]);
    const readResult = {
      hostId: "gateway:local",
      threadId: "unadopted-thread",
      items: [{ type: "userMessage" as const, text: "host history" }],
    };
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider({
          list: vi.fn(async () => [listedHost]),
          read: vi.fn(async () => readResult),
        }),
      },
    ];
    const requestClient = client(profileId, scopes);

    const listed = await call("sessions.catalog.list", {}, requestClient);
    const transcript = await call(
      "sessions.catalog.read",
      { catalogId: "codex", hostId: "gateway:local", threadId: "unadopted-thread" },
      requestClient,
    );

    expect(listed).toHaveBeenCalledWith(true, {
      catalogs: [expect.objectContaining({ hosts: [listedHost] })],
    });
    expect(transcript).toHaveBeenCalledWith(true, readResult);
  });

  it("shares concurrent catalog enumeration when only owner attribution arrives", async () => {
    const listedHost = host([session("unadopted-thread")]);
    const release = createDeferredCore();
    const list = vi.fn(async () => {
      await release.promise;
      return [listedHost];
    });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider({ list }) }];
    const requestClient = unprofiledClient();
    const config = {};

    const before = call("sessions.catalog.list", {}, requestClient, config);
    requestClient.authenticatedUserProfile = { profileId: GATEWAY_OWNER_PROFILE_ID };
    const after = call("sessions.catalog.list", {}, requestClient, config);
    release.resolve();

    for (const respond of await Promise.all([before, after])) {
      expect(respond).toHaveBeenCalledWith(true, {
        catalogs: [expect.objectContaining({ hosts: [listedHost] })],
      });
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
    const readResult = { hostId: "gateway:local", threadId: "owned-thread", items: [] };
    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider({ list: list as never, read: vi.fn(async () => readResult) }) },
    ];

    const transcript = await call(
      "sessions.catalog.read",
      { catalogId: "codex", hostId: "gateway:local", threadId: "owned-thread" },
      client("profile-owner"),
    );

    expect(transcript).toHaveBeenCalledWith(true, readResult);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursors: { "gateway:local": "page-2" } }),
    );
  });

  it.each([false])(
    "keeps a none role owner-only with multiple identities = %s",
    async (multiple) => {
      hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(multiple);
      setActors([
        ["agent:main:owned", "profile-owner"],
        ["agent:main:other", "profile-other"],
      ]);
      const list = vi.fn(async () => [
        host([
          session("owned-thread", "agent:main:owned"),
          session("other-thread", "agent:main:other"),
        ]),
      ]);
      const read = vi.fn(async () => ({
        hostId: "gateway:local",
        threadId: "other-thread",
        items: [],
      }));
      hoisted.activeRegistry.sessionCatalogs = [{ provider: provider({ list, read }) }];
      const config = roleConfig("none");

      const listed = await call("sessions.catalog.list", {}, client("profile-owner"), config);
      const foreign = await call(
        "sessions.catalog.read",
        { catalogId: "codex", hostId: "gateway:local", threadId: "other-thread" },
        client("profile-owner"),
        config,
      );

      expect(listed.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([
        expect.objectContaining({ threadId: "owned-thread" }),
      ]);
      expect(foreign).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
      );
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each(["view"] as const)(
    "blocks foreign catalog continue and archive for %s roles without explicit membership",
    async (others) => {
      setActors([["agent:main:other", "profile-other"]]);
      const continueSession = vi.fn(async () => ({ sessionKey: "agent:main:other" }));
      const archive = vi.fn(async () => ({ ok: true as const }));
      hoisted.activeRegistry.sessionCatalogs = [
        {
          provider: provider({
            list: vi.fn(async () => [host([session("other-thread", "agent:main:other")])]),
            continueSession,
            archive,
          }),
        },
      ];
      const config = roleConfig(others);

      for (const [method, extra] of [
        ["sessions.catalog.continue", {}],
        ["sessions.catalog.archive", { confirmNoOtherRunner: true }],
      ] as const) {
        const respond = await call(
          method,
          { catalogId: "codex", hostId: "gateway:local", threadId: "other-thread", ...extra },
          client("profile-owner"),
          config,
        );
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
        );
      }
      expect(continueSession).not.toHaveBeenCalled();
      expect(archive).not.toHaveBeenCalled();
    },
  );

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
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider({
          list: vi.fn(async () => {
            const projection = [...projections].at(-1)!;
            projection.describe({ agentId: "main", key: "agent:main:other" })!.membership = new Set(
              ["profile-owner"],
            );
            return [host([session("other-thread", "agent:main:other")])];
          }),
          archive,
        }),
      },
    ];

    const respond = await call(
      "sessions.catalog.archive",
      {
        catalogId: "codex",
        hostId: "gateway:local",
        threadId: "other-thread",
        confirmNoOtherRunner: true,
      },
      client("profile-owner"),
      roleConfig("view"),
    );

    expect(archive).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("rejects catalog adoption before the provider creates a disallowed agent session", async () => {
    setActors([["agent:main:owned", "profile-owner"]]);
    const continueSession = vi.fn(async () => ({ sessionKey: "agent:main:owned" }));
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider({
          list: vi.fn(async () => [host([session("owned-thread", "agent:main:owned")])]),
          continueSession,
        }),
      },
    ];

    const respond = await call(
      "sessions.catalog.continue",
      { catalogId: "codex", hostId: "gateway:local", threadId: "owned-thread" },
      client("profile-owner"),
      roleConfig("write", ["research"]),
    );

    expect(continueSession).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.FORBIDDEN,
        message: expect.stringContaining('cannot create sessions for agent "main"'),
      }),
    );
  });

  it("keeps operator.admin unrestricted despite a configured none role", async () => {
    hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
    const listedHost = host([session("unadopted-thread")]);
    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider({ list: vi.fn(async () => [listedHost]) }) },
    ];

    const listed = await call(
      "sessions.catalog.list",
      {},
      client("profile-owner", ["operator.admin"]),
      roleConfig("none"),
    );

    expect(listed).toHaveBeenCalledWith(true, {
      catalogs: [expect.objectContaining({ hosts: [listedHost] })],
    });
  });
});
