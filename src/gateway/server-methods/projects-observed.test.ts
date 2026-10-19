import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT,
  PROJECTS_LIST_MAX_IDENTITY_PROBES,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import { createProjectsHandlers } from "./projects.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const seededSessions = vi.hoisted(() => ({
  store: {} as Record<string, SessionEntry>,
}));

function session(name: string, updatedAt: number, fields: Partial<SessionEntry>) {
  return [`agent:main:${name}`, { sessionId: name, updatedAt, ...fields }] as const;
}

function worktree(name: string, ownerId: string | undefined, lastActiveAt: number) {
  return {
    repoFingerprint: name,
    repoRoot: `/repos/${name}`,
    path: `/worktrees/${name}`,
    ownerKind: ownerId ? "session" : "manual",
    ownerId,
    lastActiveAt,
  };
}

// mock-isolation: Supply observed session rows without opening real session stores.
vi.mock("./projects-session-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./projects-session-store.js")>()),
  loadProjectSessionStore: () => ({
    store: seededSessions.store,
    agentId: () => undefined,
    assertCurrent() {},
  }),
}));

vi.mock("../../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-profile-list.js")>()),
  readResidentUserProfileAliases: (profileId: string) => new Set([profileId]),
}));

vi.mock("../../projects/project-registry.js", () => ({
  listProjectRegistry: async () => [],
  ProjectCheckoutError: class ProjectCheckoutError extends Error {},
  registerProjectRegistry: vi.fn(),
  removeProjectRegistry: vi.fn(),
}));

function authenticatedClient(user: string, scopes = ["operator.write"]): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes,
    },
    authenticatedUserId: user,
    authenticatedUserProfile: {
      profileId: user,
      displayName: user,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

type IdentityResolver = (checkoutPath: string) => Promise<{
  checkoutRoot: string;
  repoRoot: string;
  originUrl: string;
  fingerprint: string;
}>;

function identity(
  checkoutPath: string,
  overrides: Partial<Awaited<ReturnType<IdentityResolver>>> = {},
) {
  return {
    checkoutRoot: checkoutPath,
    repoRoot: checkoutPath,
    originUrl: `https://example.test${checkoutPath}.git`,
    fingerprint: checkoutPath,
    ...overrides,
  };
}

function seedSessions(entries: ReturnType<typeof session>[]) {
  seededSessions.store = Object.fromEntries(entries);
}

async function listObservedProjects(
  resolveRepositoryIdentity: IdentityResolver,
  {
    worktrees = [],
    client = authenticatedClient("operator@example.com"),
  }: { worktrees?: unknown[]; client?: GatewayClient } = {},
) {
  const handlers = createProjectsHandlers({
    listRegistryRecords: async () => worktrees,
    resolveRepositoryIdentities: (roots: string[]) =>
      Promise.all(roots.map((root) => resolveRepositoryIdentity(root).catch(() => undefined))),
  } as never);
  const responses: Parameters<RespondFn>[] = [];
  const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
  const projection = createSessionRowProjectionFixture({ cfg, store: {}, modelCatalog: [] });
  try {
    await handlers["projects.list"]?.({
      params: { includeObserved: true },
      respond: (...response: Parameters<RespondFn>) => responses.push(response),
      context: bindSessionRowProjection(
        { getRuntimeConfig: () => cfg },
        () => projection,
      ) as GatewayRequestContext,
      client,
    } as never);
  } finally {
    projection.dispose();
  }
  expect(responses).toHaveLength(1);
  const [ok, payload] = responses[0]!;
  expect(ok).toBe(true);
  if (!isRecord(payload) || !Array.isArray(payload.observedProjects)) {
    throw new TypeError("projects.list response is missing observedProjects");
  }
  return payload.observedProjects;
}

beforeEach(() => {
  seededSessions.store = {};
});

describe("projects.list observed projects", () => {
  it("deduplicates admitted paths and preserves result order when a checkout is unavailable", async () => {
    seedSessions(
      Array.from({ length: 5_000 }, (_, index) =>
        session(`session-${index}`, index, { execCwd: `/repos/${index % 8}` }),
      ),
    );
    const resolveRepositoryIdentity = vi.fn(async (checkoutPath: string) => {
      if (checkoutPath === "/repos/3") {
        throw new Error("checkout unavailable");
      }
      return identity(checkoutPath, {
        checkoutRoot: checkoutPath.replace("/repos/", "/physical/"),
        repoRoot: "/physical/main",
        originUrl: "https://example.test/project.git",
        fingerprint: "project",
      });
    });

    await expect(listObservedProjects(resolveRepositoryIdentity)).resolves.toEqual([
      {
        name: "7",
        originUrl: "https://example.test/project.git",
        lastUsedAt: 4_999,
        checkouts: [7, 6, 5, 4, 2, 1, 0].map((index) => ({
          runnerId: "gateway",
          path: `/physical/${index}`,
        })),
      },
    ]);
    expect(resolveRepositoryIdentity).toHaveBeenCalledTimes(8);
    expect(new Set(resolveRepositoryIdentity.mock.calls.map(([checkout]) => checkout)).size).toBe(
      8,
    );
  });

  it("excludes device-owned checkouts before identity resolution", async () => {
    seedSessions([session("device", 400, { execCwd: "/device/alpha", execNode: "paired-mac" })]);
    const resolveRepositoryIdentity = vi.fn(async (checkoutPath: string) => identity(checkoutPath));
    await expect(listObservedProjects(resolveRepositoryIdentity)).resolves.toEqual([]);
    expect(resolveRepositoryIdentity).not.toHaveBeenCalled();
  });

  it.each<[string, string[], string[]]>([
    ["viewer", ["operator.write"], ["visible"]],
    ["admin", ["operator.admin"], ["visible", "private", "orphan", "manual"]],
  ])("admits managed worktrees visible to %s", async (user, scopes, names) => {
    const createdActor = { type: "human", source: "profile", id: "owner@example.com" } as const;
    seedSessions([
      session("visible", 200, { visibility: "shared", createdActor }),
      session("private", 300, { visibility: "draft", createdActor }),
    ]);
    const worktrees = [
      worktree("visible", "agent:main:visible", 500),
      worktree("private", "agent:main:private", 490),
      worktree("orphan", "agent:main:missing", 480),
      worktree("manual", undefined, 470),
    ];
    await expect(
      listObservedProjects(async (checkoutPath) => identity(checkoutPath), {
        worktrees,
        client: authenticatedClient(`${user}@example.com`, scopes),
      }),
    ).resolves.toMatchObject(names.map((name) => ({ name })));
  });

  it("redacts URL and SCP-style userinfo and omits unknown remote forms", async () => {
    seedSessions(
      ["url", "token-scp", "git-scp", "unknown"].map((name, index) =>
        session(name, 400 - index, { execCwd: `/repos/${name}` }),
      ),
    );
    const origins: Record<string, string> = {
      "/repos/url": ["https://user", ":placeholder", "@host/repo.git?visible=value#branch"].join(
        "",
      ),
      "/repos/token-scp": ["placeholder", "@host:org/private.git"].join(""),
      "/repos/git-scp": "git@host:org/public.git",
      "/repos/unknown": "opaque credential-shaped remote",
    };

    const projects = (await listObservedProjects(async (checkoutPath) =>
      identity(checkoutPath, { originUrl: origins[checkoutPath] ?? "" }),
    )) as Array<{ name: string; originUrl?: string }>;

    expect(projects.map(({ name, originUrl }) => ({ name, originUrl }))).toEqual([
      { name: "url", originUrl: "https://host/repo.git" },
      { name: "token-scp", originUrl: "host:org/private.git" },
      { name: "git-scp", originUrl: "host:org/public.git" },
      { name: "unknown", originUrl: undefined },
    ]);
  });

  it("caps checkout arrays in deterministic newest-first order", async () => {
    const worktrees = Array.from(
      { length: PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT + 3 },
      (_, index) => ({
        ...worktree(`worktree-${index}`, undefined, index),
        repoFingerprint: "alpha-fingerprint",
        repoRoot: "/repos/alpha",
        path: `/worktrees/${String(index).padStart(2, "0")}`,
      }),
    );

    const projects = (await listObservedProjects(
      async (checkoutPath) =>
        identity(checkoutPath, {
          originUrl: "https://github.com/openclaw/alpha.git",
        }),
      { worktrees, client: authenticatedClient("admin@example.com", ["operator.admin"]) },
    )) as Array<{ checkouts: Array<{ path: string }> }>;

    expect(projects[0]?.checkouts).toHaveLength(PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT);
    expect(projects[0]?.checkouts[0]?.path).toBe("/worktrees/52");
    expect(projects[0]?.checkouts.at(-1)?.path).toBe("/worktrees/03");
  });

  it("retains only the newest bounded candidates before identity resolution", async () => {
    const rawCandidateLimit = Math.max(
      PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT,
      PROJECTS_LIST_MAX_IDENTITY_PROBES,
      50,
    );
    seedSessions(
      Array.from({ length: rawCandidateLimit + 5 }, (_, index) =>
        session(`session-${index}`, index, { execCwd: `/repos/${index}` }),
      ),
    );
    const resolveRepositoryIdentity = vi.fn<IdentityResolver>(async (_checkoutPath) => {
      throw new Error("checkout unavailable");
    });

    await expect(listObservedProjects(resolveRepositoryIdentity)).resolves.toEqual([]);
    expect(resolveRepositoryIdentity).toHaveBeenCalledTimes(PROJECTS_LIST_MAX_IDENTITY_PROBES);
    expect(resolveRepositoryIdentity.mock.calls.length).toBeLessThanOrEqual(rawCandidateLimit);
    expect(resolveRepositoryIdentity).toHaveBeenCalledWith(`/repos/${rawCandidateLimit + 4}`);
    expect(resolveRepositoryIdentity).not.toHaveBeenCalledWith("/repos/0");
  });
});
