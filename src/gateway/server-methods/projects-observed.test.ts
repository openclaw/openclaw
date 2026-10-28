import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT,
  PROJECTS_LIST_MAX_IDENTITY_PROBES,
} from "../../../packages/gateway-protocol/src/index.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { makeWorktreeRecord } from "../../agents/worktrees/service.test-support.js";
import type { ManagedWorktreeRecord } from "../../agents/worktrees/types.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withRestoredMocks } from "../../test-utils/vitest-spies.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import { listObservedProjects as discoverProjects } from "./projects-observed.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

let store: Record<string, SessionEntry> = {};

function session(name: string, updatedAt: number, fields: Partial<SessionEntry>) {
  return [`agent:main:${name}`, { sessionId: name, updatedAt, ...fields }] as const;
}

function worktree(
  name: string,
  ownerId: string | undefined,
  lastActiveAt: number,
): ManagedWorktreeRecord {
  return makeWorktreeRecord(`/repos/${name}`, name, {
    repoFingerprint: name,
    path: `/worktrees/${name}`,
    ownerKind: ownerId ? "session" : "manual",
    ownerId,
    lastActiveAt,
  });
}

vi.mock("../../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-profile-list.js")>()),
  readResidentUserProfileAliases: (profileId: string) => new Set([profileId]),
}));

function authenticatedClient(user: string, scopes = ["operator.write"]): GatewayClient {
  return {
    connect: gatewayConnect(scopes),
    authenticatedUserId: user,
    authenticatedUserProfile: gatewayProfile(user, user),
  };
}

type IdentityResolver = typeof managedWorktrees.resolveRepositoryIdentity;

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
  store = Object.fromEntries(entries);
}

async function listObservedProjects(
  resolveRepositoryIdentity: IdentityResolver,
  {
    worktrees = [],
    client = authenticatedClient("operator@example.com"),
  }: { worktrees?: ManagedWorktreeRecord[]; client?: GatewayClient } = {},
) {
  const registry = vi.spyOn(managedWorktrees, "listRegistryRecords").mockResolvedValue(worktrees);
  const identities = vi
    .spyOn(managedWorktrees, "resolveRepositoryIdentities")
    .mockImplementation((roots) =>
      Promise.all(roots.map((root) => resolveRepositoryIdentity(root).catch(() => undefined))),
    );
  return await withRestoredMocks([registry, identities], async () => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
    return (await discoverProjects(context, client, store)).projects;
  });
}

beforeEach(() => {
  store = {};
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
    const origins = new Map([
      ["url", ["https://user", ":placeholder", "@host/repo.git?visible=value#branch"].join("")],
      ["token-scp", ["placeholder", "@host:org/private.git"].join("")],
      ["git-scp", "git@host:org/public.git"],
      ["unknown", "opaque credential-shaped remote"],
    ]);
    seedSessions(
      [...origins.keys()].map((name, index) =>
        session(name, 400 - index, { execCwd: `/repos/${name}` }),
      ),
    );

    const projects = await listObservedProjects(async (checkoutPath) =>
      identity(checkoutPath, {
        originUrl: origins.get(checkoutPath.slice("/repos/".length)) ?? "",
      }),
    );

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

    const projects = await listObservedProjects(
      async (checkoutPath) =>
        identity(checkoutPath, { originUrl: "https://github.com/openclaw/alpha.git" }),
      { worktrees, client: authenticatedClient("admin@example.com", ["operator.admin"]) },
    );

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
