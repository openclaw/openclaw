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
    id: name,
    name,
    repoFingerprint: name,
    repoRoot: `/repos/${name}`,
    path: `/worktrees/${name}`,
    branch: `openclaw/${name}`,
    baseRef: "main",
    ownerKind: "session",
    ownerId,
    createdAt: 100,
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

function assertObservedProjectsPayload(
  payload: unknown,
): asserts payload is { observedProjects: unknown[] } {
  if (!isRecord(payload) || !Array.isArray(payload.observedProjects)) {
    throw new TypeError("projects.list response is missing observedProjects");
  }
}

type IdentityResolver = (checkoutPath: string) => Promise<{
  checkoutRoot: string;
  repoRoot: string;
  originUrl: string;
  fingerprint: string;
}>;

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
  const projection = createSessionRowProjectionFixture({
    cfg,
    store: {},
    modelCatalog: [],
  });
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
  const response = responses[0];
  if (!response) {
    throw new Error("projects.list did not respond");
  }
  expect(response[0]).toBe(true);
  assertObservedProjectsPayload(response[1]);
  return response[1].observedProjects;
}

beforeEach(() => {
  seededSessions.store = {};
});

describe("projects.list observed projects", () => {
  it("deduplicates admitted paths and preserves result order when a checkout is unavailable", async () => {
    seededSessions.store = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, index) => [
        `agent:main:session-${index}`,
        { sessionId: `session-${index}`, updatedAt: index, execCwd: `/repos/${index % 8}` },
      ]),
    );
    const resolveRepositoryIdentity = vi.fn(async (checkoutPath: string) => {
      if (checkoutPath === "/repos/3") {
        throw new Error("checkout unavailable");
      }
      return {
        checkoutRoot: checkoutPath.replace("/repos/", "/physical/"),
        repoRoot: "/physical/main",
        originUrl: "https://example.test/project.git",
        fingerprint: "project",
      };
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

  it.each([["operator.write"]])(
    "returns detailed observed projects to %s callers",
    async (scope) => {
      seededSessions.store = Object.fromEntries([
        session("old", 100, { execCwd: "/links/alpha-old" }),
        session("new", 300, { execCwd: "/links/alpha-new" }),
        session("device", 400, { execCwd: "/device/alpha", execNode: "paired-mac" }),
      ]);
      const resolveRepositoryIdentity = vi.fn(async (checkoutPath: string) => ({
        checkoutRoot: checkoutPath.replace("/links/", "/physical/"),
        repoRoot: "/physical/alpha",
        originUrl: "https://github.com/openclaw/alpha.git",
        fingerprint: "alpha-fingerprint",
      }));

      await expect(
        listObservedProjects(resolveRepositoryIdentity, {
          client: authenticatedClient(`${scope}@example.com`, [scope]),
        }),
      ).resolves.toEqual([
        {
          name: "alpha-new",
          originUrl: "https://github.com/openclaw/alpha.git",
          checkouts: [
            { runnerId: "gateway", path: "/physical/alpha-new" },
            { runnerId: "gateway", path: "/physical/alpha-old" },
          ],
          lastUsedAt: 300,
        },
      ]);
      expect(resolveRepositoryIdentity).not.toHaveBeenCalledWith("/device/alpha");
    },
  );

  it("admits managed worktrees only when their owning session is visible", async () => {
    const createdActor = { type: "human", source: "profile", id: "owner@example.com" } as const;
    seededSessions.store = Object.fromEntries([
      session("visible", 200, {
        visibility: "shared",
        createdActor,
      }),
      session("private", 300, {
        visibility: "draft",
        createdActor,
      }),
    ]);
    const worktrees = [
      worktree("visible", "agent:main:visible", 500),
      worktree("private", "agent:main:private", 490),
      worktree("orphan", "agent:main:missing", 480),
      {
        ...worktree("manual", "ignored", 470),
        ownerKind: "manual",
        ownerId: undefined,
      },
    ];
    const resolveRepositoryIdentity = vi.fn(async (checkoutPath: string) => ({
      checkoutRoot: checkoutPath,
      repoRoot: checkoutPath,
      originUrl: `https://example.test${checkoutPath}.git`,
      fingerprint: checkoutPath,
    }));

    const viewer = (await listObservedProjects(resolveRepositoryIdentity, {
      worktrees,
      client: authenticatedClient("viewer@example.com"),
    })) as Array<{ name: string }>;
    expect(viewer.map((project) => project.name)).toEqual(["visible"]);

    const admin = (await listObservedProjects(resolveRepositoryIdentity, {
      worktrees,
      client: authenticatedClient("admin@example.com", ["operator.admin"]),
    })) as Array<{ name: string }>;
    expect(admin.map((project) => project.name)).toEqual([
      "visible",
      "private",
      "orphan",
      "manual",
    ]);
  });

  it("redacts URL and SCP-style userinfo and omits unknown remote forms", async () => {
    seededSessions.store = Object.fromEntries(
      ["url", "token-scp", "git-scp", "unknown"].map((name, index) => [
        `agent:main:${name}`,
        { sessionId: name, updatedAt: 400 - index, execCwd: `/repos/${name}` },
      ]),
    );
    const origins: Record<string, string> = {
      "/repos/url": ["https://user", ":placeholder", "@host/repo.git?visible=value#branch"].join(
        "",
      ),
      "/repos/token-scp": ["placeholder", "@host:org/private.git"].join(""),
      "/repos/git-scp": "git@host:org/public.git",
      "/repos/unknown": "opaque credential-shaped remote",
    };

    const projects = (await listObservedProjects(async (checkoutPath) => ({
      checkoutRoot: checkoutPath,
      repoRoot: checkoutPath,
      originUrl: origins[checkoutPath] ?? "",
      fingerprint: checkoutPath,
    }))) as Array<{ name: string; originUrl?: string }>;

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
        ownerKind: "manual",
        createdAt: 1,
      }),
    );

    const projects = (await listObservedProjects(
      async (checkoutPath) => ({
        checkoutRoot: checkoutPath,
        repoRoot: checkoutPath,
        originUrl: "https://github.com/openclaw/alpha.git",
        fingerprint: "alpha-fingerprint",
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
    seededSessions.store = Object.fromEntries(
      Array.from({ length: rawCandidateLimit + 5 }, (_, index) => [
        `agent:main:session-${index}`,
        { sessionId: `session-${index}`, updatedAt: index, execCwd: `/repos/${index}` },
      ]),
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
