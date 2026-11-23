import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  canRequesterUseRepositoryUrl,
  filterProjectsForRequester,
  type ProjectRequester,
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
        source: "registered" as const,
        originUrl: "https://github.com:8443/project-access-test/site.git",
      },
      { source: "registered" as const, originUrl: "https://gitlab.com/openclaw/site.git" },
      { source: "registered" as const },
      { source: "workspace" as const },
    ];

    for (const requester of [guest, contributor]) {
      await expect(filterProjectsForRequester(cfg, projects, requester)).resolves.toEqual([
        project("site"),
        { source: "workspace" },
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
          },
        },
      };
      const roleCfg = { gateway: { roles } } as OpenClawConfig;
      expect(resolveRunProjectRequester(roleCfg, { profileId: profile.id })).toMatchObject(guest);
      // The admitted operator's effective scopes (membership caps included) win over roles.
      expect(
        resolveRunProjectRequester(cfg, {
          profileId: profile.id,
          operatorScopes: ["operator.sessions.write"],
        }),
      ).toMatchObject(guest);
      expect(
        resolveRunProjectRequester(roleCfg, { profileId: profile.id, operatorScopes: [] }),
      ).toEqual({ kind: "operator", scopes: [] });
      // Owner, cron and unlinked runs carry no role and stay Gateway-internal.
      expect(resolveRunProjectRequester(roleCfg, {})).toEqual({ kind: "internal" });
      expect(resolveRunProjectRequester(cfg, { profileId: profile.id })).toEqual({
        kind: "internal",
      });
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
