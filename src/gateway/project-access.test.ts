import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  prepareUserProfileCatalog,
  readResidentUserProfileIdentity,
} from "../state/user-profile-list.js";
import { mergeProfiles, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  canRequesterUseRepositoryUrl,
  filterProjectsForRequester,
  projectRequesterForClient,
  projectRequesterForProfile,
  type ProjectRequester,
  resolveProjectAccess,
  resolveRunProjectRequester,
} from "./project-access.js";

const cfg = {} as OpenClawConfig;
const guest: ProjectRequester = { kind: "operator", scopes: ["operator.sessions.write"] };
const contributor: ProjectRequester = {
  kind: "operator",
  scopes: ["operator.read", "operator.sessions.write"],
};
const maintainer: ProjectRequester = { kind: "operator", scopes: ["operator.write"] };

function project(name: string) {
  return {
    id: name,
    source: "registered" as const,
    originUrl: `https://github.com/project-access-test/${name}.git`,
  };
}

function visibilityFetch(visibility: Record<string, string | number>) {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const name = new URL(url).pathname.split("/").at(-1) ?? "";
    const answer = visibility[name];
    if (typeof answer === "number") {
      return Response.json({ message: "error" }, { status: answer });
    }
    return Response.json({ visibility: answer });
  });
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

describe("project access", () => {
  beforeEach(() => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    setRuntimeConfigSnapshot(cfg);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    clearRuntimeConfigSnapshot();
  });

  it("limits restricted roles to public GitHub repositories and agent workspaces", async () => {
    const fetchImpl = visibilityFetch({
      site: "public",
      openclaworg: "private",
      handbook: "internal",
      gone: 404,
    });
    const projects = [
      project("site"),
      project("openclaworg"),
      project("handbook"),
      project("gone"),
      {
        id: "port",
        source: "registered" as const,
        originUrl: "https://github.com:8443/project-access-test/site.git",
      },
      {
        id: "gitlab",
        source: "registered" as const,
        originUrl: "https://gitlab.com/openclaw/site.git",
      },
      { id: "local", source: "registered" as const },
      { id: "workspace:main", source: "workspace" as const },
    ];

    for (const requester of [guest, contributor]) {
      await expect(filterProjectsForRequester(cfg, projects, requester)).resolves.toEqual([
        project("site"),
        { id: "workspace:main", source: "workspace" },
      ]);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    fetchImpl.mockClear();
    await expect(filterProjectsForRequester(cfg, projects, maintainer)).resolves.toEqual(projects);
    await expect(
      canRequesterUseRepositoryUrl(cfg, project("openclaworg").originUrl, { kind: "internal" }),
    ).resolves.toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("adds role-granted projects to the public fallback and marks grant-only access", async () => {
    const fetchImpl = visibilityFetch({ site: "public", openclaworg: "private", handbook: 403 });
    const projects = [project("site"), project("openclaworg"), project("handbook")];
    const listed: ProjectRequester = { ...guest, projects: ["openclaworg", "stale-id"] };
    await expect(filterProjectsForRequester(cfg, projects, listed)).resolves.toEqual([
      project("site"),
      project("openclaworg"),
    ]);
    await expect(
      filterProjectsForRequester(cfg, projects, { ...guest, projects: "*" }),
    ).resolves.toEqual(projects);
    // Grants never widen repository URLs.
    await expect(
      canRequesterUseRepositoryUrl(cfg, project("openclaworg").originUrl, listed),
    ).resolves.toBe(false);

    const access = (name: string, requester: ProjectRequester) =>
      resolveProjectAccess(cfg, project(name), requester, { fresh: true });
    await expect(access("site", listed)).resolves.toBe("public");
    await expect(access("site", { ...guest, projects: "*" })).resolves.toBe("public");
    await expect(access("openclaworg", listed)).resolves.toBe("granted");
    await expect(access("openclaworg", guest)).resolves.toBeUndefined();
    // Unknown visibility never upgrades a grant to the public direct-checkout path.
    await expect(access("handbook", { ...guest, projects: "*" })).resolves.toBe("granted");
    await expect(access("openclaworg", maintainer)).resolves.toBe("full");
    await expect(
      resolveProjectAccess(cfg, { id: "workspace:main", source: "workspace" }, guest),
    ).resolves.toBe("full");
    fetchImpl.mockClear();
    await expect(filterProjectsForRequester(cfg, projects, maintainer)).resolves.toEqual(projects);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not reuse an older discovery request for a fresh source handoff", async () => {
    const started = Promise.withResolvers<void>();
    const held = Promise.withResolvers<Response>();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => {
        started.resolve();
        return held.promise;
      })
      .mockResolvedValue(Response.json({ visibility: "private" }));
    vi.stubGlobal("fetch", fetchImpl);
    const discovery = canRequesterUseRepositoryUrl(cfg, project("race").originUrl, guest);
    await started.promise;
    const handoff = canRequesterUseRepositoryUrl(cfg, project("race").originUrl, guest, {
      fresh: true,
    });
    held.resolve(Response.json({ visibility: "public" }));
    await expect(handoff).resolves.toBe(false);
    await expect(discovery).resolves.toBe(true);
  });

  it("binds background runs to the creator's live role", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("guest@example.test");
      const catalog = await prepareUserProfileCatalog();
      using _ = { [Symbol.dispose]: catalog.release };
      const roles = {
        default: "guest",
        definitions: {
          guest: {
            scopes: ["operator.sessions.write"],
            sessions: { others: "view" },
            agents: ["main"],
            projects: ["openclaworg"],
          },
        },
      };
      const roleCfg = { gateway: { roles } } as OpenClawConfig;
      expect(resolveRunProjectRequester(roleCfg, { profileId: profile.id })).toEqual({
        ...guest,
        projects: ["openclaworg"],
      });
      // Grants are read live: removing one denies the creator's next spawn.
      const revokedCfg = structuredClone(roleCfg);
      delete revokedCfg.gateway!.roles!.definitions.guest!.projects;
      expect(resolveRunProjectRequester(revokedCfg, { profileId: profile.id })).toEqual(guest);
      // The admitted operator's effective scopes (membership caps included) win over the
      // role, while its project grant follows that person's current role.
      const operatorAuthority = { profileId: profile.id, scopes: ["operator.sessions.write"] };
      expect(resolveRunProjectRequester(roleCfg, { operatorAuthority })).toEqual({
        ...guest,
        projects: ["openclaworg"],
      });
      expect(resolveRunProjectRequester(revokedCfg, { operatorAuthority })).toEqual(guest);
      expect(
        resolveRunProjectRequester(roleCfg, {
          profileId: profile.id,
          operatorAuthority: { profileId: profile.id, scopes: [] },
        }),
      ).toEqual({ kind: "operator", scopes: [], projects: ["openclaworg"] });
      // Full-access runs never consult their role.
      expect(
        resolveRunProjectRequester(roleCfg, {
          operatorAuthority: { profileId: profile.id, scopes: ["operator.write"] },
        }),
      ).toEqual(maintainer);
      // Owner, cron and unlinked runs carry no role and stay Gateway-internal.
      expect(resolveRunProjectRequester(roleCfg, {})).toEqual({ kind: "internal" });
      expect(resolveRunProjectRequester(cfg, { profileId: profile.id })).toEqual({
        kind: "internal",
      });
    });
  });

  it("keeps live grants on the admitted profile when it is merged into another person", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const merged = ensureProfileForEmail("merged-guest@example.test");
      const staff = ensureProfileForEmail("staff@example.test");
      setUserProfileRole(staff.id, "staff");
      const catalog = await prepareUserProfileCatalog();
      using _ = { [Symbol.dispose]: catalog.release };
      const role = {
        scopes: ["operator.sessions.write" as const],
        sessions: { others: "view" as const },
      };
      const roleCfg = {
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              guest: { ...role, agents: ["main"] },
              staff: { ...role, agents: ["main"], projects: ["staff-secret"] },
            },
          },
        },
      } as OpenClawConfig;
      const scopes = ["operator.sessions.write"];
      const staffGrant = { ...guest, projects: ["staff-secret"] };
      expect(projectRequesterForProfile(roleCfg, scopes, staff.id)).toEqual(staffGrant);
      mergeProfiles(merged.id, staff.id);
      // The merged profile now resolves to the staff role, but its admitted work keeps no grant.
      const operatorAuthority = { profileId: merged.id, scopes };
      expect(resolveRunProjectRequester(roleCfg, { operatorAuthority })).toEqual(guest);
      expect(projectRequesterForProfile(roleCfg, scopes, merged.id)).toEqual(guest);
      // Creator-fallback scopes still follow the merge; its grant does not.
      expect(resolveRunProjectRequester(roleCfg, { profileId: merged.id })).toEqual(guest);
      // A client prepared for the canonical profile keeps that profile's grant for its aliases.
      const aliasClient = {
        connect: { scopes },
        authenticatedUserProfile: { profileId: merged.id },
        preparedSessionProfile: readResidentUserProfileIdentity(staff.id),
      } as unknown as Parameters<typeof projectRequesterForClient>[0];
      expect(projectRequesterForClient(aliasClient, roleCfg)).toEqual(staffGrant);
    });
  });

  it("caches visibility by API and repository, expires answers and retries failures", async () => {
    let now = Date.now();
    using _ = vi.spyOn(Date, "now").mockImplementation(() => now);
    const visibility: Record<string, string | number> = { cached: "public", flaky: 403 };
    const fetchImpl = visibilityFetch(visibility);
    const check = (name = "cached", fresh = false) =>
      canRequesterUseRepositoryUrl(cfg, project(name).originUrl, guest, { fresh });

    await expect(check()).resolves.toBe(true);
    visibility.cached = "private";
    await expect(check()).resolves.toBe(true);
    await expect(check("cached", true)).resolves.toBe(false);
    visibility.cached = "public";
    await expect(check()).resolves.toBe(false);
    now += 10 * 60_000;
    await expect(check()).resolves.toBe(true);
    await expect(check("flaky")).resolves.toBe(false);
    visibility.flaky = "public";
    await expect(check("flaky")).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(5);

    const enterprise = {
      gateway: {
        github: { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/api/v3" },
      },
    };
    const enterpriseProject = {
      source: "registered" as const,
      originUrl: "https://ghe.example.test/project-access-test/cached.git",
    };
    visibility.cached = "internal";
    await expect(
      canRequesterUseRepositoryUrl(enterprise, enterpriseProject.originUrl, guest),
    ).resolves.toBe(false);
    expect(fetchImpl.mock.lastCall?.[0]).toBe(
      "https://ghe.example.test/api/v3/repos/project-access-test/cached",
    );
    await expect(check()).resolves.toBe(true);
  });
});
